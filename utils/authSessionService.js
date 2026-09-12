import crypto from "crypto";
import config from "config";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import { RefreshToken } from "../models/refreshToken.js";

/** Short-lived API access JWT (seconds). */
export const ACCESS_TOKEN_TTL_SECONDS = 30 * 60; // 30 minutes

/** Idle window for refresh; extended on each successful refresh. */
export const REFRESH_TOKEN_TTL_MS = 14 * 24 * 60 * 60 * 1000; // 14 days

/** Absolute session lifetime from original login (never extended). */
export const REFRESH_ABSOLUTE_MAX_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/** Grok Bot sessions last longer — bots run unattended. */
export const BOT_REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days idle
export const BOT_REFRESH_ABSOLUTE_MAX_MS = 90 * 24 * 60 * 60 * 1000; // 90 days cap

export const REFRESH_COOKIE_NAME = "refreshToken";
export const ACCESS_COOKIE_NAME = "authToken";

const REFRESH_COOKIE_PATH = "/api/auth";

export function hashToken(rawToken) {
  return crypto.createHash("sha256").update(String(rawToken || "")).digest("hex");
}

export function generateOpaqueToken() {
  return crypto.randomBytes(48).toString("base64url");
}

export function getAccessTokenTtlSeconds() {
  return ACCESS_TOKEN_TTL_SECONDS;
}

/**
 * Build a short-lived access JWT for a user document (or lean payload).
 */
export function signAccessToken(userLike) {
  const isBot = userLike?.actorType === "grokbot";
  const payload = {
    _id: userLike._id,
    isAdmin: isBot ? false : Boolean(userLike.isAdmin),
    isDev: isBot ? false : Boolean(userLike.isDev),
    role: isBot ? "user" : userLike.role || "user",
    subscriptionTier: userLike.subscriptionTier || "free",
  };
  if (isBot) {
    payload.actorType = "grokbot";
    if (userLike.botCredentialId) {
      payload.botCredentialId = String(userLike.botCredentialId);
    }
  }

  return jwt.sign(payload, config.get("jwtPrivateKey"), {
    expiresIn: ACCESS_TOKEN_TTL_SECONDS,
  });
}

export function decodeAccessTokenExpiry(accessToken) {
  try {
    const decoded = jwt.decode(accessToken);
    if (decoded?.exp) {
      return {
        expiresAt: new Date(decoded.exp * 1000).toISOString(),
        expiresIn: Math.max(0, decoded.exp - Math.floor(Date.now() / 1000)),
      };
    }
  } catch {
    // ignore
  }
  return {
    expiresAt: new Date(
      Date.now() + ACCESS_TOKEN_TTL_SECONDS * 1000,
    ).toISOString(),
    expiresIn: ACCESS_TOKEN_TTL_SECONDS,
  };
}

function clientMeta(req) {
  if (!req) return { userAgent: "", ip: "" };
  const userAgent = String(req.get?.("user-agent") || req.headers?.["user-agent"] || "").slice(
    0,
    512,
  );
  const ip = String(
    req.ip ||
      req.headers?.["x-forwarded-for"]?.toString?.().split(",")[0]?.trim() ||
      req.connection?.remoteAddress ||
      "",
  ).slice(0, 64);
  return { userAgent, ip };
}

/**
 * Create access + refresh pair and persist hashed refresh token.
 */
export async function createSession(user, req = null, options = {}) {
  const actorType =
    options.actorType === "grokbot" || user?.actorType === "grokbot"
      ? "grokbot"
      : "user";
  const isBot = actorType === "grokbot";
  const botCredentialId =
    options.botCredentialId || user?.botCredentialId || null;
  const userLike = isBot
    ? { ...user, actorType: "grokbot", botCredentialId }
    : user;
  const accessToken = signAccessToken(userLike);
  const refreshToken = generateOpaqueToken();
  const familyId = new mongoose.Types.ObjectId();
  const now = Date.now();
  const { userAgent, ip } = clientMeta(req);
  const idleMs = isBot ? BOT_REFRESH_TOKEN_TTL_MS : REFRESH_TOKEN_TTL_MS;
  const absMs = isBot ? BOT_REFRESH_ABSOLUTE_MAX_MS : REFRESH_ABSOLUTE_MAX_MS;

  await RefreshToken.create({
    userId: user._id,
    tokenHash: hashToken(refreshToken),
    familyId,
    expiresAt: new Date(now + idleMs),
    absoluteExpiresAt: new Date(now + absMs),
    userAgent,
    ip,
    actorType: isBot ? "grokbot" : "user",
    botCredentialId: botCredentialId || null,
  });

  const exp = decodeAccessTokenExpiry(accessToken);
  return {
    accessToken,
    refreshToken,
    expiresIn: exp.expiresIn,
    expiresAt: exp.expiresAt,
  };
}

