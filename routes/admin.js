import express from "express";
import Joi from "joi";
import mongoose from "mongoose";
import rateLimit from "express-rate-limit";
import auth from "../middleware/auth.js";
import admin, { isPrivilegedUser } from "../middleware/admin.js";
import { User } from "../models/user.js";
import CallAgentSession from "../models/callAgentSession.js";
import { CreditGrant } from "../models/creditGrant.js";
import { UsageRecord } from "../models/usageRecord.js";
import { AdminActivity, recordAdminActivity } from "../models/adminActivity.js";
import { addCredits, setCredits } from "../utils/userCredits.js";
import { logCreditBalanceChange, logLlmUsage } from "../utils/usageLogger.js";
import {
  getCreditLedger,
  summarizeLotsByUserIds,
} from "../utils/creditLots.js";
import { publicCreditCalculator } from "../utils/creditCalculator.js";
import { sendAppMail, SUPPORT_MAIL_ADDRESS } from "../utils/sendMail.js";
import { buildEmailCardHtml, PRODUCT_NAME } from "../utils/emailHtml.js";
import { getAppBaseUrl } from "../utils/appBaseUrl.js";
import { grokChatCompletion } from "../utils/grokClient.js";
import {
  getDefaultGrokTextModel,
  isAllowedGrokTextModel,
  normalizeGrokTextModel,
} from "../utils/xaiGrokModel.js";
import { purgeUserData } from "../utils/accountDeletion.js";
import {
  PLANS,
  listPublicPlans,
  planIdFromUser,
  getPlanById,
  PRO_STATUSES,
} from "../utils/plans.js";
import {
  getUsageAnalytics,
  getUsageByUserIds,
} from "../utils/adminUsageAnalytics.js";

const router = express.Router();
router.use(auth, admin);

const skipInTest = () => process.env.NODE_ENV === "test";

const messageAllLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 3,
  skip: skipInTest,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: "Too many broadcast emails. Please try again later.",
    message: "Too many broadcast emails. Please try again later.",
    code: "RATE_LIMITED",
  },
});

const draftLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 20,
  skip: skipInTest,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: "Too many draft requests. Please try again later.",
    message: "Too many draft requests. Please try again later.",
    code: "RATE_LIMITED",
  },
});

const ALLOWED_DRAFT_MODELS = [
  "grok-4.6",
  "grok-4.20-0309-reasoning",
  "grok-4.20-0309-non-reasoning",
];
const DEFAULT_DRAFT_MODEL = getDefaultGrokTextModel();

const EMAIL_DRAFT_SYSTEM_PROMPT = `You are a helpful assistant that writes short, professional email messages for a software service called Call & Translate. The product helps people get things done on a phone call in a language they do not speak: they brief a live caller, stay on speakerphone, follow a transcript in their own language, and keep a report afterwards. The emails must sound like genuine service updates or account notifications — never like marketing or promotional material. Keep the tone warm but informative. Return a JSON object with two fields: "subject" (string, max 80 chars) and "message" (string, the email body text). Do not include any greeting like "Hi [Name]" — the system adds that automatically. Do not include any sign-off — the system adds that too.`;

let messageAllInFlight = false;

