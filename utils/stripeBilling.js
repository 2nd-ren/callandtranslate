/**
 * Stripe billing for credit-based Pro subscriptions.
 *
 * Methodology matches EventAnnouncer:
 * - Hosted Checkout Session (mode: subscription) for first payment
 * - Fulfillment in webhooks, not on the success page
 * - Credits are granted only after money is collected:
 *   Checkout payment_status === "paid", or invoice.paid with amount_paid > 0
 * - invoice.paid adds the monthly allotment (idempotent per invoice)
 * - Credits expire 30 days after they are added
 * - Cancel at period end / reactivate via Billing APIs
 *
 * AI usage depletes FIFO credit lots in usageLogger.js / creditLots.js.
 */

import { User } from "../models/user.js";
import { ProcessedStripeEvent } from "../models/processedStripeEvent.js";
import { logCreditBalanceChange } from "./usageLogger.js";
import { addCreditLot, clawBackCredits } from "./creditLots.js";
import { CreditGrant } from "../models/creditGrant.js";
import {
  sendSubscriptionWelcomeIfNeeded,
} from "./subscriptionWelcomeEmail.js";
import {
  sendCancellationFeedbackIfNeeded,
  clearCancellationFeedbackFlag,
} from "./subscriptionCancelEmail.js";
import {
  sendCreditPurchaseEmail,
  formatGbpFromPence,
} from "./creditPurchaseEmail.js";
import {
  PLANS,
  PRO_STATUSES,
  getPlanById,
  planError,
} from "./plans.js";
import {
  CREDIT_TOPUP_CREDITS,
  CREDIT_TOPUP_MAX_PACKS,
  CREDIT_TOPUP_PRICE_PENCE,
  publicCreditTopUp,
} from "./creditCalculator.js";
import { getAppBaseUrl } from "./appBaseUrl.js";
import { notifyInfoOps } from "./opsNotify.js";
import {
  getStripe,
  getStripePriceId,
  getStripePublishableKey,
  getStripeWebhookSecret,
  isStripeCheckoutConfigured,
  isStripeTopUpConfigured,
  randomIntegrationSuffix,
} from "./stripeClient.js";

export const PAID_PLAN_ID = "pro";
export const CREDIT_TOPUP_TYPE = "credit_topup";

export const STRIPE_WEBHOOK_EVENTS = [
  "checkout.session.completed",
  "checkout.session.async_payment_succeeded",
  "checkout.session.async_payment_failed",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "invoice.paid",
  "invoice.payment_failed",
  "charge.refunded",
  "charge.dispute.created",
  "charge.dispute.closed",
];

function stripeId(value) {
  if (!value) return "";
  if (typeof value === "string") return value;
  return String(value.id || "");
}

function periodFromSubscription(subscription) {
  const item = subscription?.items?.data?.[0];
  const startSec =
    subscription?.current_period_start || item?.current_period_start;
  const endSec = subscription?.current_period_end || item?.current_period_end;
  return {
    start: startSec ? new Date(Number(startSec) * 1000) : null,
    end: endSec ? new Date(Number(endSec) * 1000) : null,
  };
}

function priceIdFromSubscription(subscription) {
  const price = subscription?.items?.data?.[0]?.price;
  return stripeId(price);
}

export function subscriptionIdFromInvoice(invoice) {
  const direct = stripeId(invoice?.subscription);
  if (direct) return direct;
  const parentSub = invoice?.parent?.subscription_details?.subscription;
  return stripeId(parentSub);
}

function shouldGrantCreditsForInvoice(invoice) {
  const reason = String(invoice?.billing_reason || "");
  if (
    reason === "subscription_create" ||
    reason === "subscription_cycle"
  ) {
    return true;
  }
  if (!reason && subscriptionIdFromInvoice(invoice)) return true;
  return false;
}

/** True only when Checkout collected money. `no_payment_required` is not paid. */
export function checkoutPaymentCollected(session) {
  if (String(session?.payment_status || "") !== "paid") return false;
  const total = Number(session?.amount_total);
  if (Number.isFinite(total) && total <= 0) return false;
  return true;
}

/** True only when the invoice collected money. £0 / 100% off invoices do not grant. */
export function invoicePaymentCollected(invoice) {
  const amountPaid = Number(invoice?.amount_paid);
  return Number.isFinite(amountPaid) && amountPaid > 0;
}

async function findUserFromStripe({ userId, customerId }) {
  if (userId) {
    const byId = await User.findById(userId);
    if (byId) return byId;
  }
  if (customerId) {
    return User.findOne({ stripeCustomerId: customerId });
  }
  return null;
}

