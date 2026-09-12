/**
 * POST /api/stripe/webhook
 *
 * Must be mounted with express.raw() BEFORE express.json() so Stripe
 * signature verification sees the original bytes.
 */

import express from "express";
import {
  constructWebhookEvent,
  handleStripeEvent,
} from "../utils/stripeBilling.js";

const router = express.Router();

router.post("/", async (req, res) => {
  const signature = req.headers["stripe-signature"];
  let event;
  try {
    event = constructWebhookEvent(req.body, signature);
  } catch (err) {
    if (err.code === "STRIPE_NOT_CONFIGURED") {
      return res.status(503).send("Webhook Error: Stripe webhook is not configured.");
    }
    console.error(`[Stripe webhook] Signature verification failed: ${err.message}`);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    await handleStripeEvent(event);
  } catch (err) {
    console.error(`[Stripe webhook] Error handling ${event.type}:`, err.message);
    return res.status(500).json({ error: "Webhook handler failed" });
  }

  res.json({ received: true });
});

export default router;