/**
 * Rotate refresh token (sliding idle expiry). Detects reuse of rotated tokens.
 * @returns {{ accessToken, refreshToken, expiresIn, expiresAt, userId } | null}
 */
export async function rotateRefreshSession(rawRefreshToken, req = null) {
  if (!rawRefreshToken || typeof rawRefreshToken !== "string") {
    return { error: "missing", status: 401 };
  }

  const tokenHash = hashToken(rawRefreshToken);
  const existing = await RefreshToken.findOne({ tokenHash });

  if (!existing) {
    return { error: "invalid", status: 401 };
  }

  if (existing.revokedAt) {
    // Possible theft: revoke entire family
    await RefreshToken.updateMany(
      { familyId: existing.familyId, revokedAt: null },
      { $set: { revokedAt: new Date() } },
    );
    return { error: "revoked", status: 401 };
  }

  const now = Date.now();
  if (
    existing.expiresAt.getTime() <= now ||
    existing.absoluteExpiresAt.getTime() <= now
  ) {
    existing.revokedAt = new Date();
    await existing.save();
    return { error: "expired", status: 401 };
  }

  const newRefreshToken = generateOpaqueToken();
  const newHash = hashToken(newRefreshToken);
  const { userAgent, ip } = clientMeta(req);

  // Mark old as revoked / replaced before issuing new
  existing.revokedAt = new Date();
  existing.replacedByHash = newHash;
  await existing.save();

  const actorType = existing.actorType === "grokbot" ? "grokbot" : "user";
  const idleMs =
    actorType === "grokbot" ? BOT_REFRESH_TOKEN_TTL_MS : REFRESH_TOKEN_TTL_MS;
  const idleExpiry = new Date(now + idleMs);
  const absoluteCap = existing.absoluteExpiresAt;
  const expiresAt =
    idleExpiry.getTime() > absoluteCap.getTime() ? absoluteCap : idleExpiry;

  await RefreshToken.create({
    userId: existing.userId,
    tokenHash: newHash,
    familyId: existing.familyId,
    expiresAt,
    absoluteExpiresAt: absoluteCap,
    userAgent: userAgent || existing.userAgent,
    ip: ip || existing.ip,
    actorType,
    botCredentialId: existing.botCredentialId || null,
  });

  return {
    userId: existing.userId,
    refreshToken: newRefreshToken,
    absoluteExpiresAt: absoluteCap,
    actorType,
    botCredentialId: existing.botCredentialId || null,
  };
}

export async function revokeRefreshToken(rawRefreshToken) {
  if (!rawRefreshToken) return false;
  const tokenHash = hashToken(rawRefreshToken);
  const result = await RefreshToken.updateOne(
    { tokenHash, revokedAt: null },
    { $set: { revokedAt: new Date() } },
  );
  return result.modifiedCount > 0;
}

export async function revokeAllUserSessions(userId) {
  if (!userId) return 0;
  const result = await RefreshToken.updateMany(
    { userId, revokedAt: null },
    { $set: { revokedAt: new Date() } },
  );
  return result.modifiedCount || 0;
}

/** Revoke only Grok Bot refresh sessions for this credential (leave human sessions). */
export async function revokeBotSessions(userId, botCredentialId) {
  if (!userId) return 0;
  const filter = {
    userId,
    actorType: "grokbot",
    revokedAt: null,
  };
  if (botCredentialId) {
    filter.botCredentialId = botCredentialId;
  }
  const result = await RefreshToken.updateMany(filter, {
    $set: { revokedAt: new Date() },
  });
  return result.modifiedCount || 0;
}

