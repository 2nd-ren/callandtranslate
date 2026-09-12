import auth from "../middleware/auth.js";
import { User } from "../models/user.js";
import express from "express";
import rateLimit from "express-rate-limit";
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from "@simplewebauthn/server";
import {
  applySessionToResponse,
  buildLoginUserPayload,
  createSession,
} from "../utils/authSessionService.js";
import { ensureCreditBalance } from "../utils/userCredits.js";
import {
  maybeSendVerificationEmail,
  unverifiedLoginBody,
} from "../utils/emailVerification.js";
import { purgeIfDeletionDue } from "../utils/accountDeletion.js";
import { notifyInfoOps } from "../utils/opsNotify.js";

const router = express.Router();

const RP_NAME = "Call & Translate";
const KNOWN_ORIGINS = [
  "https://callandtranslate.com",
  "https://www.callandtranslate.com",
  "http://localhost:3005",
  "http://127.0.0.1:3005",
];
const KNOWN_RP_IDS = [
  "callandtranslate.com",
  "localhost",
  "127.0.0.1",
];
const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const pendingChallenges = new Map();

const passkeyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 40,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Too many passkey attempts. Try again later." },
});

function firstHeaderValue(value) {
  if (!value) return "";
  return String(value).split(",")[0].trim();
}

function getRequestHostParts(req) {
  const forwardedProto = firstHeaderValue(req.headers["x-forwarded-proto"]);
  const proto = forwardedProto || req.protocol || "http";
  const forwardedHost = firstHeaderValue(
    req.headers["x-forwarded-host"] || req.get("host") || "localhost",
  );
  const hostname = forwardedHost.split(":")[0];
  return { proto, host: forwardedHost, hostname };
}

export function getRpConfig(req) {
  const { proto, host, hostname } = getRequestHostParts(req);
  const origin = `${proto}://${host}`;
  const rpID =
    hostname === "www.callandtranslate.com"
      ? "callandtranslate.com"
      : hostname;
  const expectedOrigins = Array.from(new Set([origin, ...KNOWN_ORIGINS]));
  const expectedRPIDs = Array.from(new Set([rpID, ...KNOWN_RP_IDS]));
  return { rpName: RP_NAME, rpID, origin, expectedOrigins, expectedRPIDs };
}

function pruneChallenges() {
  const now = Date.now();
  for (const [challenge, entry] of pendingChallenges) {
    if (!entry || entry.expiresAt <= now) pendingChallenges.delete(challenge);
  }
}

function storeChallenge(challenge, userId = null) {
  if (!challenge) return;
  pruneChallenges();
  pendingChallenges.set(challenge, {
    userId: userId ? String(userId) : null,
    expiresAt: Date.now() + CHALLENGE_TTL_MS,
  });
}

function consumeChallenge(challenge, userId = null) {
  if (!challenge) return false;
  const entry = pendingChallenges.get(challenge);
  if (!entry) return false;
  if (entry.expiresAt <= Date.now()) {
    pendingChallenges.delete(challenge);
    return false;
  }
  if (entry.userId && userId && entry.userId !== String(userId)) {
    return false;
  }
  pendingChallenges.delete(challenge);
  return true;
}

function challengeMatches(expected, incoming, userId = null) {
  if (expected && incoming === expected) return true;
  return consumeChallenge(incoming, userId);
}

function toBase64Url(bytes) {
  return Buffer.from(bytes).toString("base64url");
}

function fromBase64Url(value) {
  return new Uint8Array(Buffer.from(value, "base64url"));
}

function sendError(res, status, message) {
  return res.status(status).json({ verified: false, message });
}

router.post("/register-options", auth, async (req, res) => {
  try {
    const user = await User.findById(req.user._id);
    if (!user) return sendError(res, 404, "User not found.");
    const { rpName, rpID } = getRpConfig(req);
    const excludeCredentials = (user.passkeys || [])
      .filter((pk) => pk.credentialId)
      .map((pk) => ({
        id: pk.credentialId,
        transports: pk.transports || [],
      }));
    const options = await generateRegistrationOptions({
      rpName,
      rpID,
      userID: new TextEncoder().encode(user._id.toString()),
      userName: user.email,
      userDisplayName: user.name,
      attestationType: "none",
      excludeCredentials,
      authenticatorSelection: {
        residentKey: "preferred",
        userVerification: "preferred",
      },
    });
    user.currentChallenge = options.challenge;
    await user.save();
    storeChallenge(options.challenge, user._id);
    res.json(options);
  } catch (err) {
    console.error("Passkey register-options error:", err);
    sendError(res, 500, "Failed to generate registration options.");
  }
});