export async function getOrCreateStripeCustomer(userId) {
  const stripe = getStripe();
  if (!stripe) {
    throw planError(
      "STRIPE_NOT_CONFIGURED",
      "Stripe is not configured.",
      503,
    );
  }

  const user = await User.findById(userId).select(
    "email name stripeCustomerId",
  );
  if (!user) {
    throw planError("USER_NOT_FOUND", "User not found.", 404);
  }

  if (user.stripeCustomerId) {
    try {
      const existing = await stripe.customers.retrieve(user.stripeCustomerId);
      if (existing && !existing.deleted) return existing;
    } catch (err) {
      console.warn(
        `[Stripe] Customer ${user.stripeCustomerId} missing, creating a new one: ${err.message}`,
      );
    }
  }

  const customer = await stripe.customers.create({
    email: user.email,
    name: user.name,
    metadata: { userId: String(user._id) },
  });

  await User.updateOne(
    { _id: user._id },
    { $set: { stripeCustomerId: customer.id } },
  );

  return customer;
}

export async function syncUserFromSubscription(user, stripeSub) {
  if (!user || !stripeSub) return null;
  const status = String(stripeSub.status || "none");
  const paid = PRO_STATUSES.has(status);
  const period = periodFromSubscription(stripeSub);
  const customerId = stripeId(stripeSub.customer) || user.stripeCustomerId;

  const update = {
    stripeCustomerId: customerId || user.stripeCustomerId,
    stripeSubscriptionId: stripeSub.id,
    stripePriceId: priceIdFromSubscription(stripeSub) || user.stripePriceId,
    subscriptionTier: paid ? PAID_PLAN_ID : "free",
    subscriptionStatus: status,
    cancelAtPeriodEnd: Boolean(stripeSub.cancel_at_period_end),
    subscriptionCurrentPeriodEnd: period.end,
  };
  if (paid && !user.subscriptionStartedAt) {
    update.subscriptionStartedAt = new Date();
  }

  return User.findByIdAndUpdate(user._id, { $set: update }, { new: true });
}

function paymentIntentFromInvoice(invoice) {
  return (
    stripeId(invoice?.payment_intent) ||
    stripeId(invoice?.payments?.data?.[0]?.payment?.payment_intent)
  );
}

export async function grantMonthlyCredits(userId, {
  invoiceId,
  billingReason = "",
  stripeEventId = "",
  amount,
  stripePaymentIntentId = "",
  stripeCheckoutSessionId = "",
} = {}) {
  if (!userId || !invoiceId) {
    return { granted: false, reason: "missing-ids" };
  }
  const grantAmount =
    Number.isFinite(Number(amount)) && Number(amount) > 0
      ? Math.round(Number(amount))
      : PLANS.pro.monthlyCredits;

  const creditResult = await addCreditLot(userId, grantAmount, {
    invoiceId,
    billingReason,
    stripeEventId,
    source: "stripe",
    purchaseMethod: "Pro subscription",
    stripePaymentIntentId,
    stripeCheckoutSessionId,
  });
  if (!creditResult?.granted) {
    return {
      granted: false,
      duplicate: Boolean(creditResult?.duplicate),
      invoiceId,
      error: creditResult?.error,
    };
  }
  await logCreditBalanceChange({
    userId,
    previousBalance: creditResult.previousBalance,
    newBalance: creditResult.newBalance,
    callType: "stripe-credit-grant",
    metadata: {
      source: "stripe",
      reason: `stripe:${billingReason || "invoice"}:${invoiceId}`,
      invoiceId,
      billingReason,
      expiresAt: creditResult.expiresAt,
      amount: grantAmount,
    },
  });

  return { granted: true, amount: grantAmount, invoiceId };
}

async function loadMailUser(userId) {
  if (!userId) return null;
  return User.findById(userId).select(
    "name email subscriptionWelcomeEmailSentAt subscriptionCancelFeedbackEmailSentAt subscriptionTier subscriptionCurrentPeriodEnd",
  );
}

async function sendWelcomeForUser(userLike) {
  const user =
    userLike?.email && userLike?._id
      ? userLike
      : await loadMailUser(userLike?._id || userLike);
  if (!user) return;
  const result = await sendSubscriptionWelcomeIfNeeded({ user, tier: "pro" });
  if (result.reason === "send_failed") {
    console.error(
      `[Stripe] Welcome email failed for ${user._id}: ${result.error?.message || "unknown error"}`,
    );
  }
}

async function claimStripeEvent(event) {
  try {
    await ProcessedStripeEvent.create({
      eventId: event.id,
      type: event.type,
    });
    return true;
  } catch (err) {
    if (err?.code === 11000) return false;
    throw err;
  }
}

async function releaseStripeEvent(eventId) {
  await ProcessedStripeEvent.deleteOne({ eventId });
}

function isCreditTopUpSession(session) {
  const type = String(session?.metadata?.type || "").toLowerCase();
  return (
    session?.mode === "payment" &&
    (type === CREDIT_TOPUP_TYPE || type === "topup")
  );
}

