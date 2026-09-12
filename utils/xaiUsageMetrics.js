import {
  getDefaultGrokTextModel,
  normalizeGrokTextModel,
} from "./xaiGrokModel.js";

export const XAI_COST_TICKS_PER_USD = 10_000_000_000;
/** xAI Speech-to-Speech alias for the current flagship (grok-voice-think-fast-2.0). */
export const VOICE_AGENT_MODEL = "grok-voice-latest";

/** Voice API rates from https://docs.x.ai/developers/pricing */
export const XAI_STT_REST_USD_PER_HOUR = 0.1;
export const XAI_STT_STREAM_USD_PER_HOUR = 0.2;
export const XAI_VOICE_S2S_USD_PER_MINUTE = 0.08;

/** Grok 4.3 / 4.20 family pricing (per 1M tokens). */
const GROK_43_PRICING = {
  input: 1.25,
  cachedInput: 0.2,
  output: 2.5,
};

/** Grok 4.6 / 4.5 flagship pricing (per 1M tokens). Source: xAI models page. */
const GROK_FLAGSHIP_PRICING = {
  input: 2.0,
  cachedInput: 0.5,
  output: 6.0,
};

const LEGACY_FAST_PRICING = {
  input: 0.2,
  cachedInput: 0.05,
  output: 0.5,
};

const LEGACY_GROK_4_PRICING = {
  input: 3.0,
  cachedInput: 0.75,
  output: 15.0,
};

// xAI docs: older Grok 4 / 4.1 text model slugs retired on May 15, 2026 at 12 PM PT.
const XAI_TEXT_RETIREMENT_EFFECTIVE_AT = Date.parse("2026-05-15T19:00:00.000Z");

const MODEL_PRICING = new Map([
  // Current flagship
  ["grok-4.6", GROK_FLAGSHIP_PRICING],
  ["grok-4.6-latest", GROK_FLAGSHIP_PRICING],
  ["grok-4.5", GROK_FLAGSHIP_PRICING],
  ["grok-4.5-latest", GROK_FLAGSHIP_PRICING],
  ["grok-build-latest", GROK_FLAGSHIP_PRICING],
  // Prior flagship / 4.20 family
  ["grok-4.3", GROK_43_PRICING],
  ["grok-4.3-latest", GROK_43_PRICING],
  ["latest", GROK_FLAGSHIP_PRICING],
  ["grok-4.20", GROK_43_PRICING],
  ["grok-4.20-latest", GROK_43_PRICING],
  ["grok-4.20-multi-agent-0309", GROK_43_PRICING],
  ["grok-4.20-multi-agent-latest", GROK_43_PRICING],
  ["grok-4.20-reasoning", GROK_43_PRICING],
  ["grok-4.20-non-reasoning", GROK_43_PRICING],
  ["grok-4.20-0309", GROK_43_PRICING],
  ["grok-4.20-0309-reasoning", GROK_43_PRICING],
  ["grok-4.20-0309-non-reasoning", GROK_43_PRICING],
  // Retired / legacy (pre-redirect rates)
  ["grok-4-1-fast", LEGACY_FAST_PRICING],
  ["grok-4-1-fast-reasoning", LEGACY_FAST_PRICING],
  ["grok-4-1-fast-non-reasoning", LEGACY_FAST_PRICING],
  ["grok-4-fast", LEGACY_FAST_PRICING],
  ["grok-4-fast-reasoning", LEGACY_FAST_PRICING],
  ["grok-4-fast-non-reasoning", LEGACY_FAST_PRICING],
  ["grok-code-fast-1", LEGACY_FAST_PRICING],
  ["grok-4", LEGACY_GROK_4_PRICING],
  ["grok-4-latest", LEGACY_GROK_4_PRICING],
  ["grok-4-0709", LEGACY_GROK_4_PRICING],
]);

const RETIRED_TEXT_MODELS = new Set([
  "grok-4-1-fast",
  "grok-4-1-fast-reasoning",
  "grok-4-1-fast-non-reasoning",
  "grok-4-fast",
  "grok-4-fast-reasoning",
  "grok-4-fast-non-reasoning",
  "grok-code-fast-1",
  "grok-4",
  "grok-4-latest",
  "grok-4-0709",
]);

