/**
 * Subscription routes — EventAnnouncer-shaped API.
 *
 * Public: GET /plans
 * Auth:   GET /me, POST /create-checkout-session, POST /cancel,
 *         POST /reactivate, POST /create-portal-session
 */

import express from "express";
import rateLimit from "express-rate-limit";
import auth from "../middleware/auth.js";
import forbidGrokBot from "../middleware/forbidGrokBot.js";
import {
  getBillingSnapshot,
  jsonPlanError,
  listPublicPlans,
} from "../utils/plans.js";
import { publicCreditCalculator } from "../utils/creditCalculator.js";
import {
  cancelSubscriptionAtPeriodEnd,
  createBillingPortalSession,
  createCheckoutSession,
  createCreditTopUpCheckoutSession,
  publicStripeConfig,
  reactivateSubscription,
  serializeSubscription,
} from "../utils/stripeBilling.js";
import { User } from "../models/user.js";

const router = express.Router();

const subscribeLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: "Too many subscription attempts.",
    message: "Too many subscription attempts. Please try again later.",
    code: "RATE_LIMITED",
  },
});

router.get("/plans", (_req, res) => {
  res.json({
    plans: listPublicPlans(),
    creditCalculator: publicCreditCalculator(),
    ...publicStripeConfig(),
  });
});

router.get("/config", (_req, res) => {
  res.json(publicStripeConfig());
});

router.get("/me", auth, async (req, res) => {
  const snapshot = await getBillingSnapshot(req.user._id);
  if (!snapshot) return res.status(404).json({ message: "User not found." });
  const user = await User.findById(req.user._id).select(
    "subscriptionTier subscriptionStatus cancelAtPeriodEnd subscriptionCurrentPeriodEnd stripeSubscriptionId",
  );
  res.json({
    ...snapshot,
    ...serializeSubscription(user),
  });
});

router.post(
  "/create-checkout-session",
  auth,
  forbidGrokBot,
  subscribeLimiter,
  async (req, res) => {
    try {
      const type = String(req.body?.type || "").toLowerCase();
      if (type === "credits" || type === "topup" || type === "credit_topup") {
        const session = await createCreditTopUpCheckoutSession(
          req.user._id,
          { packs: req.body?.packs },
          req,
        );
        return res.json(session);
      }
      const plan = String(req.body?.plan || "pro").toLowerCase();
      const session = await createCheckoutSession(
        req.user._id,
        { plan },
        req,
      );
      res.json({ url: session.url, id: session.id });
    } catch (err) {
      res.status(err.status || 500).json(jsonPlanError(err));
    }
  },
);

router.post(
  "/create-credit-topup-session",
  auth,
  forbidGrokBot,
  subscribeLimiter,
  async (req, res) => {
    try {
      const session = await createCreditTopUpCheckoutSession(
        req.user._id,
        { packs: req.body?.packs },
        req,
      );
      res.json(session);
    } catch (err) {
      res.status(err.status || 500).json(jsonPlanError(err));
    }
  },
);

router.post("/cancel", auth, forbidGrokBot, async (req, res) => {
  try {
    const result = await cancelSubscriptionAtPeriodEnd(req.user._id);
    res.json(result);
  } catch (err) {
    res.status(err.status || 500).json(jsonPlanError(err));
  }
});

router.post("/reactivate", auth, forbidGrokBot, async (req, res) => {
  try {
    const result = await reactivateSubscription(req.user._id);
    res.json(result);
  } catch (err) {
    res.status(err.status || 500).json(jsonPlanError(err));
  }
});

router.post(
  "/create-portal-session",
  auth,
  forbidGrokBot,
  async (req, res) => {
    try {
      const session = await createBillingPortalSession(req.user._id, req);
      res.json({ url: session.url });
    } catch (err) {
      res.status(err.status || 500).json(jsonPlanError(err));
    }
  },
);

export default router;