function normalizePacks(value) {
  const packs = Math.round(Number(value) || 0);
  if (!Number.isFinite(packs) || packs < 1) return 1;
  return Math.min(CREDIT_TOPUP_MAX_PACKS, packs);
}

function packsFromTopUpSession(session) {
  const fromMeta = Number(session?.metadata?.packs);
  if (Number.isInteger(fromMeta) && fromMeta >= 1) {
    return normalizePacks(fromMeta);
  }
  const lineQty = Number(session?.line_items?.data?.[0]?.quantity);
  if (Number.isInteger(lineQty) && lineQty >= 1) return normalizePacks(lineQty);
  const pence = Number(session?.amount_total);
  if (Number.isFinite(pence) && pence > 0) {
    return normalizePacks(Math.round(pence / CREDIT_TOPUP_PRICE_PENCE));
  }
  return 1;
}

export async function fulfillCreditTopUp(session, eventId = "") {
  if (!session) return { skipped: true };
  if (!checkoutPaymentCollected(session)) {
    return { skipped: true, unpaid: true };
  }

  const userId = session.metadata?.userId || session.client_reference_id;
  const customerId = stripeId(session.customer);
  const user = await findUserFromStripe({ userId, customerId });
  if (!user) {
    console.warn(
      `[Stripe] Credit top-up ${session.id}: no user for customer ${customerId} / userId ${userId}`,
    );
    return { skipped: true, missingUser: true };
  }

  if (customerId && customerId !== user.stripeCustomerId) {
    await User.updateOne(
      { _id: user._id },
      { $set: { stripeCustomerId: customerId } },
    );
  }

  const packs = packsFromTopUpSession(session);
  const credits = packs * CREDIT_TOPUP_CREDITS;
  const invoiceId = `topup:${stripeId(session.id) || stripeId(session.payment_intent)}`;
  const purchasedAt = new Date();
  const creditResult = await addCreditLot(user._id, credits, {
    invoiceId,
    billingReason: CREDIT_TOPUP_TYPE,
    stripeEventId: eventId || session.id,
    source: "stripe-topup",
    purchaseMethod: "Credit top-up",
    purchasedAt,
    stripePaymentIntentId: stripeId(session.payment_intent),
    stripeCheckoutSessionId: stripeId(session.id),
  });
  if (creditResult?.duplicate) {
    return { granted: false, duplicate: true, invoiceId };
  }
  if (!creditResult?.granted) {
    return {
      granted: false,
      invoiceId,
      error: creditResult?.error,
    };
  }

  await logCreditBalanceChange({
    userId: user._id,
    previousBalance: creditResult.previousBalance,
    newBalance: creditResult.newBalance,
    callType: "stripe-credit-grant",
    metadata: {
      source: "stripe-topup",
      type: CREDIT_TOPUP_TYPE,
      invoiceId,
      packs,
      credits,
      expiresAt: creditResult.expiresAt,
      sessionId: session.id,
    },
  });

  const mailUser = await loadMailUser(user._id);
  const emailResult = await sendCreditPurchaseEmail({
    user: mailUser || user,
    credits,
    packs,
    amountPence: session.amount_total || packs * CREDIT_TOPUP_PRICE_PENCE,
    currency: session.currency || "gbp",
    purchasedAt,
    expiresAt: creditResult.expiresAt,
    newBalance: creditResult.newBalance,
  });
  if (emailResult.reason === "send_failed") {
    console.error(
      `[Stripe] Credit purchase email failed for ${user._id}: ${emailResult.error?.message || "unknown error"}`,
    );
  }

  void notifyInfoOps({
    event: "purchase_succeeded",
    user: mailUser || user,
    lines: [
      "Type: credit_topup",
      `Credits: ${credits}`,
      `Packs: ${packs}`,
      `Session: ${session.id}`,
      `Amount: ${session.amount_total ?? "n/a"} ${String(session.currency || "gbp").toUpperCase()}`,
    ],
  });

  return {
    ok: true,
    granted: true,
    userId: String(user._id),
    credits,
    packs,
    expiresAt: creditResult.expiresAt,
  };
}

