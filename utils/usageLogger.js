import { UsageRecord } from "../models/usageRecord.js";
import { deductCredits, checkCredits } from "./userCredits.js";
import {
  calculateXaiSttCost,
  calculateXaiUsageCost,
  extractXaiUsageMetrics,
} from "./xaiUsageMetrics.js";
import {
  creditsFromCallSeconds,
  creditsFromUsdCost,
  estimatedCreditsForCall,
  usdFromCallSeconds,
} from "./creditCalculator.js";

export const CREDIT_BALANCE_CALL_TYPES = [
  "admin-credit-change",
  "stripe-credit-grant",
  "stripe-credit-clawback",
];

export async function logCreditBalanceChange({
  userId,
  previousBalance,
  newBalance,
  callType = "admin-credit-change",
  metadata = {},
} = {}) {
  if (!userId) return null;
  const prev = Number(previousBalance) || 0;
  const next = Number(newBalance) || 0;
  if (prev === next) return null;
  return UsageRecord.create({
    userId,
    callType,
    model: "",
    cost: 0,
    creditsDeducted: 0,
    totalTokens: 0,
    success: true,
    metadata: {
      ...metadata,
      previousBalance: prev,
      newBalance: next,
      delta: next - prev,
    },
  });
}

export function getEstimatedCreditUsage(callType, extras) {
  return estimatedCreditsForCall(callType, extras);
}

async function deductUsdAsCallTime({
  userId,
  costUsd,
  callType,
  reason,
  skipDeduct,
}) {
  const credits = creditsFromUsdCost(costUsd);
  if (!userId || credits <= 0 || skipDeduct) {
    return { credits, deducted: 0, newBalance: null, success: skipDeduct };
  }
  let result = await deductCredits(userId, credits, { reason, callType });
  if (!result.success && Number(result.balance) > 0) {
    result = await deductCredits(userId, Number(result.balance), {
      reason,
      callType,
    });
  }
  return {
    credits,
    deducted: result.success ? result.amountDeducted || credits : 0,
    newBalance: result.newBalance,
    success: Boolean(result.success),
  };
}

export async function preFlightCreditCheck({
  userId,
  callType,
  durationSec,
}) {
  if (!userId) return { allowed: true, estimatedCredits: 0, noUser: true };
  const estimate = estimatedCreditsForCall(callType, { durationSec });
  const result = await checkCredits(userId, estimate);
  if (!result.sufficient) {
    return {
      allowed: false,
      balance: result.balance,
      estimatedCredits: estimate,
      shortfall: result.shortfall,
      error: "Insufficient credits",
    };
  }
  return {
    allowed: true,
    balance: result.balance,
    estimatedCredits: estimate,
  };
}

export async function logLlmUsage({
  userId,
  callType,
  model,
  usage = {},
  metadata = {},
  success = true,
  skipDeduct = true,
}) {
  const metrics = extractXaiUsageMetrics(usage);
  const inputTokens = metrics.inputTokens;
  const outputTokens = metrics.outputTokens;
  const cachedInputTokens = metrics.cachedInputTokens;
  const reasoningTokens = metrics.reasoningTokens;
  const totalTokens =
    metrics.totalTokens || inputTokens + outputTokens + reasoningTokens;
  const costInfo = calculateXaiUsageCost({
    model,
    inputTokens,
    outputTokens,
    cachedInputTokens,
    reasoningTokens,
    costInUsdTicks: usage.cost_in_usd_ticks ?? metrics.costInUsdTicks,
  });
  const cost = costInfo.totalCost || 0;
  const billed = await deductUsdAsCallTime({
    userId,
    costUsd: cost,
    callType,
    reason: callType || "grok-inference",
    skipDeduct,
  });

  await UsageRecord.create({
    userId: userId || undefined,
    callType,
    model: model || "",
    inputTokens,
    outputTokens,
    cachedInputTokens,
    reasoningTokens,
    totalTokens,
    cost,
    creditsDeducted: billed.deducted,
    success,
    metadata: {
      ...metadata,
      xaiUsage: usage && typeof usage === "object" ? usage : {},
      skipDeduct,
      costSource: costInfo.costSource,
      inputCost: costInfo.inputCost,
      outputCost: costInfo.outputCost,
      cachedCost: costInfo.cachedCost,
    },
  });

  return {
    credits: billed.deducted,
    deducted: billed.deducted > 0,
    newBalance: billed.newBalance,
    cost,
    metrics,
  };
}

export async function logVoiceUsage({
  userId,
  durationSec,
  model = "grok-voice-latest",
  metadata = {},
  skipDeduct = false,
} = {}) {
  const seconds = Math.max(0, Number(durationSec) || 0);
  const credits = creditsFromCallSeconds(seconds);
  const cost = usdFromCallSeconds(seconds);
  let deductResult = null;
  if (userId && credits > 0 && !skipDeduct) {
    deductResult = await deductCredits(userId, credits, {
      reason: "voice-call",
      callType: "voice-call",
    });
  }
  await UsageRecord.create({
    userId: userId || undefined,
    callType: "voice-call",
    model,
    durationSec: seconds,
    totalTokens: credits,
    cost,
    creditsDeducted: skipDeduct
      ? credits
      : deductResult?.success
        ? credits
        : 0,
    success: true,
    metadata,
  });
  return {
    credits,
    newBalance: deductResult?.newBalance,
    deducted: Boolean(deductResult?.success),
    durationSec: seconds,
    cost,
  };
}

export async function logTranscriptionUsage({
  userId,
  durationSec,
  model = "xai-stt-streaming",
  metadata = {},
  skipDeduct = true,
  streaming = true,
} = {}) {
  const seconds = Math.max(0, Number(durationSec) || 0);
  const cost = calculateXaiSttCost({ durationSec: seconds, streaming });
  const billed = await deductUsdAsCallTime({
    userId,
    costUsd: cost,
    callType: "transcription",
    reason: "speech-to-text",
    skipDeduct,
  });
  await UsageRecord.create({
    userId: userId || undefined,
    callType: "transcription",
    model,
    durationSec: seconds,
    totalTokens: billed.deducted,
    cost,
    creditsDeducted: billed.deducted,
    success: true,
    metadata: { ...metadata, skipDeduct, streaming },
  });
  return {
    credits: billed.deducted,
    deducted: billed.deducted > 0,
    newBalance: billed.newBalance,
    cost,
    durationSec: seconds,
  };
}
