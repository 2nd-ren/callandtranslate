/**
 * Call-time credits.
 *
 * 1 credit = 1 second of connected call time.
 * Paid plan grants 3,600 credits (1 hour) each billing cycle.
 * Free testing minutes are not granted yet (startingCredits = 0).
 *
 * Credits expire 30 days after they are added (FIFO lots).
 */

export const CREDITS_PER_CALL_SECOND = 1;
export const CREDIT_EXPIRY_DAYS = 30;
export const MONTHLY_SUBSCRIPTION_CREDITS = 3600;
export const FREE_MONTHLY_CREDITS = 0;
export const CREDIT_TOPUP_CREDITS = 3600;
export const CREDIT_TOPUP_PRICE_GBP = 12;
export const CREDIT_TOPUP_PRICE_PENCE = 1200;
export const CREDIT_TOPUP_MAX_PACKS = 10;
/** xAI Speech-to-Speech grok-voice-think-fast-2.0 (docs.x.ai/developers/pricing). */
export const VOICE_USD_PER_MINUTE = 0.08;
export const CHARS_PER_ESTIMATED_TOKEN = 4;
/**
 * 1 minute of the user's call time is valued at $0.0833 when converting
 * xAI STT / Grok token costs into deducted seconds.
 */
export const CREDIT_MINUTE_USD_VALUE = 0.0833;

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

export function addDays(date, days = CREDIT_EXPIRY_DAYS) {
  const next = date instanceof Date ? new Date(date) : new Date(date || Date.now());
  if (Number.isNaN(next.getTime())) {
    throw new Error("Invalid date");
  }
  const offset = Number(days);
  if (!Number.isFinite(offset) || offset <= 0) {
    throw new Error("days must be a positive number");
  }
  next.setDate(next.getDate() + offset);
  return next;
}

export function creditsFromCallSeconds(durationSec) {
  const seconds = Math.max(0, finiteNumber(durationSec));
  if (seconds <= 0) return 0;
  return Math.max(1, Math.ceil(seconds * CREDITS_PER_CALL_SECOND));
}

export function estimatedCreditsForCall(callType, { durationSec } = {}) {
  if (callType === "voice-call" || callType === "voice-agent" || callType === "transcription") {
    const seconds =
      durationSec == null || durationSec === "" ? 60 : finiteNumber(durationSec);
    return Math.max(1, creditsFromCallSeconds(seconds) || 1);
  }
  return 1;
}

export function formatCallTime(seconds) {
  const s = Math.max(0, Math.floor(finiteNumber(seconds)));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) {
    return `${h}h ${String(m).padStart(2, "0")}m`;
  }
  if (m > 0) {
    return `${m}m ${String(sec).padStart(2, "0")}s`;
  }
  return `${sec}s`;
}

export function usdFromCallSeconds(durationSec) {
  const minutes = Math.max(0, finiteNumber(durationSec)) / 60;
  return minutes * VOICE_USD_PER_MINUTE;
}

/**
 * Convert an xAI USD cost into call-time credits (seconds).
 * Always rounds up so a non-zero cost never deducts nothing.
 */
export function creditsFromUsdCost(costUsd) {
  const cost = Math.max(0, finiteNumber(costUsd));
  if (cost <= 0) return 0;
  const seconds = (cost / CREDIT_MINUTE_USD_VALUE) * 60;
  return Math.max(1, Math.ceil(Number(seconds.toFixed(6))));
}

export function publicCreditTopUp() {
  return {
    credits: CREDIT_TOPUP_CREDITS,
    seconds: CREDIT_TOPUP_CREDITS,
    minutes: CREDIT_TOPUP_CREDITS / 60,
    priceGbp: CREDIT_TOPUP_PRICE_GBP,
    pricePence: CREDIT_TOPUP_PRICE_PENCE,
    priceLabel: "£12",
    expiryDays: CREDIT_EXPIRY_DAYS,
    maxPacks: CREDIT_TOPUP_MAX_PACKS,
  };
}

export function publicCreditCalculator() {
  return {
    creditsPerSecond: CREDITS_PER_CALL_SECOND,
    expiryDays: CREDIT_EXPIRY_DAYS,
    monthlyCredits: MONTHLY_SUBSCRIPTION_CREDITS,
    freeMonthlyCredits: FREE_MONTHLY_CREDITS,
    topUp: publicCreditTopUp(),
  };
}

export default {
  CREDITS_PER_CALL_SECOND,
  CREDIT_EXPIRY_DAYS,
  MONTHLY_SUBSCRIPTION_CREDITS,
  FREE_MONTHLY_CREDITS,
  CREDIT_MINUTE_USD_VALUE,
  creditsFromCallSeconds,
  creditsFromUsdCost,
  estimatedCreditsForCall,
  formatCallTime,
  usdFromCallSeconds,
  publicCreditCalculator,
  addDays,
};