export async function fulfillCheckoutSession(session, eventId = "") {
  if (!session) return { skipped: true };
  if (!checkoutPaymentCollected(session)) {
    return { skipped: true, unpaid: true };
  }
  if (isCreditTopUpSession(session)) {
    return fulfillCreditTopUp(session, eventId);
  }
  if (session.mode !== "subscription") return { skipped: true };

  const userId = session.metadata?.userId || session.client_reference_id;
  const customerId = stripeId(session.customer);
  const user = await findUserFromStripe({ userId, customerId });
  if (!user) {
    console.warn(
      `[Stripe] Checkout ${session.id}: no user for customer ${customerId} / userId ${userId}`,
    );
    return { skipped: true, missingUser: true };
  }

  const subId = stripeId(session.subscription);
  const stripe = getStripe();
  if (subId && stripe) {
    try {
      const subscription = await stripe.subscriptions.retrieve(subId);
      await syncUserFromSubscription(user, subscription);
    } catch (err) {
      console.warn(
        `[Stripe] Could not retrieve subscription ${subId}: ${err.message}`,
      );
      await User.updateOne(
        { _id: user._id },
        {
          $set: {
            stripeCustomerId: customerId || user.stripeCustomerId,
            stripeSubscriptionId: subId,
            subscriptionTier: PAID_PLAN_ID,
            subscriptionStatus: "active",
            subscriptionStartedAt: user.subscriptionStartedAt || new Date(),
          },
        },
      );
    }
  } else {
    await User.updateOne(
      { _id: user._id },
      {
        $set: {
          stripeCustomerId: customerId || user.stripeCustomerId,
          subscriptionTier: PAID_PLAN_ID,
          subscriptionStatus: "active",
          subscriptionStartedAt: user.subscriptionStartedAt || new Date(),
        },
      },
    );
  }

  const invoiceId = stripeId(session.invoice);
  if (invoiceId) {
    await grantMonthlyCredits(user._id, {
      invoiceId,
      billingReason: "subscription_create",
      stripeEventId: eventId || session.id,
      stripePaymentIntentId: stripeId(session.payment_intent),
      stripeCheckoutSessionId: stripeId(session.id),
    });
  }

  await sendWelcomeForUser(user);
  void notifyInfoOps({
    event: "purchase_succeeded",
    user,
    lines: [
      "Type: subscription",
      `Session: ${session.id}`,
      `Subscription: ${subId || "n/a"}`,
      `Amount: ${session.amount_total ?? "n/a"} ${String(session.currency || "gbp").toUpperCase()}`,
    ],
  });
  return { ok: true, userId: String(user._id) };
}

async function handleInvoicePaid(invoice, eventId = "") {
  if (!shouldGrantCreditsForInvoice(invoice)) {
    return { skipped: true };
  }
  if (!invoicePaymentCollected(invoice)) {
    return { skipped: true, unpaid: true };
  }
  const customerId = stripeId(invoice.customer);
  const user = await findUserFromStripe({
    userId: invoice.metadata?.userId || invoice.subscription_details?.metadata?.userId,
    customerId,
  });
  if (!user) {
    console.warn(`[Stripe] invoice.paid ${invoice.id}: no user for ${customerId}`);
    return { skipped: true, missingUser: true };
  }

  const subId = subscriptionIdFromInvoice(invoice);
  const stripe = getStripe();
  let synced = false;
  if (subId && stripe) {
    try {
      const subscription = await stripe.subscriptions.retrieve(subId);
      await syncUserFromSubscription(user, subscription);
      synced = true;
    } catch (err) {
      console.warn(
        `[Stripe] invoice.paid could not retrieve sub ${subId}: ${err.message}`,
      );
    }
  }
  if (!synced) {
    await User.updateOne(
      { _id: user._id },
      {
        $set: {
          stripeCustomerId: customerId || user.stripeCustomerId,
          stripeSubscriptionId: subId || user.stripeSubscriptionId,
          subscriptionTier: PAID_PLAN_ID,
          subscriptionStatus: "active",
          subscriptionStartedAt: user.subscriptionStartedAt || new Date(),
        },
      },
    );
  }

  const granted = await grantMonthlyCredits(user._id, {
    invoiceId: invoice.id,
    billingReason: invoice.billing_reason || "subscription_cycle",
    stripeEventId: eventId,
    stripePaymentIntentId: paymentIntentFromInvoice(invoice),
  });
  await sendWelcomeForUser(user);
  return granted;
}

async function handleInvoicePaymentFailed(invoice) {
  const customerId = stripeId(invoice.customer);
  const user = await findUserFromStripe({ customerId });
  if (!user) return;
  await User.updateOne(
    { _id: user._id },
    { $set: { subscriptionStatus: "past_due" } },
  );
}

async function handleSubscriptionDeleted(stripeSub) {
  const customerId = stripeId(stripeSub.customer);
  const user = await findUserFromStripe({
    userId: stripeSub.metadata?.userId,
    customerId,
  });
  if (!user) return;
  const previousTier = user.subscriptionTier || "pro";
  const periodEnd = user.subscriptionCurrentPeriodEnd || null;
  await User.updateOne(
    { _id: user._id },
    {
      $set: {
        subscriptionTier: "free",
        subscriptionStatus: "canceled",
        cancelAtPeriodEnd: false,
        stripeSubscriptionId: stripeSub.id || user.stripeSubscriptionId,
      },
    },
  );
  const result = await sendCancellationFeedbackIfNeeded({
    user,
    tier: previousTier,
    periodEnd,
    stage: "ended",
  });
  if (result.reason === "send_failed") {
    console.error(
      `[Stripe] Cancel email failed for ${user._id}: ${result.error?.message || "unknown error"}`,
    );
  }
  void notifyInfoOps({
    event: "subscription_canceled",
    user,
    lines: [
      `Previous tier: ${previousTier}`,
      periodEnd ? `Period end: ${new Date(periodEnd).toISOString()}` : null,
      `Subscription: ${stripeSub.id || user.stripeSubscriptionId || "n/a"}`,
    ].filter(Boolean),
  });
}

