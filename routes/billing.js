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
  createCheckoutSession,
  createCreditTopUpCheckoutSession,
  publicStripeConfig,
} from "../utils/stripeBilling.js";

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

router.get("/me", auth, async (req, res) => {
  const snapshot = await getBillingSnapshot(req.user._id);
  if (!snapshot) return res.status(404).json({ message: "User not found." });
  res.json(snapshot);
});

/** Alias of POST /api/subscriptions/create-checkout-session. */
router.post("/subscribe", auth, forbidGrokBot, subscribeLimiter, async (req, res) => {
  const plan = String(req.body?.plan || "pro").toLowerCase();
  if (plan !== "pro") {
    return res.status(400).json({
      message: "Choose the Pro plan to subscribe.",
      code: "UNKNOWN_PLAN",
    });
  }

  try {
    const session = await createCheckoutSession(req.user._id, { plan }, req);
    res.json({ url: session.url, id: session.id });
  } catch (err) {
    res.status(err.status || 500).json(jsonPlanError(err));
  }
});

router.post(
  "/credits/checkout",
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

export default router;
