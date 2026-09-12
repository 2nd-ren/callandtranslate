import express from "express";
import auth from "../middleware/auth.js";
import {
  CallAgentServiceError,
  createCallAgentSession,
  createCallAgentTemplate,
  deleteCallAgentTemplate,
  extractCallAgentSessionData,
  getCallAgentSession,
  getCallAgentTemplate,
  listCallAgentSessions,
  listCallAgentTemplates,
  summarizeCallAgentSession,
  translateText,
  updateCallAgentSession,
  updateCallAgentTemplate,
} from "../utils/callAgentService.js";
import { LANGUAGES } from "../utils/languages.js";
import { composeCallAgentInstructions } from "../utils/callAgentPrompt.js";
import { CALL_AGENT_DEFAULT_PROMPT } from "../utils/callAgentPrompt.js";
import {
  applyBriefFollowUps,
  fillCallBrief,
  transcribeDictation,
} from "../utils/callAgentFill.js";
import { jsonPlanError } from "../utils/plans.js";

const router = express.Router();

function sendError(res, error, fallbackMessage = "Call request failed.") {
  if (error instanceof CallAgentServiceError) {
    return res.status(error.status || 400).json({
      error: error.message,
      code: error.code,
    });
  }
  console.error(fallbackMessage, error);
  return res.status(500).json({
    error: fallbackMessage,
    code: "INTERNAL_ERROR",
    details: error?.message || String(error),
  });
}

router.get("/languages", auth, (_req, res) => {
  res.json({ languages: LANGUAGES });
});

router.get("/defaults", auth, (_req, res) => {
  res.json({
    prompt: CALL_AGENT_DEFAULT_PROMPT,
    yourName: "",
    yourLanguage: "en",
    theirLanguage: "es",
    discloseAi: true,
  });
});

router.get("/templates", auth, async (req, res) => {
  try {
    const templates = await listCallAgentTemplates({
      userId: req.user._id,
      limit: req.query.limit,
    });
    return res.json({ templates });
  } catch (error) {
    return sendError(res, error, "Failed to list templates.");
  }
});

router.post("/templates", auth, async (req, res) => {
  try {
    const template = await createCallAgentTemplate({
      userId: req.user._id,
      data: req.body || {},
    });
    return res.status(201).json({ template });
  } catch (error) {
    return sendError(res, error, "Failed to create template.");
  }
});

router.get("/templates/:templateId", auth, async (req, res) => {
  try {
    const template = await getCallAgentTemplate({
      userId: req.user._id,
      templateId: req.params.templateId,
    });
    return res.json({ template });
  } catch (error) {
    return sendError(res, error, "Failed to load template.");
  }
});

router.patch("/templates/:templateId", auth, async (req, res) => {
  try {
    const template = await updateCallAgentTemplate({
      userId: req.user._id,
      templateId: req.params.templateId,
      data: req.body || {},
    });
    return res.json({ template });
  } catch (error) {
    return sendError(res, error, "Failed to update template.");
  }
});

router.delete("/templates/:templateId", auth, async (req, res) => {
  try {
    const result = await deleteCallAgentTemplate({
      userId: req.user._id,
      templateId: req.params.templateId,
    });
    return res.json(result);
  } catch (error) {
    return sendError(res, error, "Failed to delete template.");
  }
});

router.get("/sessions", auth, async (req, res) => {
  try {
    const sessions = await listCallAgentSessions({
      userId: req.user._id,
      limit: req.query.limit,
    });
    return res.json({ sessions });
  } catch (error) {
    return sendError(res, error, "Failed to list sessions.");
  }
});

router.post("/sessions", auth, async (req, res) => {
  try {
    const session = await createCallAgentSession({
      userId: req.user._id,
      data: req.body || {},
    });
    return res.status(201).json({ session });
  } catch (error) {
    return sendError(res, error, "Failed to save session.");
  }
});

router.get("/sessions/:sessionId", auth, async (req, res) => {
  try {
    const session = await getCallAgentSession({
      userId: req.user._id,
      sessionId: req.params.sessionId,
    });
    return res.json({ session });
  } catch (error) {
    return sendError(res, error, "Failed to load session.");
  }
});