function refundedAmountFromCharge(charge) {
  const refunded = Number(charge?.amount_refunded);
  if (Number.isFinite(refunded) && refunded > 0) return refunded;
  const nested = (charge?.refunds?.data || []).reduce(
    (sum, row) => sum + (Number(row?.amount) || 0),
    0,
  );
  return nested;
}

function creditsToClawFromLot(lot, { paidAmount, reversedAmount }) {
  const grant = Math.max(0, Number(lot?.amount) || 0);
  const remaining = Math.max(0, Number(lot?.remaining) || 0);
  const already = Math.max(0, Number(lot?.clawed) || 0);
  const paid = Number(paidAmount);
  const reversed = Number(reversedAmount);
  let target = remaining;
  if (Number.isFinite(paid) && paid > 0 && Number.isFinite(reversed) && reversed >= 0) {
    const fraction = Math.min(1, reversed / paid);
    target = Math.round(grant * fraction);
  }
  return Math.max(0, Math.min(remaining, target - already));
}

async function loadCharge(chargeOrId) {
  if (chargeOrId && typeof chargeOrId === "object" && chargeOrId.id) {
    return chargeOrId;
  }
  const id = stripeId(chargeOrId);
  const stripe = getStripe();
  if (!id || !stripe) return null;
  try {
    return await stripe.charges.retrieve(id);
  } catch (err) {
    console.warn(`[Stripe] Could not retrieve charge ${id}: ${err.message}`);
    return null;
  }
}

async function checkoutSessionForPaymentIntent(paymentIntentId) {
  const pi = stripeId(paymentIntentId);
  const stripe = getStripe();
  if (!pi || !stripe) return null;
  try {
    const listed = await stripe.checkout.sessions.list({
      payment_intent: pi,
      limit: 1,
    });
    return listed.data?.[0] || null;
  } catch (err) {
    console.warn(
      `[Stripe] Could not list Checkout sessions for ${pi}: ${err.message}`,
    );
    return null;
  }
}

async function findCreditLotForCharge(user, charge, session = null) {
  if (!user?._id) return null;
  const invoiceId = stripeId(charge?.invoice);
  const paymentIntentId = stripeId(charge?.payment_intent);
  const sessionId = stripeId(session?.id);
  const invoiceIds = [
    invoiceId,
    paymentIntentId ? `topup:${paymentIntentId}` : "",
    sessionId ? `topup:${sessionId}` : "",
  ].filter(Boolean);
  if (invoiceIds.length) {
    const byInvoice = await CreditGrant.findOne({
      userId: user._id,
      invoiceId: { $in: invoiceIds },
    });
    if (byInvoice) return byInvoice;
  }
  if (paymentIntentId) {
    const byPi = await CreditGrant.findOne({
      userId: user._id,
      stripePaymentIntentId: paymentIntentId,
    });
    if (byPi) return byPi;
  }
  if (sessionId) {
    const bySession = await CreditGrant.findOne({
      userId: user._id,
      stripeCheckoutSessionId: sessionId,
    });
    if (bySession) return bySession;
  }
  return null;
}

async function notifyClawback({
  kind,
  user,
  charge,
  dispute,
  lot,
  clawed,
  alreadyUsed,
  newBalance,
  missingLot = false,
}) {
  const amount = Number(charge?.amount) || 0;
  const reversed =
    kind === "dispute"
      ? Number(dispute?.amount) || amount
      : refundedAmountFromCharge(charge);
  const currency = charge?.currency || dispute?.currency || "gbp";
  void notifyInfoOps({
    event: kind === "dispute" ? "stripe_dispute" : "stripe_refund",
    subject: `[Call & Translate] ${kind === "dispute" ? "Dispute" : "Refund"} — ${clawed || 0} credits clawed`,
    user,
    lines: [
      `Kind: ${kind}`,
      charge?.id ? `Charge: ${charge.id}` : null,
      dispute?.id ? `Dispute: ${dispute.id}` : null,
      dispute?.reason ? `Dispute reason: ${dispute.reason}` : null,
      dispute?.status ? `Dispute status: ${dispute.status}` : null,
      `Paid: ${formatGbpFromPence(amount, currency)}`,
      `Reversed: ${formatGbpFromPence(reversed, currency)}`,
      lot?.invoiceId ? `Credit lot: ${lot.invoiceId}` : null,
      lot?.purchaseMethod ? `Purchase: ${lot.purchaseMethod}` : null,
      missingLot ? "No matching credit lot — nothing clawed automatically." : null,
      `Credits clawed now: ${Number(clawed) || 0}`,
      `Credits already used from that purchase: ${Number(alreadyUsed) || 0}`,
      `User balance now: ${Number(newBalance) || 0}`,
    ].filter(Boolean),
  });
}

