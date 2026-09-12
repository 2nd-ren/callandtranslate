import mongoose from "mongoose";

/**
 * Server-side refresh token sessions.
 * Raw tokens are never stored — only sha256 hashes.
 * familyId groups a rotation chain; reuse of an already-rotated token
 * revokes the whole family (theft detection).
 */
const refreshTokenSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    tokenHash: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    familyId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      index: true,
    },
    /** Sliding idle expiry — extended on each successful refresh. */
    expiresAt: {
      type: Date,
      required: true,
      index: true,
    },
    /** Hard cap from original login; never extended. */
    absoluteExpiresAt: {
      type: Date,
      required: true,
    },
    revokedAt: {
      type: Date,
      default: null,
    },
    replacedByHash: {
      type: String,
      default: null,
    },
    userAgent: {
      type: String,
      default: "",
      maxlength: 512,
    },
    ip: {
      type: String,
      default: "",
      maxlength: 64,
    },
    /** "user" (human) or "grokbot". Preserved across refresh rotation. */
    actorType: {
      type: String,
      enum: ["user", "grokbot"],
      default: "user",
      index: true,
    },
    botCredentialId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "BotCredential",
      default: null,
      index: true,
    },
  },
  {
    timestamps: { createdAt: true, updatedAt: true },
  },
);

// TTL cleanup shortly after absolute expiry (Mongo purges when absoluteExpiresAt passes)
refreshTokenSchema.index({ absoluteExpiresAt: 1 }, { expireAfterSeconds: 0 });

export const RefreshToken =
  mongoose.models.RefreshToken ||
  mongoose.model("RefreshToken", refreshTokenSchema);

export default RefreshToken;
