import mongoose from "mongoose";
import { CallAgentFieldsSchema } from "./callAgentTemplate.js";

const CallAgentTranscriptTurnSchema = new mongoose.Schema(
  {
    clientTurnId: { type: String, default: "", trim: true, maxlength: 120 },
    speaker: { type: String, default: "Speaker", trim: true, maxlength: 120 },
    text: { type: String, default: "", maxlength: 100000 },
    translation: { type: String, default: "", maxlength: 100000 },
    status: {
      type: String,
      enum: ["interim", "final"],
      default: "final",
    },
    source: { type: String, default: "", trim: true, maxlength: 160 },
    words: { type: mongoose.Schema.Types.Mixed, default: null },
    timestamp: { type: Date, default: null },
    updatedAt: { type: Date, default: null },
  },
  { _id: true },
);

const CallAgentSessionSchema = new mongoose.Schema(
  {
    ownerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    templateId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "CallAgentTemplate",
      default: null,
    },
    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: 220,
    },
    fields: {
      type: CallAgentFieldsSchema,
      default: () => ({}),
    },
    composedInstructions: {
      type: String,
      default: "",
      maxlength: 200000,
    },
    transcript: {
      type: [CallAgentTranscriptTurnSchema],
      default: [],
    },
    selectedVoiceId: {
      type: String,
      default: "",
      trim: true,
      maxlength: 120,
    },
    status: {
      type: String,
      enum: ["draft", "completed", "summarized"],
      default: "completed",
      index: true,
    },
    sessionStartedAt: { type: Date, default: null },
    sessionEndedAt: { type: Date, default: null },
    durationSec: { type: Number, default: 0 },
    creditsDeducted: { type: Number, default: 0 },
    summaryReport: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: () => ({}),
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
  },
  { timestamps: true },
);

CallAgentSessionSchema.index({ ownerId: 1, updatedAt: -1 });

const CallAgentSession = mongoose.model(
  "CallAgentSession",
  CallAgentSessionSchema,
);

export { CallAgentSession, CallAgentTranscriptTurnSchema };
export default CallAgentSession;