function toDateOrNull(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function createdAtFromUser(user) {
  if (user?._id && typeof user._id.getTimestamp === "function") {
    return user._id.getTimestamp();
  }
  return toDateOrNull(user?.createdAt);
}

function buildSubscriptionSummary(user) {
  const planId = planIdFromUser(user);
  const plan = getPlanById(planId);
  const periodEnd = toDateOrNull(user.subscriptionCurrentPeriodEnd);
  const startedAt = toDateOrNull(user.subscriptionStartedAt);
  return {
    hasRecord: Boolean(
      user.stripeSubscriptionId ||
        (user.subscriptionStatus && user.subscriptionStatus !== "none"),
    ),
    tier: planId,
    displayName: plan.name,
    status: user.subscriptionStatus || (planId === "pro" ? "active" : "none"),
    currentPeriodStart: startedAt ? startedAt.toISOString() : null,
    currentPeriodEnd: periodEnd ? periodEnd.toISOString() : null,
    cancelAtPeriodEnd: Boolean(user.cancelAtPeriodEnd),
    stripeCustomerId: user.stripeCustomerId || null,
    stripeSubscriptionId: user.stripeSubscriptionId || null,
  };
}

async function buildDashboard() {
  const users = await User.find(
    {},
    "name email isAdmin isDev role emailValidated subscriptionTier subscriptionStatus token_credit_balance lastActiveAt deletionScheduledAt stripeCustomerId stripeSubscriptionId stripePriceId cancelAtPeriodEnd subscriptionCurrentPeriodEnd subscriptionStartedAt",
  ).lean();

  const userIds = users.map((user) => user._id);
  const [sessionCounts, usageByUser, creditGrants, adminActivity, lotsByUser] =
    await Promise.all([
      CallAgentSession.aggregate([
        { $match: { ownerId: { $in: userIds } } },
        { $group: { _id: "$ownerId", count: { $sum: 1 } } },
      ]),
      getUsageByUserIds(userIds),
      CreditGrant.find({})
        .sort({ createdAt: -1 })
        .limit(80)
        .lean(),
      AdminActivity.find({})
        .sort({ createdAt: -1 })
        .limit(80)
        .lean(),
      summarizeLotsByUserIds(userIds),
    ]);

  const sessionMap = new Map(
    sessionCounts.map((row) => [String(row._id), Number(row.count) || 0]),
  );

  const summaries = [];
  let totalCredits = 0;
  let totalCreditsUsed = 0;
  let totalCreditsPurchased = 0;
  let totalCreditsExpired = 0;
  let totalCreditsExpiring = 0;
  let totalSessions = 0;
  let proSubscribers = 0;
  let freeUsers = 0;
  let unverifiedUsers = 0;

  for (const user of users) {
    const usage = usageByUser.get(String(user._id)) || {
      creditsUsed: 0,
      tokens: 0,
      calls: 0,
    };
    const lotSummary = lotsByUser.get(String(user._id));
    const privileged = isPrivilegedUser(user);
    const planId = planIdFromUser(user);
    const sessions = sessionMap.get(String(user._id)) || 0;
    const credits = lotSummary
      ? Number(lotSummary.totals?.remaining) || 0
      : Number(user.token_credit_balance) || 0;
    const creditsUsed = Math.max(
      Number(lotSummary?.totals?.used) || 0,
      Number(usage.creditsUsed) || 0,
    );
    const creditsPurchased = Number(lotSummary?.totals?.purchased) || 0;
    const creditsExpired = Number(lotSummary?.totals?.expired) || 0;
    const creditsExpiring = Number(lotSummary?.totals?.goingToExpire) || 0;

    if (!privileged) {
      totalCredits += credits;
      totalCreditsUsed += creditsUsed;
      totalCreditsPurchased += creditsPurchased;
      totalCreditsExpired += creditsExpired;
      totalCreditsExpiring += creditsExpiring;
      totalSessions += sessions;
      if (planId === "pro") proSubscribers += 1;
      else freeUsers += 1;
      if (!user.emailValidated) unverifiedUsers += 1;
    }

    summaries.push({
      id: user._id,
      name: user.name,
      email: user.email,
      emailValidated: Boolean(user.emailValidated),
      lastActiveAt: user.lastActiveAt || null,
      createdAt: createdAtFromUser(user),
      deletionPending: Boolean(user.deletionScheduledAt),
      deletionScheduledAt: user.deletionScheduledAt || null,
      roles: {
        isAdmin: Boolean(user.isAdmin),
        isDev: Boolean(user.isDev),
        role: user.role || "user",
      },
      subscriptionTier: user.subscriptionTier || "free",
      subscription: buildSubscriptionSummary(user),
      credits,
      creditsUsed,
      creditsPurchased,
      creditsExpired,
      creditsExpiring,
      nextExpiration: lotSummary?.nextExpiration || null,
      lastPurchaseDate: lotSummary?.lastPurchaseDate || null,
      usageCalls: usage.calls,
      sessions,
      playbooks: sessions,
    });
  }

  summaries.sort((a, b) => {
    if (b.credits !== a.credits) return b.credits - a.credits;
    return String(a.name || "").localeCompare(String(b.name || ""));
  });

  const userById = new Map(users.map((user) => [String(user._id), user]));
  const recentActivity = [];

  for (const grant of creditGrants) {
    const owner = userById.get(String(grant.userId));
    const invoiceId = String(grant.invoiceId || "");
    const isAdminGrant = invoiceId.startsWith("admin-");
    const isTopUp =
      invoiceId.startsWith("topup:") ||
      grant.source === "stripe-topup" ||
      grant.billingReason === "credit_topup";
    recentActivity.push({
      id: String(grant._id),
      createdAt: grant.createdAt,
      eventType: isAdminGrant
        ? "manual_credit_granted"
        : isTopUp
          ? "credit_topup_purchased"
          : "billing_invoice_paid",
      source: isAdminGrant ? "admin_manual_credit" : "stripe_webhook",
      user: {
        id: grant.userId,
        name: owner?.name || "",
        email: owner?.email || "",
      },
      metadata: {
        credits: grant.amount,
        billingReason: grant.billingReason || "",
        invoiceId: grant.invoiceId || "",
        expiresAt: grant.expiresAt || null,
        purchaseMethod: grant.purchaseMethod || "",
      },
    });
  }

  for (const row of adminActivity) {
    recentActivity.push({
      id: String(row._id),
      createdAt: row.createdAt,
      eventType: row.eventType,
      source: row.source || "admin",
      user: {
        id: row.userId,
        name: row.userName || "",
        email: row.userEmail || "",
      },
      metadata: row.metadata || {},
      actorEmail: row.actorEmail || "",
    });
  }

  recentActivity.sort((a, b) => {
    const aTime = toDateOrNull(a.createdAt)?.getTime() || 0;
    const bTime = toDateOrNull(b.createdAt)?.getTime() || 0;
    return bTime - aTime;
  });

  return {
    users: summaries,
    totals: {
      totalUsers: summaries.length,
      proSubscribers,
      freeUsers,
      unverifiedUsers,
      totalCredits,
      totalCreditsUsed,
      totalCreditsPurchased,
      totalCreditsExpired,
      totalCreditsExpiring,
      totalSessions,
      totalPlaybooks: totalSessions,
    },
    plans: listPublicPlans(),
    creditCalculator: publicCreditCalculator(),
    recentSubscriptionActivity: recentActivity.slice(0, 120),
  };
}

router.get("/dashboard", async (_req, res) => {
  try {
    const dashboard = await buildDashboard();
    res.json(dashboard);
  } catch (error) {
    console.error("Error generating admin dashboard data", error);
    res.status(500).json({
      error: "Unable to load admin dashboard data.",
      message: "Unable to load admin dashboard data.",
    });
  }
});

router.get("/model-usage/analytics", async (req, res) => {
  try {
    const range = ["day", "week", "month"].includes(req.query.range)
      ? req.query.range
      : "month";
    const anchorInput = req.query.anchor;
    const anchorDate = anchorInput ? new Date(anchorInput) : new Date();
    if (Number.isNaN(anchorDate.getTime())) {
      return res.status(400).json({ error: "Invalid anchor date." });
    }
    const analytics = await getUsageAnalytics({ range, anchorDate });
    res.json(analytics);
  } catch (error) {
    console.error("Error loading model usage analytics", error);
    res.status(500).json({
      error: "Unable to load model usage analytics.",
      message: "Unable to load model usage analytics.",
    });
  }
});

router.get("/subscription/pricing", (_req, res) => {
  res.json({
    plans: listPublicPlans(),
    updatedAt: null,
  });
});

router.put("/users/:id/tier", async (req, res) => {
  if (!req.user.isAdmin) {
    return res.status(403).json({
      error: "Requires admin privileges.",
      message: "Requires admin privileges.",
      code: "ADMIN_REQUIRED",
    });
  }
  const { id } = req.params;
  if (!mongoose.Types.ObjectId.isValid(id)) {
    return res.status(400).json({ error: "Invalid user identifier." });
  }
  const tier = String(req.body?.tier || "").toLowerCase();
  if (!PLANS[tier]) {
    return res.status(400).json({
      error: `Invalid tier. Must be one of: ${Object.keys(PLANS).join(", ")}`,
    });
  }
  const user = await User.findById(id);
  if (!user) return res.status(404).json({ error: "User not found." });

  const previousTier = user.subscriptionTier || "free";
  const previousStatus = user.subscriptionStatus || "none";
  user.subscriptionTier = tier;
  if (tier === "pro") {
    if (!PRO_STATUSES.has(String(user.subscriptionStatus || "").toLowerCase())) {
      user.subscriptionStatus = "active";
    }
    user.subscriptionStartedAt = user.subscriptionStartedAt || new Date();
  } else {
    user.subscriptionStatus = "none";
    user.cancelAtPeriodEnd = false;
  }
  await user.save();

  await recordAdminActivity({
    userId: user._id,
    userEmail: user.email,
    userName: user.name,
    eventType: "subscription_tier_overridden",
    source: "admin",
    metadata: {
      previousTier,
      previousStatus,
      newTier: tier,
    },
    actorId: req.user._id,
  });

  res.json({
    success: true,
    userId: id,
    previousTier,
    newTier: tier,
    displayName: getPlanById(tier).name,
  });
});

router.get("/users/:id/credits", async (req, res) => {
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
    return res.status(400).json({ error: "Invalid user identifier." });
  }
  const user = await User.findById(req.params.id).select(
    "name email token_credit_balance",
  );
  if (!user) return res.status(404).json({ error: "User not found." });
  const ledger = await getCreditLedger(user._id);
  const usage = await UsageRecord.find({ userId: user._id })
    .sort({ createdAt: -1 })
    .limit(50)
    .lean();
  res.json({
    userId: String(user._id),
    name: user.name,
    email: user.email,
    balance: ledger.balance,
    totals: ledger.totals,
    lots: ledger.lots,
    nextExpiration: ledger.nextExpiration,
    lastPurchaseDate: ledger.lastPurchaseDate,
    creditCalculator: publicCreditCalculator(),
    usage: usage.map((row) => ({
      id: String(row._id),
      createdAt: row.createdAt,
      callType: row.callType,
      model: row.model,
      creditsDeducted: row.creditsDeducted,
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      reasoningTokens: row.reasoningTokens,
      durationSec: row.durationSec,
      success: row.success,
    })),
  });
});

