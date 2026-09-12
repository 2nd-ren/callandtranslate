import config from "config";
import jwt from "jsonwebtoken";
import Joi from "joi";
import mongoose from "mongoose";
import crypto from "crypto";

const userSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    minlength: 1,
    maxlength: 50,
  },
  email: {
    type: String,
    required: true,
    minlength: 5,
    maxlength: 255,
    unique: true,
  },
  password: {
    type: String,
    required: true,
    minlength: 5,
    maxlength: 1024,
  },
  role: {
    type: String,
    enum: ["user", "admin", "dev-1", "tester", "viewer", "guest"],
    default: "user",
  },
  emailValidated: {
    type: Boolean,
    default: false,
  },
  verificationEmailSentAt: Date,
  verificationEmailCount: {
    type: Number,
    default: 0,
  },
  isAdmin: {
    type: Boolean,
    default: false,
  },
  isDev: {
    type: Boolean,
    default: false,
  },
  resetToken: {
    type: String,
    required: false,
    maxlength: 1024,
  },
  resetUsed: {
    type: Boolean,
    default: false,
  },
  resetTokenExpiresAt: Date,
  resetRequestedAt: Date,
  lastReset: {
    type: Date,
    default: () => new Date("2000-01-01"),
  },
  passkeys: [
    {
      credentialId: { type: String, required: true },
      publicKey: { type: String, required: true },
      counter: { type: Number, default: 0 },
      transports: [String],
      name: { type: String, default: "My Passkey" },
      createdAt: { type: Date, default: Date.now },
    },
  ],
  passkeyPromptDismissed: {
    type: Boolean,
    default: false,
  },
  currentChallenge: {
    type: String,
    required: false,
  },
  userPreferences: {
    type: Map,
    of: mongoose.Schema.Types.Mixed,
    default: () => new Map(),
  },
  token_credit_balance: {
    type: Number,
    default: 0,
    min: 0,
  },
  defaultTeamId: {
    type: mongoose.Schema.Types.ObjectId,
    default: null,
  },
  team_account_id: {
    type: mongoose.Schema.Types.ObjectId,
    default: null,
  },
  subscriptionTier: {
    type: String,
    default: "free",
  },
  subscriptionStatus: {
    type: String,
    default: "none",
  },
  subscriptionStartedAt: Date,
  stripeCustomerId: {
    type: String,
    sparse: true,
    index: true,
  },
  stripeSubscriptionId: {
    type: String,
    sparse: true,
    index: true,
  },
  stripePriceId: {
    type: String,
  },
  cancelAtPeriodEnd: {
    type: Boolean,
    default: false,
  },
  subscriptionCurrentPeriodEnd: Date,
  subscriptionWelcomeEmailSentAt: Date,
  subscriptionCancelFeedbackEmailSentAt: Date,
  deletionScheduledAt: {
    type: Date,
    default: null,
    index: true,
  },
  lastActiveAt: {
    type: Date,
    default: null,
    index: true,
  },
  termsAcceptedAt: {
    type: Date,
    default: null,
  },
  privacyAcknowledgedAt: {
    type: Date,
    default: null,
  },
  legalVersionAccepted: {
    type: String,
    default: "",
    maxlength: 40,
  },
});

userSchema.methods.generateAuthToken = function () {
  const ACCESS_TOKEN_TTL_SECONDS = 30 * 60;
  return jwt.sign(
    {
      _id: this._id,
      isAdmin: this.isAdmin,
      isDev: this.isDev,
      role: this.role,
      subscriptionTier: this.subscriptionTier || "free",
    },
    config.get("jwtPrivateKey"),
    { expiresIn: ACCESS_TOKEN_TTL_SECONDS },
  );
};

userSchema.methods.generateEmailVerificationToken = function () {
  return jwt.sign(
    {
      _id: this._id,
      purpose: "emailVerification",
      timestamp: Date.now(),
      isEmailVerificationToken: true,
    },
    config.get("jwtPrivateKey"),
    { expiresIn: "15m" },
  );
};

userSchema.methods.generatePasswordResetToken = function () {
  const token = crypto.randomBytes(32).toString("hex");
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000);
  return { token, tokenHash, expiresAt };
};

const User = mongoose.model("User", userSchema);

function validateUser(user) {
  const schema = Joi.object({
    name: Joi.string().min(1).max(50).required(),
    email: Joi.string().min(5).max(255).required().email(),
    password: Joi.string().min(8).max(72).required(),
    plan: Joi.string().valid("pro", "free").optional(),
    termsAccepted: Joi.boolean().valid(true).required().messages({
      "any.only": "You must accept the Terms of Service and Privacy Policy.",
      "any.required": "You must accept the Terms of Service and Privacy Policy.",
    }),
    legalVersion: Joi.string().max(40).optional(),
  });
  return schema.validate(user);
}

function validateUserName(user) {
  return Joi.object({
    name: Joi.string().min(1).max(50).required(),
  }).validate(user);
}

function validateUserEmail(user) {
  return Joi.object({
    email: Joi.string().min(5).max(255).required().email(),
  }).validate(user);
}

export { User };
export { validateUser as validate };
export { validateUserName as validateName };
export { validateUserEmail as validateEmail };