async function clawBackForCharge({
  charge,
  reversedAmount,
  kind,
  dispute = null,
}) {
  if (!charge) return { skipped: true, missingCharge: true };
  const customerId = stripeId(charge.customer);
  const user = await findUserFromStripe({
    userId: charge.metadata?.userId,
    customerId,
  });
  if (!user) {
    void notifyInfoOps({
      event: kind === "dispute" ? "stripe_dispute" : "stripe_refund",
      subject: `[Call & Translate] ${kind === "dispute" ? "Dispute" : "Refund"} — no matching user`,
      lines: [
        `Kind: ${kind}`,
        charge.id ? `Charge: ${charge.id}` : null,
        customerId ? `Customer: ${customerId}` : null,
        "No app user for this Stripe customer.",
      ].filter(Boolean),
    });
    return { skipped: true, missingUser: true };
  }

  let session = null;
  if (charge.payment_intent) {
    session = await checkoutSessionForPaymentIntent(charge.payment_intent);
  }
  const lot = await findCreditLotForCharge(user, charge, session);
  if (!lot) {
    await notifyClawback({
      kind,
      user,
      charge,
      dispute,
      lot: null,
      clawed: 0,
      alreadyUsed: 0,
      newBalance: user.token_credit_balance,
      missingLot: true,
    });
    return { skipped: true, missingLot: true, userId: String(user._id) };
  }

  const amount = creditsToClawFromLot(lot, {
    paidAmount: charge.amount,
    reversedAmount,
  });
  const result = await clawBackCredits(user._id, {
    lot,
    amount,
    reason: kind,
  });
  if (result.success && result.clawed > 0) {
    await logCreditBalanceChange({
      userId: user._id,
      previousBalance: result.previousBalance,
      newBalance: result.newBalance,
      callType: "stripe-credit-clawback",
      metadata: {
        source: "stripe-clawback",
        kind,
        invoiceId: result.invoiceId,
        chargeId: charge.id,
        disputeId: dispute?.id || "",
        clawed: result.clawed,
        alreadyUsed: result.alreadyUsed,
      },
    });
  }

  await notifyClawback({
    kind,
    user,
    charge,
    dispute,
    lot,
    clawed: result.clawed || 0,
    alreadyUsed: result.alreadyUsed || 0,
    newBalance: result.newBalance ?? user.token_credit_balance,
  });

  return {
    ok: true,
    clawed: result.clawed || 0,
    userId: String(user._id),
    invoiceId: result.invoiceId || lot.invoiceId,
  };
}

async function handleChargeRefunded(charge) {
  const reversed = refundedAmountFromCharge(charge);
  if (!reversed) return { skipped: true, unpaid: true };
  return clawBackForCharge({
    charge,
    reversedAmount: reversed,
    kind: "refund",
  });
}

async function handleDisputeCreated(dispute) {
  const charge = await loadCharge(dispute?.charge);
  const reversed = Number(dispute?.amount) || Number(charge?.amount) || 0;
  return clawBackForCharge({
    charge,
    reversedAmount: reversed,
    kind: "dispute",
    dispute,
  });
}

async function handleDisputeClosed(dispute) {
  const charge = await loadCharge(dispute?.charge);
  const customerId = stripeId(charge?.customer);
  const user = await findUserFromStripe({ customerId });
  void notifyInfoOps({
    event: "stripe_dispute_closed",
    subject: `[Call & Translate] Dispute ${dispute?.status || "closed"}`,
    user,
    lines: [
      `Status: ${dispute?.status || "unknown"}`,
      dispute?.id ? `Dispute: ${dispute.id}` : null,
      charge?.id ? `Charge: ${charge.id}` : null,
      dispute?.reason ? `Reason: ${dispute.reason}` : null,
      String(dispute?.status || "") === "won"
        ? "Dispute won. Credits were already clawed when it opened; restore manually if you want to return them."
        : "Dispute closed. Remaining credits from that purchase should already have been clawed.",
    ].filter(Boolean),
  });
  return { ok: true, status: dispute?.status || "closed" };
}

/**
 * Process a verified Stripe event. Safe to retry: event ids and invoice
 * credit grants are unique.
 */