export function parseCookieHeader(cookieHeader = "") {
  const out = {};
  String(cookieHeader || "")
    .split(";")
    .forEach((part) => {
      const trimmed = part.trim();
      if (!trimmed) return;
      const eq = trimmed.indexOf("=");
      if (eq === -1) return;
      const key = trimmed.slice(0, eq).trim();
      const value = trimmed.slice(eq + 1).trim();
      try {
        out[key] = decodeURIComponent(value);
      } catch {
        out[key] = value;
      }
    });
  return out;
}

export function getRefreshTokenFromRequest(req) {
  const cookies = parseCookieHeader(req?.headers?.cookie || "");
  if (cookies[REFRESH_COOKIE_NAME]) {
    return cookies[REFRESH_COOKIE_NAME];
  }
  // Optional body fallback for non-browser clients
  if (req?.body?.refreshToken && typeof req.body.refreshToken === "string") {
    return req.body.refreshToken;
  }
  return null;
}

function isSecureRequest(req) {
  if (process.env.NODE_ENV === "production") return true;
  if (req?.secure) return true;
  const proto = req?.get?.("x-forwarded-proto") || req?.headers?.["x-forwarded-proto"];
  return String(proto || "").split(",")[0].trim() === "https";
}

function serializeCookie(name, value, options = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  if (options.maxAge != null) parts.push(`Max-Age=${Math.floor(options.maxAge)}`);
  if (options.path) parts.push(`Path=${options.path}`);
  if (options.httpOnly) parts.push("HttpOnly");
  if (options.secure) parts.push("Secure");
  if (options.sameSite) parts.push(`SameSite=${options.sameSite}`);
  if (options.expires instanceof Date) {
    parts.push(`Expires=${options.expires.toUTCString()}`);
  }
  return parts.join("; ");
}

/**
 * Set httpOnly refresh cookie. Path limited to /api/auth.
 */
export function setRefreshCookie(res, refreshToken, req = null) {
  const maxAgeSeconds = Math.floor(REFRESH_ABSOLUTE_MAX_MS / 1000);
  const cookie = serializeCookie(REFRESH_COOKIE_NAME, refreshToken, {
    maxAge: maxAgeSeconds,
    path: REFRESH_COOKIE_PATH,
    httpOnly: true,
    secure: isSecureRequest(req),
    sameSite: "Lax",
  });
  res.append("Set-Cookie", cookie);
}

export function clearRefreshCookie(res, req = null) {
  const cookie = serializeCookie(REFRESH_COOKIE_NAME, "", {
    maxAge: 0,
    path: REFRESH_COOKIE_PATH,
    httpOnly: true,
    secure: isSecureRequest(req),
    sameSite: "Lax",
    expires: new Date(0),
  });
  res.append("Set-Cookie", cookie);
}

/**
 * Apply session cookies + JSON fields used by the SPA.
 * Access token remains readable by JS (legacy x-auth-token header pattern)
 * but is short-lived; refresh is httpOnly-only.
 */
export function applySessionToResponse(res, session, req = null) {
  setRefreshCookie(res, session.refreshToken, req);

  // Hint header for clients that prefer headers over body
  res.set("x-auth-token", session.accessToken);
  res.set("x-access-token-expires-at", session.expiresAt);
  res.set("x-access-token-expires-in", String(session.expiresIn));
}

export function buildLoginUserPayload(user, session, extras = {}) {
  return {
    token: session.accessToken,
    expiresIn: session.expiresIn,
    expiresAt: session.expiresAt,
    _id: user._id,
    email: user.email,
    name: user.name,
    emailValidated: Boolean(user.emailValidated),
    isAdmin: Boolean(user.isAdmin),
    isDev: Boolean(user.isDev),
    subscriptionTier: user.subscriptionTier || "free",
    subscriptionStatus: user.subscriptionStatus || "none",
    ...extras,
  };
}
