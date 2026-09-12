import express from "express";
import auth from "../middleware/auth.js";
import { User } from "../models/user.js";
import { assertCallAccess, jsonPlanError } from "../utils/plans.js";
import { logVoiceUsage } from "../utils/usageLogger.js";
import { VOICE_AGENT_MODEL } from "../utils/xaiUsageMetrics.js";
import { composeCallAgentInstructions } from "../utils/callAgentPrompt.js";
import { CALL_AGENT_DEFAULT_PROMPT } from "../utils/callAgentPrompt.js";
import { formatCallTime } from "../utils/creditCalculator.js";

const router = express.Router();

const XAI_TTS_VOICES_URL = "https://api.x.ai/v1/tts/voices";
const XAI_REALTIME_CLIENT_SECRETS_URL =
  "https://api.x.ai/v1/realtime/client_secrets";

router.get("/voices", auth, async (_req, res) => {
  try {
    const XAI_API_KEY = process.env.XAI_API_KEY;
    if (!XAI_API_KEY) {
      return res.status(503).json({ error: "Voice API not configured." });
    }
    const response = await fetch(XAI_TTS_VOICES_URL, {
      headers: { Authorization: `Bearer ${XAI_API_KEY}` },
    });
    if (!response.ok) {
      const errorText = await response.text();
      console.error("Failed to list voices from xAI:", errorText);
      return res.status(response.status).json({ error: "Failed to list voices." });
    }
    const data = await response.json();
    return res.json(data);
  } catch (err) {
    console.error("Voice voices error:", err);
    return res.status(500).json({ error: "Failed to list voices." });
  }
});

router.post("/token", auth, async (req, res) => {
  try {
    await assertCallAccess(req.user._id);
  } catch (err) {
    return res.status(err.status || 403).json(jsonPlanError(err));
  }

  try {
    const XAI_API_KEY = process.env.XAI_API_KEY;
    if (!XAI_API_KEY) {
      return res.status(503).json({ error: "Voice API not configured." });
    }

    const response = await fetch(XAI_REALTIME_CLIENT_SECRETS_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${XAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        expires_after: { seconds: 300 },
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error("Failed to get voice token from xAI:", errorText);
      return res.status(response.status).json({ error: "Failed to get voice token." });
    }

    const tokenData = await response.json();
    const clientSecretValue =
      tokenData?.value ||
      tokenData?.client_secret?.value ||
      tokenData?.client_secret ||
      tokenData?.secret ||
      tokenData?.token ||
      null;
    if (!clientSecretValue) {
      return res.status(502).json({ error: "Voice token response was incomplete." });
    }

    const body = req.body || {};
    return res.json({
      ...tokenData,
      value: clientSecretValue,
      client_secret: { value: clientSecretValue },
      model: VOICE_AGENT_MODEL,
      instructions: composeCallAgentInstructions({
        prompt: body.prompt || CALL_AGENT_DEFAULT_PROMPT,
        goal: body.goal,
        rules: body.rules,
        information: body.information,
        yourName: body.yourName,
        yourLanguage: body.yourLanguage,
        theirLanguage: body.theirLanguage,
        discloseAi: body.discloseAi,
      }),
    });
  } catch (err) {
    console.error("Voice token error:", err);
    return res.status(500).json({ error: "Failed to get voice token." });
  }
});

router.post("/session/open", auth, async (req, res) => {
  const user = await User.findById(req.user._id).select("name email");
  const userName = user?.name || user?.email || req.user._id;
  console.log("VOICE SESSION OPENED", userName, new Date().toISOString());
  return res.json({ success: true });
});

router.post("/session/close", auth, async (req, res) => {
  const { durationSec, source } = req.body || {};
  const seconds = Math.max(0, Number(durationSec) || 0);
  const result = seconds
    ? await logVoiceUsage({
        userId: req.user._id,
        durationSec: seconds,
        metadata: { source: source || "call-agent" },
      })
    : { credits: 0, deducted: false, newBalance: null, cost: 0 };

  return res.json({
    success: true,
    durationSec: seconds,
    durationLabel: formatCallTime(seconds),
    creditsDeducted: result.credits || 0,
    newBalance: result.newBalance,
    cost: result.cost || 0,
  });
});

export default router;