router.post("/users/:id/credits", async (req, res) => {
  const schema = Joi.object({
    credits: Joi.number().integer().min(0).max(10_000_000).required(),
    mode: Joi.string().valid("add", "set").default("add"),
    message: Joi.string().allow("", null).max(2000),
  });
  const { error, value } = schema.validate(req.body, {
    abortEarly: true,
    stripUnknown: true,
  });
  if (error) {
    return res.status(400).json({ error: error.details[0].message });
  }

  const user = await User.findById(req.params.id);
  if (!user) return res.status(404).json({ error: "User not found." });

  const amount = Math.round(Number(value.credits));
  const mode = value.mode;
  if (mode === "add" && amount < 1) {
    return res.status(400).json({ error: "Credits to add must be at least 1." });
  }

  const result =
    mode === "set"
      ? await setCredits(user._id, amount, {
          reason: "Admin credit adjustment",
          operatorId: String(req.user._id),
        })
      : await addCredits(user._id, amount, {
          reason: "Admin credit grant",
          source: "admin",
          operatorId: String(req.user._id),
        });
  if (!result.success) {
    return res.status(500).json({
      error: result.error || "Unable to update credits.",
    });
  }

  const previousBalance = Number(result.previousBalance) || 0;
  const newBalance = Number(result.newBalance) || 0;
  const delta = newBalance - previousBalance;

  if (delta !== 0) {
    await logCreditBalanceChange({
      userId: user._id,
      previousBalance,
      newBalance,
      callType: "admin-credit-change",
      metadata: {
        source: "admin",
        reason: mode === "set" ? "Admin credit adjustment" : "Admin credit grant",
        mode,
        actorId: String(req.user._id),
        actorEmail: req.user.email || "",
      },
    });
  }

  const appBaseUrl = getAppBaseUrl(req);
  const defaultMessage =
    delta >= 0
      ? `Hi ${user.name || "there"},\n\n${Math.abs(delta).toLocaleString()} seconds of call time have been added to your ${PRODUCT_NAME} account. You now have ${Math.round(newBalance).toLocaleString()} seconds available.\n\nYou can log in at ${appBaseUrl}/app.html to brief a call and go live.\n\nThanks for using ${PRODUCT_NAME}.`
      : `Hi ${user.name || "there"},\n\nYour ${PRODUCT_NAME} credit balance has been updated by an administrator. You now have ${Math.round(newBalance).toLocaleString()} credits available.\n\nYou can log in at ${appBaseUrl}/app.html.\n\nThanks for using ${PRODUCT_NAME}.`;
  const userMessage =
    value.message && String(value.message).trim()
      ? String(value.message).trim()
      : defaultMessage;

  if (delta !== 0) {
    const subject =
      delta >= 0
        ? `Credits added to your ${PRODUCT_NAME} account`
        : `Your ${PRODUCT_NAME} credit balance was updated`;
    const userHtml = buildEmailCardHtml({
      eyebrow: delta >= 0 ? "Credit top-up" : "Credit update",
      title: delta >= 0 ? "Credits have been added" : "Your credits have been updated",
      lead: userMessage,
      rows: [
        { label: "Previous balance", value: previousBalance.toLocaleString() },
        {
          label: delta >= 0 ? "Credits added" : "Credits removed",
          value: Math.abs(delta).toLocaleString(),
        },
        { label: "New balance", value: Math.round(newBalance).toLocaleString() },
      ],
      ctaUrl: `${appBaseUrl}/app.html`,
      ctaLabel: `Open ${PRODUCT_NAME}`,
      footer:
        "If you have any questions, reply to this email or write to info@callandtranslate.com.",
    });

    try {
      await sendAppMail({
        to: user.email,
        subject,
        html: userHtml,
      });
    } catch (emailError) {
      console.error("Failed to email credit update", emailError);
    }
  }

  if (delta !== 0) {
    await recordAdminActivity({
      userId: user._id,
      userEmail: user.email,
      userName: user.name,
      eventType: delta < 0 ? "manual_credit_adjusted" : "manual_credit_granted",
      source: "admin_manual_credit",
      metadata: {
        creditsAdded: delta > 0 ? delta : 0,
        creditsRemoved: delta < 0 ? -delta : 0,
        previousBalance,
        updatedBalance: newBalance,
        mode,
      },
      actorId: req.user._id,
    });
  }

  res.json({
    success: true,
    mode,
    creditsAdded: delta > 0 ? delta : 0,
    creditsRemoved: delta < 0 ? -delta : 0,
    previousBalance,
    updatedBalance: newBalance,
  });
});