export async function handleStripeEvent(event) {
  if (!event?.id || !event?.type) return { skipped: true };
  const claimed = await claimStripeEvent(event);
  if (!claimed) return { duplicate: true, eventId: event.id };

  try {
    switch (event.type) {
      case "checkout.session.completed":
      case "checkout.session.async_payment_succeeded": {
        await fulfillCheckoutSession(event.data.object, event.id);
        break;
      }
      case "checkout.session.async_payment_failed": {
        console.warn(
          `[Stripe] Checkout async payment failed: ${event.data.object?.id}`,
        );
        break;
      }
      case "customer.subscription.created":
      case "customer.subscription.updated": {
        const stripeSub = event.data.object;
        const user = await findUserFromStripe({
          userId: stripeSub.metadata?.userId,
          customerId: stripeId(stripeSub.customer),
        });
        if (user) await syncUserFromSubscription(user, stripeSub);
        break;
      }
      case "customer.subscription.deleted": {
        await handleSubscriptionDeleted(event.data.object);
        break;
      }
      case "invoice.paid": {
        await handleInvoicePaid(event.data.object, event.id);
        break;
      }
      case "invoice.payment_failed": {
        await handleInvoicePaymentFailed(event.data.object);
        break;
      }
      case "charge.refunded": {
        await handleChargeRefunded(event.data.object);
        break;
      }
      case "charge.dispute.created": {
        await handleDisputeCreated(event.data.object);
        break;
      }
      case "charge.dispute.closed": {
        await handleDisputeClosed(event.data.object);
        break;
      }
      default:
        break;
    }
    return { ok: true, type: event.type };
  } catch (err) {
    await releaseStripeEvent(event.id);
    throw err;
  }
}

export function constructWebhookEvent(payload, signature) {
  const stripe = getStripe();
  const secret = getStripeWebhookSecret();
  if (!stripe || !secret) {
    const err = new Error("Stripe webhook is not configured.");
    err.code = "STRIPE_NOT_CONFIGURED";
    err.status = 503;
    throw err;
  }
  return stripe.webhooks.constructEvent(payload, signature, secret);
}

export async function createCheckoutSession(userId, { plan = PAID_PLAN_ID } = {}, req) {
  const planId = String(plan || PAID_PLAN_ID).toLowerCase();
  if (planId !== PAID_PLAN_ID) {
    throw planError(
      "UNKNOWN_PLAN",
      "Choose the Pro plan to subscribe.",
      400,
    );
  }
  if (!isStripeCheckoutConfigured()) {
    throw planError("STRIPE_NOT_CONFIGURED", "Coming shortly.", 503);
  }

  const stripe = getStripe();
  const priceId = getStripePriceId(planId);
  const user = await User.findById(userId).select(
    "email name subscriptionTier subscriptionStatus stripeSubscriptionId stripeCustomerId",
  );
  if (!user) {
    throw planError("USER_NOT_FOUND", "User not found.", 404);
  }

  const currentStatus = String(user.subscriptionStatus || "none");
  if (
    String(user.subscriptionTier || "") === PAID_PLAN_ID &&
    PRO_STATUSES.has(currentStatus)
  ) {
    throw planError(
      "ALREADY_SUBSCRIBED",
      "You already have an active Pro subscription.",
      400,
    );
  }

  const customer = await getOrCreateStripeCustomer(userId);
  const baseUrl = getAppBaseUrl(req);

  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    customer: customer.id,
    client_reference_id: String(userId),
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: `${baseUrl}/subscription-success.html?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${baseUrl}/pricing.html?checkout=cancel`,
    metadata: { userId: String(userId), plan: planId },
    subscription_data: {
      metadata: { userId: String(userId), plan: planId },
    },
    customer_update: { name: "auto", address: "auto" },
    allow_promotion_codes: true,
    adaptive_pricing: { enabled: false },
    integration_identifier: `cat_pro_${randomIntegrationSuffix()}`,
  });

  return { url: session.url, id: session.id };
}

export async function createCreditTopUpCheckoutSession(
  userId,
  { packs = 1 } = {},
  req,
) {
  const quantity = normalizePacks(packs);
  if (!isStripeTopUpConfigured()) {
    throw planError("STRIPE_NOT_CONFIGURED", "Coming shortly.", 503);
  }

  const stripe = getStripe();
  const priceId = getStripePriceId("credits");
  const user = await User.findById(userId).select("email name stripeCustomerId");
  if (!user) {
    throw planError("USER_NOT_FOUND", "User not found.", 404);
  }

  const customer = await getOrCreateStripeCustomer(userId);
  const baseUrl = getAppBaseUrl(req);
  const credits = quantity * CREDIT_TOPUP_CREDITS;

  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    customer: customer.id,
    client_reference_id: String(userId),
    line_items: [{ price: priceId, quantity }],
    success_url: `${baseUrl}/subscription-success.html?type=credits&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${baseUrl}/pricing.html?credits=cancel`,
    metadata: {
      userId: String(userId),
      type: CREDIT_TOPUP_TYPE,
      packs: String(quantity),
      credits: String(credits),
    },
    custom_text: {
      submit: {
        message: `These ${credits.toLocaleString()} seconds of call time expire 30 days after purchase.`,
      },
    },
    customer_update: { name: "auto", address: "auto" },
    allow_promotion_codes: true,
    adaptive_pricing: { enabled: false },
    integration_identifier: `cat_credits_${randomIntegrationSuffix()}`,
  });

  return { url: session.url, id: session.id, packs: quantity, credits };
}

