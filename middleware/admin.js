import jwt from "jsonwebtoken";
import config from "config";
import { User } from "../models/user.js";
import { extractAccessJwt, sendAuthError } from "./auth.js";

export function isPrivilegedUser(user) {
  return Boolean(user?.isAdmin || user?.isDev || user?.role === "admin");
}

export default async function admin(req, res, next) {
  if (!req.user?._id) {
    return sendAuthError(res, 401, "AUTH_REQUIRED", "Access denied.");
  }
  if (req.user.actorType === "grokbot") {
    return res.status(403).json({
      error: "This action is not available to Grok Bot logins.",
      message: "This action is not available to Grok Bot logins.",
      code: "GROKBOT_FORBIDDEN",
    });
  }

  try {
    const user = await User.findById(req.user._id).select("isAdmin isDev role");
    if (!user) {
      return sendAuthError(res, 401, "AUTH_REQUIRED", "Access denied.");
    }
    if (!isPrivilegedUser(user)) {
      return res.status(403).json({
        error: "Access denied.",
        message: "Access denied.",
        code: "ADMIN_REQUIRED",
      });
    }
    req.user.isAdmin = Boolean(user.isAdmin);
    req.user.isDev = Boolean(user.isDev);
    req.user.role = user.role;
    return next();
  } catch (error) {
    console.error("Failed to verify admin access", error);
    return res.status(500).json({
      error: "Unable to verify admin access.",
      message: "Unable to verify admin access.",
      code: "ADMIN_VERIFY_FAILED",
    });
  }
}

export async function htmlAuth(req, res, next) {
  const token = extractAccessJwt(req);
  if (!token) return res.redirect("/index.html");
  try {
    const decoded = jwt.verify(token, config.get("jwtPrivateKey"));
    if (
      decoded.purpose === "emailVerification" ||
      decoded.isEmailVerificationToken ||
      decoded.purpose === "share"
    ) {
      return res.redirect("/index.html");
    }
    req.user = decoded;
    return next();
  } catch {
    return res.redirect("/index.html");
  }
}

export async function htmlAdmin(req, res, next) {
  if (!req.user?._id) return res.redirect("/index.html");
  try {
    const user = await User.findById(req.user._id).select("isAdmin isDev role");
    if (!user) return res.redirect("/index.html");
    if (!isPrivilegedUser(user)) return res.redirect("/app.html");
    req.user.isAdmin = Boolean(user.isAdmin);
    req.user.isDev = Boolean(user.isDev);
    req.user.role = user.role;
    return next();
  } catch {
    return res.redirect("/app.html");
  }
}