router.post("/users/:id/message", async (req, res) => {
  const schema = Joi.object({
    subject: Joi.string().trim().max(120).allow("", null),
    message: Joi.string().trim().min(1).max(5000).required(),
    copyToAdmin: Joi.boolean().default(false),
  });
  const { error, value } = schema.validate(req.body, {
    abortEarly: true,
    stripUnknown: true,
  });
  if (error) {
    return res.status(400).json({ error: error.details[0].message });
  }

  const user = await User.findById(req.params.id);
  if (!user) return res.status(404).json({ error: "User not found." });

  const resolvedSubject =
    value.subject && value.subject.length > 0
      ? value.subject
      : "Message from Call & Translate support";
  const appBaseUrl = getAppBaseUrl(req);
  const userHtml = buildEmailCardHtml({
    eyebrow: "Call & Translate",
    title: resolvedSubject,
    lead: value.message,
    ctaUrl: `${appBaseUrl}/app.html`,
    ctaLabel: "Open Call & Translate",
    footer:
      "If you have any questions, reply to this email or write to info@callandtranslate.com.",
  });

  try {
    await sendAppMail({
      to: user.email,
      subject: resolvedSubject,
      html: userHtml,
    });
    if (value.copyToAdmin) {
      const copyHtml = buildEmailCardHtml({
        eyebrow: "Admin copy",
        title: `Copy: ${resolvedSubject}`,
        lead: `A message was sent to ${user.name || user.email}.`,
        rows: [
          { label: "Recipient", value: user.email },
          { label: "Subject", value: resolvedSubject },
        ],
        footer: value.message,
      });
      await sendAppMail({
        to: SUPPORT_MAIL_ADDRESS,
        subject: `Copy: ${resolvedSubject}`,
        html: copyHtml,
      });
    }
  } catch (emailError) {
    console.error("Error sending admin message", emailError);
    return res.status(500).json({ error: "Unable to send message at this time." });
  }

  await recordAdminActivity({
    userId: user._id,
    userEmail: user.email,
    userName: user.name,
    eventType: "admin_message_sent",
    source: "admin",
    metadata: { subject: resolvedSubject },
    actorId: req.user._id,
  });

  res.json({ success: true });
});

