import { User } from "../models/user.js";
import {
  MONTHLY_SUBSCRIPTION_CREDITS,
  FREE_MONTHLY_CREDITS,
  publicCreditCalculator,
  publicCreditTopUp,
  formatCallTime,
} from "./creditCalculator.js";
import { addCreditLot, expireAndSyncBalance } from "./creditLots.js";
import { isStripeTopUpConfigured } from "./stripeClient.js";

export const UPGRADE_PATH = "/pricing.html";

export const PLANS = {
  free: {
    id: "free",
    name: "Free",
    priceGbp: 0,
    priceLabel: "£0",
    interval: "month",
    ai: false,
    monthlyCredits: FREE_MONTHLY_CREDITS,
    monthlySeconds: FREE_MONTHLY_CREDITS,
    blurb: "Look around, write a brief, save templates. Testing minutes will be added later.",
    features: [
      "Open the app and set up a call brief",
      "Save templates and review past sessions",
      "2 minutes per month for testing (not granted yet)",
    ],
    exclusions: ["Paid call time is not included yet"],
  },
  pro: {
    id: "pro",
    name: "Paid",
    priceGbp: 12,
    priceLabel: "£12",
    interval: "month",
    ai: true,
    monthlyCredits: MONTHLY_SUBSCRIPTION_CREDITS,
    monthlySeconds: MONTHLY_SUBSCRIPTION_CREDITS,
    blurb: "One hour of live translated calling each month, with you on speakerphone.",
    features: [
      "1 hour of call time each month",
      "Live transcript and translation into your language",
      "Jump in on speakerphone; missing facts go through you",
      "Saved transcript and a post-call report",
      "Voice templates and saved sessions",
      "Credits expire 30 days after they are added",
      "Everything in Free",
    ],
    exclusions: [],
  },
};

export function listPublicPlans() {
  return [PLANS.free, PLANS.pro];
}

export function getPlanById(id) {
  const key = String(id || "free").toLowerCase();
  return PLANS[key] || PLANS.free;
}

export const PRO_STATUSES = new Set(["active", "trialing", "past_due"]);

export function planIdFromUser(user) {
  const tier = String(user?.subscriptionTier || "free").toLowerCase();
  const status = String(user?.subscriptionStatus || "none").toLowerCase();
  if (tier === "pro" && PRO_STATUSES.has(status)) return "pro";
  return "free";
}

export function getUserPlan(user) {
  return getPlanById(planIdFromUser(user));
}

export function hasAiAccess(user) {
  return getUserPlan(user).ai === true;
}

export function planError(code, message, status = 403) {
  const err = new Error(message);
  err.code = code;
  err.status = status;
  return err;
}

export function jsonPlanError(err) {
  return {
    message: err.message,
    error: err.message,
    code: err.code || "PLAN_LIMIT",
    upgradeUrl: UPGRADE_PATH,
  };
}

export async function loadBillingUser(userId) {
  if (!userId) return null;
  return User.findById(userId).select(
    "subscriptionTier subscriptionStatus token_credit_balance subscriptionStartedAt stripeCustomerId stripeSubscriptionId cancelAtPeriodEnd subscriptionCurrentPeriodEnd",
  );
}

export async function assertCallAccess(userId) {
  const user = await loadBillingUser(userId);
  if (!user) {
    throw planError("USER_NOT_FOUND", "User not found.", 404);
  }
  const synced = await expireAndSyncBalance(userId);
  const balance = synced.success ? synced.balance : user.token_credit_balance ?? 0;
  if (balance < 1) {
    throw planError(
      "INSUFFICIENT_CALL_TIME",
      "You do not have any call time left. Upgrade to Paid for one hour a month, or ask an admin to add credits.",
      402,
    );
  }
  return { user, plan: getUserPlan(user), balance };
}

export async function getBillingSnapshot(userId) {
  const user = await loadBillingUser(userId);
  if (!user) return null;
  const plan = getUserPlan(user);
  const synced = await expireAndSyncBalance(userId);
  const credits = synced.success ? synced.balance : user.token_credit_balance ?? 0;
  return {
    plan: plan.id,
    planName: plan.name,
    priceGbp: plan.priceGbp,
    status: user.subscriptionStatus || "none",
    ai: plan.ai,
    monthlyCredits: plan.monthlyCredits,
    monthlySeconds: plan.monthlySeconds,
    remainingSeconds: credits,
    remainingLabel: formatCallTime(credits),
    credits,
    cancelAtPeriodEnd: Boolean(user.cancelAtPeriodEnd),
    currentPeriodEnd: user.subscriptionCurrentPeriodEnd || null,
    hasStripeCustomer: Boolean(user.stripeCustomerId),
    upgradeUrl: UPGRADE_PATH,
    creditCalculator: publicCreditCalculator(),
    creditTopUp: publicCreditTopUp(),
    creditTopUpEnabled: isStripeTopUpConfigured(),
  };
}

export async function grantProPlanLocally(
  userId,
  { credits = PLANS.pro.monthlyCredits, status = "active" } = {},
) {
  const user = await User.findById(userId);
  if (!user) {
    throw planError("USER_NOT_FOUND", "User not found.", 404);
  }
  const startedAt = user.subscriptionStartedAt || new Date();
  await User.findByIdAndUpdate(userId, {
    $set: {
      subscriptionTier: "pro",
      subscriptionStatus: status,
      subscriptionStartedAt: startedAt,
    },
  });
  const grantAmount = Math.max(0, Math.round(Number(credits) || 0));
  if (grantAmount > 0) {
    await addCreditLot(userId, grantAmount, {
      invoiceId: `local-${String(userId)}-${Date.now()}`,
      source: "local-grant",
      purchaseMethod: "Local Paid grant",
      billingReason: "local_pro_grant",
    });
  }
  const updated = await User.findById(userId);
  return { user: updated, grantedCredits: grantAmount };
}
