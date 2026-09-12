import config from "config";
import verifyEmail from "./verifyEmail.js";

export const VERIFICATION_COOLDOWN_MS = 60 * 1000;

export const VERIFICATION_GENERIC_MESSAGE =
  "If that email needs verifying, we sent a new link. Check your inbox and your spam or junk folder.";

export function resolveAppBaseUrl(req) {
  const baseUrl =
    (config.has("baseUrl") ? config.get("baseUrl") : null) ||
    `${req.protocol}://${req.get("host")}`;
  return String(baseUrl).replace(/\/+$/, "");
}

export function verificationCooldownRemainingMs(user) {
  if (!user?.verificationEmailSentAt) return 0;
  const elapsed = Date.now() - new Date(user.verificationEmailSentAt).getTime();
  return elapsed < VERIFICATION_COOLDOWN_MS
    ? VERIFICATION_COOLDOWN_MS - elapsed
    : 0;
}

export function buildVerificationUrl(req, token, { plan } = {}) {
  const params = new URLSearchParams({ token });
  if (plan === "pro") params.set("plan", "pro");
  return `${resolveAppBaseUrl(req)}/verify.html?${params.toString()}`;
}

export async function sendVerificationEmailForUser(user, req, { plan } = {}) {
  const verifyToken = user.generateEmailVerificationToken();
  const url = buildVerificationUrl(req, verifyToken, { plan });
  await verifyEmail(user.name, user.email, url);
  user.verificationEmailSentAt = new Date();
  user.verificationEmailCount = (user.verificationEmailCount || 0) + 1;
}

export async function maybeSendVerificationEmail(user, req, { plan } = {}) {
  const retryAfterMs = verificationCooldownRemainingMs(user);
  if (retryAfterMs > 0) {
    return { sent: false, retryAfterMs, reason: "cooldown" };
  }
  try {
    await sendVerificationEmailForUser(user, req, { plan });
    await user.save();
    return { sent: true, retryAfterMs: VERIFICATION_COOLDOWN_MS };
  } catch (error) {
    console.error("Failed to send verification email", error);
    return { sent: false, retryAfterMs: 0, reason: "send_failed", error };
  }
}

export function unverifiedLoginBody(user, sendResult = {}) {
  const emailSent = Boolean(sendResult.sent);
  const retryAfterMs = Number(sendResult.retryAfterMs) || 0;
  let message;
  if (emailSent) {
    message =
      "Please verify your email before signing in. We just sent a new link — check your inbox and your spam or junk folder.";
  } else if (sendResult.reason === "send_failed") {
    message =
      "Please verify your email before signing in. We could not send a new email just now. Check your spam folder, then try resending.";
  } else {
    message =
      "Please verify your email before signing in. Check your inbox and your spam or junk folder. You can resend the link if you need to.";
  }
  return {
    error: message,
    message,
    code: "EMAIL_NOT_VERIFIED",
    verificationRequired: true,
    email: user.email,
    emailSent,
    retryAfterMs,
  };
}
