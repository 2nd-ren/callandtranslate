import mongoose from "mongoose";
import CallAgentTemplate from "../models/callAgentTemplate.js";
import CallAgentSession from "../models/callAgentSession.js";
import { CALL_AGENT_DEFAULT_PROMPT } from "./callAgentPrompt.js";
import { languageName, normalizeLanguageCode } from "./languages.js";
import { grokChatCompletion } from "./grokClient.js";
import { SUMMARY_SYSTEM_PROMPT } from "./callAgentPrompt.js";
import { logLlmUsage } from "./usageLogger.js";

const CALL_AGENT_FIELD_KEYS = [
  "goal",
  "rules",
  "information",
  "prompt",
  "yourName",
  "yourLanguage",
  "theirLanguage",
  "discloseAi",
];
const DEFAULT_TEMPLATE_LIMIT = 100;
const DEFAULT_SESSION_LIMIT = 50;
const MAX_TRANSCRIPT_TURNS = 2000;

class CallAgentServiceError extends Error {
  constructor(message, { status = 400, code = "CALL_AGENT_ERROR" } = {}) {
    super(message);
    this.name = "CallAgentServiceError";
    this.status = status;
    this.code = code;
  }
}

function toObjectId(value, label = "id") {
  if (value instanceof mongoose.Types.ObjectId) return value;
  if (mongoose.Types.ObjectId.isValid(value)) {
    return new mongoose.Types.ObjectId(value);
  }
  throw new CallAgentServiceError(`Invalid ${label}.`, {
    status: 400,
    code: "INVALID_ID",
  });
}

function toOptionalObjectId(value, label = "id") {
  if (!value) return null;
  return toObjectId(value, label);
}

function normalizeName(value, fallback = "") {
  const name = String(value || fallback).trim();
  if (!name) {
    throw new CallAgentServiceError("Name is required.", {
      status: 400,
      code: "MISSING_NAME",
    });
  }
  return name.slice(0, 220);
}

function normalizeNameKey(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .slice(0, 180);
}

function normalizeText(value, maxLength = 150000) {
  return String(value ?? "").slice(0, maxLength);
}

function normalizeFields(input = {}) {
  return {
    goal: normalizeText(input?.goal ?? "", 50000),
    rules: normalizeText(input?.rules ?? "", 50000),
    information: normalizeText(input?.information ?? "", 100000),
    prompt: normalizeText(input?.prompt ?? CALL_AGENT_DEFAULT_PROMPT, 150000),
    yourName: normalizeText(input?.yourName ?? "", 80).replace(/\s+/g, " ").trim(),
    yourLanguage: normalizeLanguageCode(input?.yourLanguage, "en"),
    theirLanguage: normalizeLanguageCode(input?.theirLanguage, "es"),
    discloseAi: input?.discloseAi !== false,
  };
}

