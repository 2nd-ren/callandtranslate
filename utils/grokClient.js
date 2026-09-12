import {
  getDefaultGrokTextModel,
  normalizeGrokReasoningEffort,
} from "./xaiGrokModel.js";
import { extractXaiUsageMetrics } from "./xaiUsageMetrics.js";

const XAI_CHAT_URL = "https://api.x.ai/v1/chat/completions";

export async function grokChatCompletion({
  messages,
  model,
  reasoningEffort = "low",
  temperature = 0.2,
  maxTokens = 2048,
  timeoutMs = 45000,
  responseFormat,
  skipReasoningEffort = false,
} = {}) {
  const apiKey = process.env.XAI_API_KEY;
  if (!apiKey) {
    const error = new Error("XAI_API_KEY is not configured");
    error.status = 503;
    error.code = "XAI_NOT_CONFIGURED";
    throw error;
  }

  const payload = {
    model: model || getDefaultGrokTextModel(),
    messages,
    temperature,
    max_tokens: maxTokens,
  };
  if (!skipReasoningEffort) {
    payload.reasoning_effort = normalizeGrokReasoningEffort(reasoningEffort, {
      tiny: true,
    });
  }
  if (responseFormat) payload.response_format = responseFormat;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(XAI_CHAT_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      const error = new Error(
        body?.error?.message || `Grok request failed (${response.status})`,
      );
      error.status = response.status;
      error.details = body;
      throw error;
    }
    const usage = body?.usage && typeof body.usage === "object" ? body.usage : {};
    const metrics = extractXaiUsageMetrics(usage);
    if (
      !metrics.inputTokens &&
      !metrics.outputTokens &&
      !metrics.reasoningTokens &&
      !metrics.totalTokens
    ) {
      console.warn(
        `[grokClient] xAI response missing usage for model ${payload.model}`,
      );
    }
    const text = body?.choices?.[0]?.message?.content || "";
    return {
      text: String(text),
      usage,
      metrics,
      raw: body,
    };
  } finally {
    clearTimeout(timer);
  }
}