function toFiniteNumber(value) {
  if (value === null || value === undefined || value === "") return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function firstFiniteNumber(...values) {
  for (const value of values) {
    const number = toFiniteNumber(value);
    if (number !== undefined) return number;
  }
  return 0;
}

function normalizeModelName(model) {
  return String(model || getDefaultGrokTextModel())
    .trim()
    .toLowerCase();
}

function isAfterRetirement(at) {
  const time = at ? new Date(at).getTime() : Date.now();
  return Number.isFinite(time) && time >= XAI_TEXT_RETIREMENT_EFFECTIVE_AT;
}

export function getXaiModelPricing(model, at = new Date()) {
  const defaultModel = getDefaultGrokTextModel();
  const normalized = normalizeModelName(model || defaultModel);

  if (RETIRED_TEXT_MODELS.has(normalized) && isAfterRetirement(at)) {
    // Retired models redirect to prior flagship grok-4.3 pricing per xAI.
    return {
      ...GROK_43_PRICING,
      model: "grok-4.3",
      sourceModel: normalized,
      redirected: true,
      source:
        "xAI pricing page; retired model redirect effective May 15 2026 12 PM PT",
    };
  }

  const pricing = MODEL_PRICING.get(normalized) || GROK_FLAGSHIP_PRICING;
  return {
    ...pricing,
    model: MODEL_PRICING.has(normalized) ? normalized : defaultModel,
    sourceModel: normalized,
    redirected: false,
    source: "xAI pricing page (Grok 4.6 / 4.5 / 4.3 catalog)",
  };
}

export function extractXaiUsageMetrics(usage = {}) {
  usage = usage || {};
  const promptDetails = usage.prompt_tokens_details || {};
  const inputDetails = usage.input_tokens_details || {};
  const completionDetails = usage.completion_tokens_details || {};
  const outputDetails = usage.output_tokens_details || {};

  const inputTokens = firstFiniteNumber(
    usage.prompt_tokens,
    usage.input_tokens,
    usage.prompt_text_tokens,
  );
  const outputTokens = firstFiniteNumber(
    usage.completion_tokens,
    usage.output_tokens,
  );
  const cachedInputTokens = firstFiniteNumber(
    promptDetails.cached_tokens,
    inputDetails.cached_tokens,
    usage.cached_tokens,
    usage.cache_read_input_tokens,
    usage.cached_prompt_text_tokens,
  );
  const reasoningTokens = firstFiniteNumber(
    completionDetails.reasoning_tokens,
    outputDetails.reasoning_tokens,
    usage.reasoning_tokens,
  );
  const totalTokens =
    firstFiniteNumber(usage.total_tokens) ||
    inputTokens + outputTokens + reasoningTokens;
  const costInUsdTicks = toFiniteNumber(usage.cost_in_usd_ticks);

  return {
    inputTokens,
    outputTokens,
    cachedInputTokens,
    reasoningTokens,
    totalTokens,
    costInUsdTicks,
    numServerSideToolsUsed: firstFiniteNumber(
      usage.num_server_side_tools_used,
      usage.numServerSideToolsUsed,
    ),
  };
}

export function costFromUsdTicks(costInUsdTicks) {
  const ticks = toFiniteNumber(costInUsdTicks);
  return ticks === undefined ? null : ticks / XAI_COST_TICKS_PER_USD;
}

export function calculateXaiTokenCost({
  model,
  inputTokens = 0,
  outputTokens = 0,
  cachedInputTokens = 0,
  reasoningTokens = 0,
  at = new Date(),
} = {}) {
  const pricing = getXaiModelPricing(
    model || getDefaultGrokTextModel(),
    at,
  );
  const uncachedInputTokens = Math.max(0, inputTokens - cachedInputTokens);
  const billableOutputTokens = outputTokens + reasoningTokens;

  const inputCost = (uncachedInputTokens / 1_000_000) * pricing.input;
  const cachedCost = (cachedInputTokens / 1_000_000) * pricing.cachedInput;
  const outputCost = (billableOutputTokens / 1_000_000) * pricing.output;

  return {
    totalCost: inputCost + cachedCost + outputCost,
    inputCost,
    cachedCost,
    outputCost,
    uncachedInputTokens,
    billableOutputTokens,
    pricing,
    costSource: "calculated",
  };
}

export function calculateXaiSttCost({
  durationSec = 0,
  streaming = false,
} = {}) {
  const seconds = Math.max(0, toFiniteNumber(durationSec) || 0);
  const perHour = streaming
    ? XAI_STT_STREAM_USD_PER_HOUR
    : XAI_STT_REST_USD_PER_HOUR;
  return (seconds / 3600) * perHour;
}

export function calculateXaiUsageCost({
  model,
  inputTokens = 0,
  outputTokens = 0,
  cachedInputTokens = 0,
  reasoningTokens = 0,
  costInUsdTicks,
  at = new Date(),
} = {}) {
  const exactCost = costFromUsdTicks(costInUsdTicks);
  const calculated = calculateXaiTokenCost({
    model: model || getDefaultGrokTextModel(),
    inputTokens,
    outputTokens,
    cachedInputTokens,
    reasoningTokens,
    at,
  });

  if (exactCost !== null) {
    return {
      ...calculated,
      totalCost: exactCost,
      exactCost,
      costSource: "provider",
    };
  }

  return calculated;
}

// Re-export model helpers so existing imports can stay thin.
export { getDefaultGrokTextModel, normalizeGrokTextModel };