router.get("/sessions/:sessionId/extract", auth, async (req, res) => {
  try {
    const data = await extractCallAgentSessionData({
      userId: req.user._id,
      sessionId: req.params.sessionId,
    });
    return res.json(data);
  } catch (error) {
    return sendError(res, error, "Failed to extract session.");
  }
});

router.patch("/sessions/:sessionId", auth, async (req, res) => {
  try {
    const session = await updateCallAgentSession({
      userId: req.user._id,
      sessionId: req.params.sessionId,
      data: req.body || {},
    });
    return res.json({ session });
  } catch (error) {
    return sendError(res, error, "Failed to update session.");
  }
});

router.post("/sessions/:sessionId/summarize", auth, async (req, res) => {
  try {
    const report = await summarizeCallAgentSession({
      userId: req.user._id,
      sessionId: req.params.sessionId,
    });
    return res.json({ summaryReport: report });
  } catch (error) {
    return sendError(res, error, "Failed to summarize the call.");
  }
});

router.post("/transcribe-dictation", auth, async (req, res) => {
  try {
    const body = req.body || {};
    const result = await transcribeDictation({
      userId: req.user._id,
      audioBase64: body.audioBase64,
      mimeType: body.mimeType,
      audioDurationSec: body.audioDurationSec,
      language: body.language || body.yourLanguage,
    });
    return res.json(result);
  } catch (error) {
    if (error.code === "INSUFFICIENT_CALL_TIME" || error.status === 402) {
      return res.status(error.status || 402).json(jsonPlanError(error));
    }
    if (error.code === "XAI_NOT_CONFIGURED" || error.status === 503) {
      return res.status(503).json({
        error: "Grok is not configured.",
        code: "XAI_NOT_CONFIGURED",
      });
    }
    return sendError(res, error, "Failed to transcribe dictation.");
  }
});

function sendFillError(res, error, fallbackMessage) {
  if (error.code === "INSUFFICIENT_CALL_TIME" || error.status === 402) {
    return res.status(error.status || 402).json(jsonPlanError(error));
  }
  if (error.code === "XAI_NOT_CONFIGURED" || error.status === 503) {
    return res.status(503).json({
      error: "Grok is not configured.",
      code: "XAI_NOT_CONFIGURED",
    });
  }
  return sendError(res, error, fallbackMessage);
}

router.post("/fill-brief", auth, async (req, res) => {
  try {
    const body = req.body || {};
    const result = await fillCallBrief({
      userId: req.user._id,
      notes: body.notes,
      audioBase64: body.audioBase64,
      mimeType: body.mimeType,
      audioDurationSec: body.audioDurationSec,
      language: body.language || body.yourLanguage,
      existingGoal: body.existingGoal || body.goal,
      existingRules: body.existingRules || body.rules,
      existingInformation: body.existingInformation || body.information,
    });
    return res.json(result);
  } catch (error) {
    return sendFillError(res, error, "Failed to fill the brief.");
  }
});

router.post("/apply-follow-ups", auth, async (req, res) => {
  try {
    const body = req.body || {};
    const result = await applyBriefFollowUps({
      userId: req.user._id,
      notes: body.notes,
      audioBase64: body.audioBase64,
      mimeType: body.mimeType,
      audioDurationSec: body.audioDurationSec,
      language: body.language || body.yourLanguage,
      existingGoal: body.existingGoal || body.goal,
      existingRules: body.existingRules || body.rules,
      existingInformation: body.existingInformation || body.information,
      calling: body.calling,
      answers: body.answers,
    });
    return res.json(result);
  } catch (error) {
    return sendFillError(res, error, "Failed to add those details to the brief.");
  }
});

router.post("/compose-instructions", auth, (req, res) => {
  const body = req.body || {};
  res.json({
    instructions: composeCallAgentInstructions(body),
  });
});

router.post("/translate", auth, async (req, res) => {
  try {
    const { text, fromLanguage, toLanguage } = req.body || {};
    const result = await translateText({ text, fromLanguage, toLanguage });
    return res.json(result);
  } catch (error) {
    return sendError(res, error, "Failed to translate.");
  }
});

export default router;