function toDateOrNull(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function normalizeTranscriptTurn(turn = {}, index = 0) {
  const timestamp = toDateOrNull(turn.timestamp || turn.createdAt);
  const updatedAt = toDateOrNull(turn.updatedAt) || timestamp;
  return {
    clientTurnId: normalizeText(turn.id || turn.clientTurnId || "", 120),
    speaker: normalizeText(turn.speaker || `Speaker ${index + 1}`, 120),
    text: normalizeText(turn.text || ""),
    translation: normalizeText(turn.translation || ""),
    status: turn.status === "interim" ? "interim" : "final",
    source: normalizeText(turn.source || "", 160),
    words: turn.words || null,
    timestamp,
    updatedAt,
  };
}

function normalizeTranscript(transcript = []) {
  if (!Array.isArray(transcript)) return [];
  return transcript
    .slice(0, MAX_TRANSCRIPT_TURNS)
    .map((turn, index) => normalizeTranscriptTurn(turn, index))
    .filter((turn) => turn.text || turn.speaker);
}

function serializeTemplate(template) {
  if (!template) return null;
  const doc = typeof template.toObject === "function" ? template.toObject() : template;
  return {
    _id: String(doc._id),
    templateId: String(doc._id),
    ownerId: String(doc.ownerId),
    name: doc.name || "",
    description: doc.description || "",
    fields: normalizeFields(doc.fields || {}),
    createdAt: doc.createdAt || null,
    updatedAt: doc.updatedAt || null,
  };
}

function serializeTranscriptTurn(turn) {
  const doc = typeof turn?.toObject === "function" ? turn.toObject() : turn;
  return {
    _id: doc?._id ? String(doc._id) : "",
    id: doc?.clientTurnId || (doc?._id ? String(doc._id) : ""),
    speaker: doc?.speaker || "Speaker",
    text: doc?.text || "",
    translation: doc?.translation || "",
    status: doc?.status || "final",
    source: doc?.source || "",
    words: doc?.words || null,
    timestamp: doc?.timestamp || null,
    updatedAt: doc?.updatedAt || null,
  };
}

function serializeSession(session, { includeTranscript = true } = {}) {
  if (!session) return null;
  const doc = typeof session.toObject === "function" ? session.toObject() : session;
  const transcript = includeTranscript
    ? (doc.transcript || []).map(serializeTranscriptTurn)
    : undefined;
  return {
    _id: String(doc._id),
    sessionId: String(doc._id),
    ownerId: String(doc.ownerId),
    templateId: doc.templateId ? String(doc.templateId) : null,
    name: doc.name || "",
    fields: normalizeFields(doc.fields || {}),
    composedInstructions: doc.composedInstructions || "",
    selectedVoiceId: doc.selectedVoiceId || "",
    status: doc.status || "completed",
    sessionStartedAt: doc.sessionStartedAt || null,
    sessionEndedAt: doc.sessionEndedAt || null,
    durationSec: Number(doc.durationSec || 0),
    creditsDeducted: Number(doc.creditsDeducted || 0),
    transcriptTurnCount: Array.isArray(doc.transcript) ? doc.transcript.length : 0,
    ...(includeTranscript ? { transcript } : {}),
    summaryReport: doc.summaryReport || null,
    metadata: doc.metadata || {},
    createdAt: doc.createdAt || null,
    updatedAt: doc.updatedAt || null,
  };
}

function buildTranscriptText(transcript = []) {
  return (Array.isArray(transcript) ? transcript : [])
    .map((turn) => {
      const timestamp = turn.timestamp
        ? new Date(turn.timestamp).toISOString()
        : "";
      const prefix = timestamp ? `[${timestamp}] ` : "";
      const spoken = `${turn.speaker || "Speaker"}: ${turn.text || ""}`.trim();
      const translated = turn.translation
        ? ` / ${turn.translation}`
        : "";
      return `${prefix}${spoken}${translated}`.trim();
    })
    .filter(Boolean)
    .join("\n");
}

async function listCallAgentTemplates({ userId, limit = DEFAULT_TEMPLATE_LIMIT }) {
  const ownerId = toObjectId(userId, "userId");
  const templates = await CallAgentTemplate.find({ ownerId })
    .sort({ updatedAt: -1 })
    .limit(Math.min(Number(limit) || DEFAULT_TEMPLATE_LIMIT, 200));
  return templates.map(serializeTemplate);
}

async function createCallAgentTemplate({ userId, data = {} }) {
  const ownerId = toObjectId(userId, "userId");
  const name = normalizeName(data.name, "Call template");
  const template = await CallAgentTemplate.create({
    ownerId,
    name,
    nameKey: normalizeNameKey(name),
    description: normalizeText(data.description || "", 2000),
    fields: normalizeFields(data.fields || data),
    createdBy: ownerId,
    updatedBy: ownerId,
  });
  return serializeTemplate(template);
}

async function getCallAgentTemplate({ userId, templateId }) {
  const ownerId = toObjectId(userId, "userId");
  const template = await CallAgentTemplate.findOne({
    _id: toObjectId(templateId, "templateId"),
    ownerId,
  });
  if (!template) {
    throw new CallAgentServiceError("Template not found.", {
      status: 404,
      code: "TEMPLATE_NOT_FOUND",
    });
  }
  return serializeTemplate(template);
}

async function updateCallAgentTemplate({ userId, templateId, data = {} }) {
  const ownerId = toObjectId(userId, "userId");
  const template = await CallAgentTemplate.findOne({
    _id: toObjectId(templateId, "templateId"),
    ownerId,
  });
  if (!template) {
    throw new CallAgentServiceError("Template not found.", {
      status: 404,
      code: "TEMPLATE_NOT_FOUND",
    });
  }
  if (data.name) {
    template.name = normalizeName(data.name, template.name);
    template.nameKey = normalizeNameKey(template.name);
  }
  if (data.description !== undefined) {
    template.description = normalizeText(data.description, 2000);
  }
  if (data.fields !== undefined || CALL_AGENT_FIELD_KEYS.some((key) => key in data)) {
    template.fields = normalizeFields({
      ...(template.fields || {}),
      ...(data.fields || data),
    });
  }
  template.updatedBy = ownerId;
  await template.save();
  return serializeTemplate(template);
}

async function deleteCallAgentTemplate({ userId, templateId }) {
  const ownerId = toObjectId(userId, "userId");
  const result = await CallAgentTemplate.deleteOne({
    _id: toObjectId(templateId, "templateId"),
    ownerId,
  });
  if (!result.deletedCount) {
    throw new CallAgentServiceError("Template not found.", {
      status: 404,
      code: "TEMPLATE_NOT_FOUND",
    });
  }
  return { deleted: true, templateId };
}

async function listCallAgentSessions({ userId, limit = DEFAULT_SESSION_LIMIT }) {
  const ownerId = toObjectId(userId, "userId");
  const sessions = await CallAgentSession.find({ ownerId })
    .sort({ updatedAt: -1 })
    .limit(Math.min(Number(limit) || DEFAULT_SESSION_LIMIT, 200));
  return sessions.map((session) =>
    serializeSession(session, { includeTranscript: false }),
  );
}

async function createCallAgentSession({ userId, data = {} }) {
  const ownerId = toObjectId(userId, "userId");
  const name = normalizeName(
    data.name,
    `Call ${new Date().toISOString().slice(0, 16).replace("T", " ")}`,
  );
  const session = await CallAgentSession.create({
    ownerId,
    templateId: toOptionalObjectId(data.templateId, "templateId"),
    name,
    fields: normalizeFields(data.fields || data),
    composedInstructions: normalizeText(data.composedInstructions || "", 200000),
    transcript: normalizeTranscript(data.transcript),
    selectedVoiceId: normalizeText(data.selectedVoiceId || "", 120),
    status: data.status === "draft" || data.status === "summarized" ? data.status : "completed",
    sessionStartedAt: toDateOrNull(data.sessionStartedAt),
    sessionEndedAt: toDateOrNull(data.sessionEndedAt),
    durationSec: Math.max(0, Number(data.durationSec) || 0),
    creditsDeducted: Math.max(0, Number(data.creditsDeducted) || 0),
    summaryReport: data.summaryReport || null,
    metadata: data.metadata && typeof data.metadata === "object" ? data.metadata : {},
    createdBy: ownerId,
    updatedBy: ownerId,
  });
  return serializeSession(session);
}

async function getCallAgentSession({ userId, sessionId }) {
  const ownerId = toObjectId(userId, "userId");
  const session = await CallAgentSession.findOne({
    _id: toObjectId(sessionId, "sessionId"),
    ownerId,
  });
  if (!session) {
    throw new CallAgentServiceError("Session not found.", {
      status: 404,
      code: "SESSION_NOT_FOUND",
    });
  }
  return serializeSession(session);
}

async function updateCallAgentSession({ userId, sessionId, data = {} }) {
  const ownerId = toObjectId(userId, "userId");
  const session = await CallAgentSession.findOne({
    _id: toObjectId(sessionId, "sessionId"),
    ownerId,
  });
  if (!session) {
    throw new CallAgentServiceError("Session not found.", {
      status: 404,
      code: "SESSION_NOT_FOUND",
    });
  }
  if (data.name) session.name = normalizeName(data.name, session.name);
  if (data.fields !== undefined || CALL_AGENT_FIELD_KEYS.some((key) => key in data)) {
    session.fields = normalizeFields({
      ...(session.fields || {}),
      ...(data.fields || data),
    });
  }
  if (data.composedInstructions !== undefined) {
    session.composedInstructions = normalizeText(data.composedInstructions, 200000);
  }
  if (data.transcript !== undefined) {
    session.transcript = normalizeTranscript(data.transcript);
  }
  if (data.selectedVoiceId !== undefined) {
    session.selectedVoiceId = normalizeText(data.selectedVoiceId, 120);
  }
  if (data.status) session.status = data.status;
  if (data.sessionStartedAt !== undefined) {
    session.sessionStartedAt = toDateOrNull(data.sessionStartedAt);
  }
  if (data.sessionEndedAt !== undefined) {
    session.sessionEndedAt = toDateOrNull(data.sessionEndedAt);
  }
  if (data.durationSec !== undefined) {
    session.durationSec = Math.max(0, Number(data.durationSec) || 0);
  }
  if (data.creditsDeducted !== undefined) {
    session.creditsDeducted = Math.max(0, Number(data.creditsDeducted) || 0);
  }
  if (data.summaryReport !== undefined) {
    session.summaryReport = data.summaryReport;
  }
  if (data.metadata && typeof data.metadata === "object") {
    session.metadata = { ...(session.metadata || {}), ...data.metadata };
  }
  session.updatedBy = ownerId;
  await session.save();
  return serializeSession(session);
}

async function extractCallAgentSessionData({ userId, sessionId }) {
  const session = await getCallAgentSession({ userId, sessionId });
  return {
    session,
    transcriptText: buildTranscriptText(session.transcript || []),
    fields: session.fields,
  };
}

async function summarizeCallAgentSession({ userId, sessionId }) {
  const session = await getCallAgentSession({ userId, sessionId });
  const yourLanguage = languageName(session.fields?.yourLanguage || "en");
  const transcriptText = buildTranscriptText(session.transcript || []);
  const userPrompt = [
    `Write the report in ${yourLanguage}.`,
    `Goal: ${session.fields?.goal || ""}`,
    `Rules: ${session.fields?.rules || ""}`,
    `Information: ${session.fields?.information || ""}`,
    `Duration: ${session.durationSec || 0} seconds`,
    "Transcript:",
    transcriptText || "(empty transcript)",
  ].join("\n\n");

  const result = await grokChatCompletion({
    messages: [
      { role: "system", content: SUMMARY_SYSTEM_PROMPT },
      { role: "user", content: userPrompt },
    ],
    temperature: 0.2,
    maxTokens: 2500,
  });

  await logLlmUsage({
    userId,
    callType: "call-summary",
    model: result.raw?.model,
    usage: result.usage,
    metadata: { sessionId },
    skipDeduct: false,
  });

  const report = {
    type: "markdown",
    title: "Call Summary",
    markdown: String(result.text || "").trim(),
    generatedAt: new Date().toISOString(),
    sessionId: session.sessionId,
    source: "call-agent-summarizer",
  };

  await updateCallAgentSession({
    userId,
    sessionId,
    data: { summaryReport: report, status: "summarized" },
  });

  return report;
}

async function translateText({
  text,
  fromLanguage,
  toLanguage,
}) {
  const source = String(text || "").trim();
  if (!source) return { translation: "" };
  const fromName = languageName(fromLanguage);
  const toName = languageName(toLanguage);
  if (normalizeLanguageCode(fromLanguage) === normalizeLanguageCode(toLanguage)) {
    return { translation: source };
  }
  const result = await grokChatCompletion({
    messages: [
      {
        role: "system",
        content:
          "You are a live-call interpreter. Translate the user's text. Return only the translation, no quotes, no labels, no commentary.",
      },
      {
        role: "user",
        content: `Translate from ${fromName} to ${toName}:\n\n${source}`,
      },
    ],
    temperature: 0.1,
    maxTokens: 800,
    skipReasoningEffort: true,
  });
  return { translation: String(result.text || "").trim() };
}

export {
  CallAgentServiceError,
  listCallAgentTemplates,
  createCallAgentTemplate,
  getCallAgentTemplate,
  updateCallAgentTemplate,
  deleteCallAgentTemplate,
  listCallAgentSessions,
  createCallAgentSession,
  getCallAgentSession,
  updateCallAgentSession,
  extractCallAgentSessionData,
  summarizeCallAgentSession,
  translateText,
  CALL_AGENT_FIELD_KEYS,
};