router.delete("/users/:id", async (req, res) => {
  const { id } = req.params;
  if (!mongoose.Types.ObjectId.isValid(id)) {
    return res.status(400).json({ error: "Invalid user identifier." });
  }
  if (String(id) === String(req.user._id)) {
    return res.status(403).json({
      error: "You cannot delete your own account from this endpoint.",
    });
  }
  const user = await User.findById(id);
  if (!user) return res.status(404).json({ error: "User not found." });
  if (isPrivilegedUser(user)) {
    return res.status(403).json({
      error: "Privileged users cannot be deleted from this endpoint.",
    });
  }

  const snapshot = {
    email: user.email,
    name: user.name,
    userId: String(user._id),
  };
  const result = await purgeUserData(user._id);
  await recordAdminActivity({
    userEmail: snapshot.email,
    userName: snapshot.name,
    eventType: "user_deleted",
    source: "admin",
    metadata: { userId: snapshot.userId },
    actorId: req.user._id,
  });
  res.json({ success: true, purged: Boolean(result?.purged), email: snapshot.email });
});

router.post("/message-all/draft", draftLimiter, async (req, res) => {
  const schema = Joi.object({
    prompt: Joi.string().trim().min(1).max(2000).required(),
    model: Joi.string()
      .valid(...ALLOWED_DRAFT_MODELS)
      .default(DEFAULT_DRAFT_MODEL),
  });
  const { error, value } = schema.validate(req.body, {
    abortEarly: true,
    stripUnknown: true,
  });
  if (error) {
    return res.status(400).json({ error: error.details[0].message });
  }

  const model = isAllowedGrokTextModel(value.model)
    ? normalizeGrokTextModel(value.model)
    : DEFAULT_DRAFT_MODEL;
  const skipReasoningEffort = String(model).includes("non-reasoning");

  try {
    const result = await grokChatCompletion({
      model,
      messages: [
        { role: "system", content: EMAIL_DRAFT_SYSTEM_PROMPT },
        { role: "user", content: value.prompt },
      ],
      temperature: 0.3,
      maxTokens: 1200,
      skipReasoningEffort,
      responseFormat: {
        type: "json_schema",
        json_schema: {
          name: "email_draft",
          strict: true,
          schema: {
            type: "object",
            properties: {
              subject: { type: "string" },
              message: { type: "string" },
            },
            required: ["subject", "message"],
            additionalProperties: false,
          },
        },
      },
    });
    let draft;
    try {
      draft = JSON.parse(result.text);
    } catch {
      return res.status(502).json({ error: "Unexpected response from AI service." });
    }
    try {
      await logLlmUsage({
        userId: req.user._id,
        callType: "admin-email-draft",
        model,
        usage: result.usage || {},
        skipDeduct: true,
        metadata: { promptChars: String(value.prompt || "").length },
      });
    } catch (logError) {
      console.warn("Failed to log admin draft usage", logError.message);
    }
    res.json({
      subject: String(draft.subject || "").slice(0, 120),
      message: String(draft.message || ""),
    });
  } catch (err) {
    if (err.code === "XAI_NOT_CONFIGURED" || err.status === 503) {
      return res.status(503).json({ error: "AI service is not configured." });
    }
    console.error("Error generating AI draft", err);
    return res.status(502).json({ error: "Failed to generate draft. Please try again." });
  }
});

