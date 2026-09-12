import mongoose from "mongoose";
import crypto from "crypto";

const usageRecordSchema = new mongoose.Schema(
  {
    requestId: {
      type: String,
      required: true,
      unique: true,
      default: () => crypto.randomUUID(),
    },
    projectId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Project",
      index: true,
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      index: true,
    },
    callType: { type: String, required: true, index: true },
    model: { type: String, default: "" },
    inputTokens: { type: Number, default: 0, min: 0 },
    outputTokens: { type: Number, default: 0, min: 0 },
    cachedInputTokens: { type: Number, default: 0, min: 0 },
    reasoningTokens: { type: Number, default: 0, min: 0 },
    totalTokens: { type: Number, default: 0, min: 0 },
    durationSec: { type: Number, min: 0 },
    cost: { type: Number, required: true, min: 0 },
    creditsDeducted: { type: Number, default: 0, min: 0 },
    success: { type: Boolean, default: true },
    metadata: { type: mongoose.Schema.Types.Mixed },
  },
  { timestamps: true },
);

usageRecordSchema.index({ userId: 1, createdAt: -1 });
usageRecordSchema.index({ projectId: 1, createdAt: -1 });

export const UsageRecord =
  mongoose.models.UsageRecord ||
  mongoose.model("UsageRecord", usageRecordSchema);

export default UsageRecord;
