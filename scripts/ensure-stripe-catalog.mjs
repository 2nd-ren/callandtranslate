#!/usr/bin/env node
/**
 * Create (or reuse) Call & Translate Stripe catalog:
 *   - Paid subscription, £12 / month (1 hour of call time)
 *   - Extra hour top-up, £12 (one-time)
 *
 * Usage:
 *   STRIPE_SECRET_KEY=rk_test_... node scripts/ensure-stripe-catalog.mjs
 *
 * Prints STRIPE_PRICE_ID_PRO and STRIPE_PRICE_ID_CREDITS for /etc/callandtranslate.env
 */

import Stripe from "stripe";

const key = String(process.env.STRIPE_SECRET_KEY || "").trim();
if (!key) {
  console.error("Set STRIPE_SECRET_KEY first.");
  process.exit(1);
}

const stripe = new Stripe(key, { apiVersion: "2026-08-26.dahlia" });
const CURRENCY = "gbp";

const products = await stripe.products.list({ limit: 100, active: true });

async function ensureProduct({ name, description }) {
  let product = products.data.find((p) => p.name === name);
  if (!product) {
    product = await stripe.products.create({ name, description });
    console.log("Created product", name, product.id);
  } else {
    console.log("Reusing product", name, product.id);
  }
  return product;
}

async function ensurePrice(product, match, create) {
  const prices = await stripe.prices.list({
    product: product.id,
    active: true,
    limit: 100,
  });
  let price = prices.data.find(match);
  if (!price) {
    price = await stripe.prices.create({
      product: product.id,
      currency: CURRENCY,
      ...create,
    });
    console.log("Created price", price.id);
  } else {
    console.log("Reusing price", price.id);
  }
  return price;
}

const paidProduct = await ensureProduct({
  name: "Call & Translate Paid",
  description:
    "One hour of live translated call time each month. Credits expire 30 days after they are added.",
});
const paidPrice = await ensurePrice(
  paidProduct,
  (p) =>
    p.currency === CURRENCY &&
    p.unit_amount === 1200 &&
    p.recurring?.interval === "month",
  { unit_amount: 1200, recurring: { interval: "month" } },
);

const creditProduct = await ensureProduct({
  name: "Call & Translate extra hour",
  description:
    "One extra hour of call time. Credits expire 30 days after purchase.",
});
const creditPrice = await ensurePrice(
  creditProduct,
  (p) =>
    p.currency === CURRENCY &&
    p.unit_amount === 1200 &&
    !p.recurring,
  { unit_amount: 1200 },
);

console.log("");
console.log("Add to /etc/callandtranslate.env:");
console.log(`STRIPE_PRICE_ID_PRO=${paidPrice.id}`);
console.log(`STRIPE_PRICE_ID_CREDITS=${creditPrice.id}`);