export async function createBillingPortalSession(userId, req) {
  const stripe = getStripe();
  if (!stripe) {
    throw planError(
      "STRIPE_NOT_CONFIGURED",
      "Stripe is not configured.",
      503,
    );
  }
  const user = await User.findById(userId).select("stripeCustomerId");
  if (!user?.stripeCustomerId) {
    throw planError(
      "NO_STRIPE_CUSTOMER",
      "No billing account yet. Subscribe to Pro first.",
      400,
    );
  }
  const baseUrl = getAppBaseUrl(req);
  const portal = await stripe.billingPortal.sessions.create({
    customer: user.stripeCustomerId,
    return_url: `${baseUrl}/app.html`,
  });
  return { url: portal.url };
}

export async function cancelSubscriptionAtPeriodEnd(userId) {
  const stripe = getStripe();
  if (!stripe) {
    throw planError(
      "STRIPE_NOT_CONFIGURED",
      "Stripe is not configured.",
      503,
    );
  }
  const user = await User.findById(userId).select(
    "name email stripeSubscriptionId subscriptionCurrentPeriodEnd subscriptionCancelFeedbackEmailSentAt subscriptionTier",
  );
  if (!user?.stripeSubscriptionId) {
    throw planError(
      "NO_SUBSCRIPTION",
      "No active subscription found.",
      400,
    );
  }
  const canceled = await stripe.subscriptions.update(user.stripeSubscriptionId, {
    cancel_at_period_end: true,
  });
  await syncUserFromSubscription(user, canceled);
  const periodEnd = periodFromSubscription(canceled).end;
  const result = await sendCancellationFeedbackIfNeeded({
    user,
    tier: user.subscriptionTier || "pro",
    periodEnd,
    stage: "requested",
  });
  if (result.reason === "send_failed") {
    console.error(
      `[Stripe] Cancel email failed for ${user._id}: ${result.error?.message || "unknown error"}`,
    );
  }
  void notifyInfoOps({
    event: "subscription_cancel_requested",
    user,
    lines: [
      `Tier: ${user.subscriptionTier || "pro"}`,
      periodEnd ? `Active until: ${new Date(periodEnd).toISOString()}` : null,
      `Subscription: ${user.stripeSubscriptionId}`,
    ].filter(Boolean),
  });
  return {
    success: true,
    cancelAtPeriodEnd: true,
    currentPeriodEnd: periodEnd,
    message: "Subscription will cancel at the end of the billing period.",
  };
}

export async function reactivateSubscription(userId) {
  const stripe = getStripe();
  if (!stripe) {
    throw planError(
      "STRIPE_NOT_CONFIGURED",
      "Stripe is not configured.",
      503,
    );
  }
  const user = await User.findById(userId).select(
    "stripeSubscriptionId cancelAtPeriodEnd",
  );
  if (!user?.stripeSubscriptionId) {
    throw planError(
      "NO_SUBSCRIPTION",
      "No subscription pending cancellation.",
      400,
    );
  }
  const reactivated = await stripe.subscriptions.update(
    user.stripeSubscriptionId,
    { cancel_at_period_end: false },
  );
  await syncUserFromSubscription(user, reactivated);
  await clearCancellationFeedbackFlag(user);
  return {
    success: true,
    reactivated: true,
    status: reactivated.status,
    message: "Your Pro subscription will continue.",
  };
}

export function publicStripeConfig() {
  return {
    stripePublishableKey: getStripePublishableKey() || null,
    checkoutEnabled: isStripeCheckoutConfigured(),
    creditTopUpEnabled: isStripeTopUpConfigured(),
    creditTopUp: publicCreditTopUp(),
  };
}

export function serializeSubscription(user) {
  if (!user) return null;
  const plan = getPlanById(
    PRO_STATUSES.has(String(user.subscriptionStatus || "")) &&
      user.subscriptionTier === PAID_PLAN_ID
      ? "pro"
      : "free",
  );
  return {
    tier: user.subscriptionTier || "free",
    displayName: plan.name,
    status: user.subscriptionStatus || "none",
    cancelAtPeriodEnd: Boolean(user.cancelAtPeriodEnd),
    currentPeriodEnd: user.subscriptionCurrentPeriodEnd || null,
    monthlyCredits: plan.monthlyCredits,
  };
}

export default {
  handleStripeEvent,
  constructWebhookEvent,
  createCheckoutSession,
  createCreditTopUpCheckoutSession,
  createBillingPortalSession,
  fulfillCreditTopUp,
  cancelSubscriptionAtPeriodEnd,
  reactivateSubscription,
  grantMonthlyCredits,
  fulfillCheckoutSession,
};