router.post("/message-all/send", messageAllLimiter, async (req, res) => {
  const schema = Joi.object({
    subject: Joi.string().trim().min(1).max(120).required(),
    message: Joi.string().trim().min(1).max(5000).required(),
  });
  const { error, value } = schema.validate(req.body, {
    abortEarly: true,
    stripUnknown: true,
  });
  if (error) {
    return res.status(400).json({ error: error.details[0].message });
  }
  if (messageAllInFlight) {
    return res.status(409).json({
      error: "A broadcast is already in progress.",
      message: "A broadcast is already in progress.",
      code: "BROADCAST_IN_PROGRESS",
    });
  }

  messageAllInFlight = true;
  try {
    const users = await User.find(
      { email: { $exists: true, $ne: "" } },
      "name email",
    ).lean();
    if (!users.length) {
      return res.status(404).json({ error: "No users found." });
    }

    const appBaseUrl = getAppBaseUrl(req);
    let sent = 0;
    let failed = 0;
    for (const user of users) {
      try {
        const html = buildEmailCardHtml({
          eyebrow: "Call & Translate",
          title: value.subject,
          lead: value.message,
          ctaUrl: `${appBaseUrl}/app.html`,
          ctaLabel: "Open Call & Translate",
          footer:
            "If you have any questions, reply to this email or write to info@callandtranslate.com.",
        });
        await sendAppMail({
          to: user.email,
          subject: value.subject,
          html,
        });
        sent += 1;
      } catch (emailErr) {
        failed += 1;
        console.error(`Failed to email ${user.email}:`, emailErr.message);
      }
      if (process.env.NODE_ENV !== "test" && sent + failed < users.length) {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }

    await recordAdminActivity({
      eventType: "message_all_sent",
      source: "admin",
      metadata: {
        subject: value.subject,
        total: users.length,
        sent,
        failed,
      },
      actorId: req.user._id,
    });

    res.json({ success: true, total: users.length, sent, failed });
  } catch (err) {
    console.error("Error sending message to all users", err);
    res.status(500).json({ error: "Unable to send messages at this time." });
  } finally {
    messageAllInFlight = false;
  }
});

export default router;
