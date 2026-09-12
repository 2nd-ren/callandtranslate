import Stripe from "stripe";

/** Latest Stripe API version shipped with stripe@22.6.0. */
export const STRIPE_API_VERSION = "2026-08-26.dahlia";

const TIER_PRICE_ENV = {
  pro: "STRIPE_PRICE_ID_PRO",
  credits: "STRIPE_PRICE_ID_CREDITS",
};

let stripeClient = null;

export function getStripeSecretKey() {
  return String(process.env.STRIPE_SECRET_KEY || "").trim();
}

export function getStripePublishableKey() {
  return String(process.env.STRIPE_PUBLISHABLE_KEY || "").trim();
}

export function getStripeWebhookSecret() {
  return String(process.env.STRIPE_WEBHOOK_SECRET || "").trim();
}

export function getStripePriceId(planId = "pro") {
  const envName = TIER_PRICE_ENV[String(planId || "").toLowerCase()];
  if (!envName) return "";
  return String(process.env[envName] || "").trim();
}

/**
 * Instantiates StripeClient once. Do not set a module-level apiKey.
 * Returns null when STRIPE_SECRET_KEY is missing so the app still boots.
 */
export function getStripe() {
  const key = getStripeSecretKey();
  if (!key) return null;
  if (!stripeClient) {
    stripeClient = new Stripe(key, { apiVersion: STRIPE_API_VERSION });
  }
  return stripeClient;
}

export function resetStripeClientForTests() {
  stripeClient = null;
}

export function isStripeCheckoutConfigured() {
  return Boolean(getStripeSecretKey() && getStripePriceId("pro"));
}

export function isStripeTopUpConfigured() {
  return Boolean(getStripeSecretKey() && getStripePriceId("credits"));
}

export function isStripeWebhookConfigured() {
  return Boolean(getStripeSecretKey() && getStripeWebhookSecret());
}

export function randomIntegrationSuffix(length = 8) {
  const alphabet = "abcdefghijklmnopqrstuvwxyz";
  let out = "";
  for (let i = 0; i < length; i += 1) {
    out += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return out;
}

export default {
  getStripe,
  getStripeSecretKey,
  getStripePublishableKey,
  getStripeWebhookSecret,
  getStripePriceId,
  isStripeCheckoutConfigured,
  isStripeWebhookConfigured,
};
