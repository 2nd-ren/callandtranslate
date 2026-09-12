import Joi from "joi";
import bcrypt from "bcrypt";
import { User } from "../models/user.js";
import express from "express";
import rateLimit from "express-rate-limit";
import { ensureCreditBalance } from "../utils/userCredits.js";
import {
  applySessionToResponse,
  buildLoginUserPayload,
  clearRefreshCookie,
  createSession,
  decodeAccessTokenExpiry,
  getRefreshTokenFromRequest,
  revokeAllUserSessions,
  revokeRefreshToken,
  rotateRefreshSession,
  signAccessToken,
} from "../utils/authSessionService.js";
import auth, { extractAccessJwt } from "../middleware/auth.js";
import forbidGrokBot from "../middleware/forbidGrokBot.js";
import {
  maybeSendVerificationEmail,
  unverifiedLoginBody,
} from "../utils/emailVerification.js";
import { purgeIfDeletionDue } from "../utils/accountDeletion.js";
import { notifyInfoOps } from "../utils/opsNotify.js";

const router = express.Router();

const loginLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  keyGenerator(req) {
    const email = String(req.body?.email || "")
      .toLowerCase()
      .trim();
    return `${req.ip}:${email || "unknown"}`;
  },
  message: {
    error: "Too many login attempts from this IP.",
    message: "Too many login attempts. Please try again in an hour.",
    code: "RATE_LIMITED",
  },
});

const refreshLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: "Too many refresh attempts.",
    message: "Too many refresh attempts. Please try again later.",
    code: "RATE_LIMITED",
  },
});

function invalidCredentials(res) {
  return res.status(400).json({
    error:
      "The email and password combination entered was not found. Please try again, or register if you do not yet have an account.",
    message:
      "The email and password combination entered was not found. Please try again, or register if you do not yet have an account.",
    code: "INVALID_CREDENTIALS",
  });
}

router.post("/", loginLimiter, async (req, res) => {
  const { error } = validate(req.body);
  if (error) {
    return res.status(400).json({
      error: error.details[0].message,
      message: error.details[0].message,
      code: "VALIDATION_ERROR",
    });
  }

  const identifier = String(req.body.email || "")
    .trim()
    .toLowerCase();
  const user = await User.findOne({ email: identifier });
  if (!user) return invalidCredentials(res);

  const validPassword = await bcrypt.compare(req.body.password, user.password);
  if (!validPassword) return invalidCredentials(res);

  if (await purgeIfDeletionDue(user)) return invalidCredentials(res);

  if (!user.emailValidated) {
    const sendResult = await maybeSendVerificationEmail(user, req);
    return res.status(403).json(unverifiedLoginBody(user, sendResult));
  }

  const session = await createSession(user, req);
  applySessionToResponse(res, session, req);
  const creditResult = await ensureCreditBalance(user._id);
  void notifyInfoOps({
    event: "user_logged_in",
    user,
    lines: ["Method: password"],
  });
  const responsePayload = buildLoginUserPayload(user, session, {
    token_credit_balance: creditResult.balance,
    actorType: "user",
  });
  return res.send(responsePayload);
});

router.post("/refresh", refreshLimiter, async (req, res) => {
  const raw = getRefreshTokenFromRequest(req);
  if (!raw) {
    clearRefreshCookie(res, req);
    return res.status(401).json({
      error: "Refresh token required.",
      message: "Refresh token required.",
      code: "REFRESH_REQUIRED",
    });
  }

  const rotated = await rotateRefreshSession(raw, req);
  if (rotated.error) {
    clearRefreshCookie(res, req);
    return res.status(rotated.status || 401).json({
      error: "Session expired. Please log in again.",
      message: "Session expired. Please log in again.",
      code:
        rotated.error === "expired"
          ? "REFRESH_EXPIRED"
          : rotated.error === "revoked"
            ? "REFRESH_REVOKED"
            : "REFRESH_INVALID",
    });
  }

  const user = await User.findById(rotated.userId);
  if (!user || (await purgeIfDeletionDue(user))) {
    clearRefreshCookie(res, req);
    return res.status(401).json({
      error: "User not found.",
      message: "User not found.",
      code: "USER_NOT_FOUND",
    });
  }

  const accessToken = signAccessToken({
    _id: user._id,
    isAdmin: user.isAdmin,
    isDev: user.isDev,
    role: user.role,
    subscriptionTier: user.subscriptionTier,
    actorType: "user",
  });
  const exp = decodeAccessTokenExpiry(accessToken);
  const session = {
    accessToken,
    refreshToken: rotated.refreshToken,
    expiresIn: exp.expiresIn,
    expiresAt: exp.expiresAt,
  };
  applySessionToResponse(res, session, req);
  res.send({
    token: accessToken,
    expiresIn: exp.expiresIn,
    expiresAt: exp.expiresAt,
    _id: user._id,
    email: user.email,
    name: user.name,
    emailValidated: Boolean(user.emailValidated),
    isAdmin: Boolean(user.isAdmin),
    isDev: Boolean(user.isDev),
    actorType: "user",
    subscriptionTier: user.subscriptionTier || "free",
  });
});

router.post("/logout", async (req, res) => {
  const raw = getRefreshTokenFromRequest(req);
  if (raw) await revokeRefreshToken(raw);
  clearRefreshCookie(res, req);
  res.status(200).json({
    message: "Logged out",
    redirect: "/index.html",
    code: "LOGGED_OUT",
  });
});

router.post("/logout-all", auth, forbidGrokBot, async (req, res) => {
  await revokeAllUserSessions(req.user._id);
  clearRefreshCookie(res, req);
  res.status(200).json({
    message: "Logged out of all sessions",
    code: "LOGGED_OUT_ALL",
  });
});

router.get("/session", auth, async (req, res) => {
  const jwtToken = extractAccessJwt(req);
  const exp = jwtToken
    ? decodeAccessTokenExpiry(jwtToken)
    : { expiresIn: null, expiresAt: null };
  res.send({
    authenticated: true,
    userId: req.user._id,
    actorType: "user",
    expiresIn: exp.expiresIn,
    expiresAt: exp.expiresAt,
    authMethod: "access_token",
  });
});

function validate(body) {
  return Joi.object({
    email: Joi.string().min(5).max(255).required(),
    password: Joi.string().min(5).max(255).required(),
  }).validate(body);
}

export default router;
