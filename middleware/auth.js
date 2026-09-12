import jwt from "jsonwebtoken";
import config from "config";
import { User } from "../models/user.js";
import {
  ACCESS_COOKIE_NAME,
  parseCookieHeader,
} from "../utils/authSessionService.js";

const ACTIVITY_THROTTLE_MS = 5 * 60 * 1000;
const lastActivityUpdates = new Map();

function touchLastActive(userId) {
  if (!userId) return;
  const key = String(userId);
  const now = Date.now();
  const last = lastActivityUpdates.get(key);
  if (last && now - last < ACTIVITY_THROTTLE_MS) return;
  lastActivityUpdates.set(key, now);
  User.updateOne({ _id: userId }, { $set: { lastActiveAt: new Date(now) } }).catch(
    () => {},
  );
}

function sendAuthError(res, status, code, message) {
  return res.status(status).json({
    error: message,
    message,
    code,
  });
}

function headerValue(req, name) {
  if (typeof req.header === "function") {
    const fromHelper = req.header(name);
    if (fromHelper) return String(fromHelper);
  }
  const headers = req.headers || {};
  const direct = headers[name] || headers[String(name).toLowerCase()];
  return direct ? String(direct) : "";
}

function bearerToken(req) {
  const authz =
    headerValue(req, "authorization") || headerValue(req, "Authorization");
  const match = authz.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : "";
}

export function extractAccessJwt(req) {
  const xAuth = headerValue(req, "x-auth-token").trim();
  if (xAuth) return xAuth;
  const bearer = bearerToken(req);
  if (bearer) return bearer;
  const cookies = parseCookieHeader(req?.headers?.cookie || "");
  const fromCookie = String(cookies[ACCESS_COOKIE_NAME] || "").trim();
  if (fromCookie) return fromCookie;
  return "";
}

export default async function auth(req, res, next) {
  const token = extractAccessJwt(req);
  if (!token) {
    return sendAuthError(
      res,
      401,
      "AUTH_REQUIRED",
      "Access denied. No token provided.",
    );
  }

  try {
    const decoded = jwt.verify(token, config.get("jwtPrivateKey"));
    if (
      decoded.purpose === "emailVerification" ||
      decoded.isEmailVerificationToken ||
      decoded.purpose === "share"
    ) {
      return sendAuthError(res, 401, "INVALID_TOKEN", "Invalid token.");
    }
    req.user = decoded;
    touchLastActive(decoded._id);
    return next();
  } catch (ex) {
    if (ex.name === "TokenExpiredError") {
      return sendAuthError(res, 401, "TOKEN_EXPIRED", "Token expired");
    }
    return sendAuthError(res, 401, "INVALID_TOKEN", "Invalid token.");
  }
}

export { sendAuthError };