router.post("/register-verify", auth, async (req, res) => {
  try {
    const user = await User.findById(req.user._id);
    if (!user) return sendError(res, 404, "User not found.");
    const response = req.body?.credential || req.body;
    if (!response || !response.id) {
      return sendError(res, 400, "No credential provided.");
    }
    const { expectedOrigins, expectedRPIDs } = getRpConfig(req);
    const verification = await verifyRegistrationResponse({
      response,
      expectedChallenge: (challenge) =>
        challengeMatches(user.currentChallenge, challenge, user._id),
      expectedOrigin: expectedOrigins,
      expectedRPID: expectedRPIDs,
      requireUserVerification: false,
    });
    if (!verification.verified || !verification.registrationInfo) {
      return sendError(res, 400, "Verification failed.");
    }
    const { credential } = verification.registrationInfo;
    const credentialId = credential.id;
    const alreadyRegistered = (user.passkeys || []).some(
      (pk) => pk.credentialId === credentialId,
    );
    if (alreadyRegistered) {
      user.currentChallenge = undefined;
      await user.save();
      return res.json({ verified: true, message: "Passkey already registered." });
    }
    user.passkeys.push({
      credentialId,
      publicKey: toBase64Url(credential.publicKey),
      counter: credential.counter,
      transports: credential.transports || response.response?.transports || [],
      name: req.body.name || `Passkey ${(user.passkeys || []).length + 1}`,
    });
    user.currentChallenge = undefined;
    await user.save();
    res.json({ verified: true });
  } catch (err) {
    console.error("Passkey register-verify error:", err);
    sendError(res, 400, err.message || "Failed to verify registration.");
  }
});

router.post("/login-options", passkeyLimiter, async (req, res) => {
  try {
    const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
    let allowCredentials;
    let user = null;
    if (email) {
      user = await User.findOne({ email });
      if (user && user.passkeys && user.passkeys.length > 0) {
        allowCredentials = user.passkeys
          .filter((pk) => pk.credentialId)
          .map((pk) => ({
            id: pk.credentialId,
            transports: pk.transports || [],
          }));
      }
    }
    const { rpID } = getRpConfig(req);
    const options = await generateAuthenticationOptions({
      rpID,
      allowCredentials,
      userVerification: "preferred",
    });
    if (user) {
      user.currentChallenge = options.challenge;
      await user.save();
      storeChallenge(options.challenge, user._id);
    } else {
      storeChallenge(options.challenge);
    }
    res.json({ ...options, _challengeEmail: email || null });
  } catch (err) {
    console.error("Passkey login-options error:", err);
    sendError(res, 500, "Failed to generate authentication options.");
  }
});

router.post("/login-verify", passkeyLimiter, async (req, res) => {
  try {
    const credential = req.body?.credential || req.body;
    const email =
      typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
    if (!credential || !credential.id) {
      return sendError(res, 400, "No credential provided.");
    }
    let user = null;
    if (email) user = await User.findOne({ email });
    if (!user) {
      user = await User.findOne({ "passkeys.credentialId": credential.id });
    }
    if (!user) return sendError(res, 400, "Passkey not recognized.");
    const storedPasskey = user.passkeys.find(
      (pk) => pk.credentialId === credential.id,
    );
    if (!storedPasskey) return sendError(res, 400, "Passkey not found.");
    const { expectedOrigins, expectedRPIDs } = getRpConfig(req);
    const verification = await verifyAuthenticationResponse({
      response: credential,
      expectedChallenge: (challenge) =>
        challengeMatches(user.currentChallenge, challenge, user._id),
      expectedOrigin: expectedOrigins,
      expectedRPID: expectedRPIDs,
      requireUserVerification: false,
      credential: {
        id: storedPasskey.credentialId,
        publicKey: fromBase64Url(storedPasskey.publicKey),
        counter: storedPasskey.counter,
        transports: storedPasskey.transports,
      },
    });
    if (!verification.verified) {
      return sendError(res, 400, "Authentication failed.");
    }
    storedPasskey.counter = verification.authenticationInfo.newCounter;
    user.currentChallenge = undefined;
    await user.save();

    if (await purgeIfDeletionDue(user)) {
      return sendError(res, 400, "Passkey not recognized.");
    }

    if (!user.emailValidated) {
      const sendResult = await maybeSendVerificationEmail(user, req);
      return res.status(403).json({
        verified: false,
        ...unverifiedLoginBody(user, sendResult),
      });
    }

    const session = await createSession(user, req);
    applySessionToResponse(res, session, req);
    const creditResult = await ensureCreditBalance(user._id);
    void notifyInfoOps({
      event: "user_logged_in",
      user,
      lines: ["Method: passkey"],
    });
    const payload = buildLoginUserPayload(user, session, {
      token_credit_balance: creditResult.balance,
      actorType: "user",
      verified: true,
    });
    res.json(payload);
  } catch (err) {
    console.error("Passkey login-verify error:", err);
    sendError(res, 400, err.message || "Failed to verify authentication.");
  }
});

router.get("/", auth, async (req, res) => {
  const user = await User.findById(req.user._id).select("passkeys");
  if (!user) return sendError(res, 404, "User not found.");
  res.json(
    (user.passkeys || []).map((pk) => ({
      credentialId: pk.credentialId,
      name: pk.name,
      createdAt: pk.createdAt,
    })),
  );
});

router.delete("/:credentialId", auth, async (req, res) => {
  const user = await User.findById(req.user._id);
  if (!user) return sendError(res, 404, "User not found.");
  const idx = user.passkeys.findIndex(
    (pk) => pk.credentialId === req.params.credentialId,
  );
  if (idx === -1) return sendError(res, 404, "Passkey not found.");
  user.passkeys.splice(idx, 1);
  await user.save();
  res.json({ message: "Passkey removed." });
});

router.post("/dismiss-prompt", auth, async (req, res) => {
  await User.findByIdAndUpdate(req.user._id, { passkeyPromptDismissed: true });
  res.json({ message: "Prompt dismissed." });
});

export default router;
