import mongoose from "mongoose";
import request from "supertest";
import config from "config";
import app from "../app.js";
import { User } from "../models/user.js";
import { CreditGrant } from "../models/creditGrant.js";
import { ProcessedStripeEvent } from "../models/processedStripeEvent.js";
import { UsageRecord } from "../models/usageRecord.js";
import { handleStripeEvent } from "../utils/stripeBilling.js";
import { deductCredits } from "../utils/userCredits.js";
import {
  resetStripeClientForTests,
} from "../utils/stripeClient.js";
import { register as registerVerified } from "./helpers.js";

async function register(agent) {
  return registerVerified(agent, {
    name: "Bill User",
    email: `bill${Date.now()}${Math.random().toString(16).slice(2)}@example.com`,
  });
}

describe("Stripe credit subscriptions", () => {
  beforeAll(async () => {
    await mongoose.connect(config.get("db"));
    await Promise.all([CreditGrant.init(), ProcessedStripeEvent.init()]);
  });

  afterAll(async () => {
    try {
      await Promise.all([
        User.deleteMany({ email: /@example\.com$/ }),
        CreditGrant.deleteMany({}),
        ProcessedStripeEvent.deleteMany({}),
        UsageRecord.deleteMany({}),
      ]);
    } catch (err) {
      console.warn("billing test cleanup:", err.message);
    }
    await mongoose.disconnect();
  });

  test("subscriptions plans match billing plans and expose checkout flag", async () => {
    const plans = await request(app).get("/api/subscriptions/plans");
    expect(plans.status).toBe(200);
    expect(plans.body.plans.map((p) => p.id)).toEqual(["free", "pro"]);
    expect(plans.body.plans[1].monthlyCredits).toBe(3600);
    expect(plans.body.plans[1].priceGbp).toBe(12);
    expect(plans.body.creditCalculator.creditsPerSecond).toBe(1);
    expect(plans.body.creditCalculator.expiryDays).toBe(30);
    expect(plans.body.creditTopUp.credits).toBe(3600);
    expect(plans.body.creditTopUp.priceGbp).toBe(12);
    expect(typeof plans.body.checkoutEnabled).toBe("boolean");
    expect(typeof plans.body.creditTopUpEnabled).toBe("boolean");
  });

  test("create-checkout-session requires auth", async () => {
    const res = await request(app)
      .post("/api/subscriptions/create-checkout-session")
      .send({ plan: "pro" });
    expect(res.status).toBe(401);
  });

  test("credit top-up checkout requires auth", async () => {
    const res = await request(app)
      .post("/api/subscriptions/create-credit-topup-session")
      .send({ packs: 1 });
    expect(res.status).toBe(401);
  });

  test("create-checkout-session without Stripe keys returns 503", async () => {
    const prevSecret = process.env.STRIPE_SECRET_KEY;
    const prevPrice = process.env.STRIPE_PRICE_ID_PRO;
    delete process.env.STRIPE_SECRET_KEY;
    delete process.env.STRIPE_PRICE_ID_PRO;
    resetStripeClientForTests();

    const agent = request.agent(app);
    const { res: created } = await register(agent);
    const res = await agent
      .post("/api/subscriptions/create-checkout-session")
      .set("x-auth-token", created.body.token)
      .send({ plan: "pro" });
    expect(res.status).toBe(503);
    expect(res.body.code).toBe("STRIPE_NOT_CONFIGURED");
    expect(res.body.message).toBe("Coming shortly.");
    expect(res.body.message).not.toMatch(/STRIPE_/);

    if (prevSecret) process.env.STRIPE_SECRET_KEY = prevSecret;
    if (prevPrice) process.env.STRIPE_PRICE_ID_PRO = prevPrice;
    resetStripeClientForTests();
  });

  test("credit top-up checkout without Stripe keys returns 503", async () => {
    const prevSecret = process.env.STRIPE_SECRET_KEY;
    const prevPrice = process.env.STRIPE_PRICE_ID_CREDITS;
    delete process.env.STRIPE_SECRET_KEY;
    delete process.env.STRIPE_PRICE_ID_CREDITS;
    resetStripeClientForTests();

    const agent = request.agent(app);
    const { res: created } = await register(agent);
    const res = await agent
      .post("/api/subscriptions/create-credit-topup-session")
      .set("x-auth-token", created.body.token)
      .send({ packs: 1 });
    expect(res.status).toBe(503);
    expect(res.body.code).toBe("STRIPE_NOT_CONFIGURED");
    expect(res.body.message).toBe("Coming shortly.");

    if (prevSecret) process.env.STRIPE_SECRET_KEY = prevSecret;
    if (prevPrice) process.env.STRIPE_PRICE_ID_CREDITS = prevPrice;
    resetStripeClientForTests();
  });

  test("paid credit top-up adds a 30-day lot and is idempotent", async () => {
    const agent = request.agent(app);
    const { res: created } = await register(agent);
    const customerId = `cus_topup_${created.body._id}`;
    await User.findByIdAndUpdate(created.body._id, {
      $set: { stripeCustomerId: customerId },
    });
    const sessionId = `cs_topup_${created.body._id}`;
    const payload = {
      id: sessionId,
      object: "checkout.session",
      mode: "payment",
      payment_status: "paid",
      customer: customerId,
      amount_total: 400,
      currency: "gbp",
      metadata: {
        userId: String(created.body._id),
        type: "credit_topup",
        packs: "2",
      },
    };
    const first = await handleStripeEvent({
      id: `evt_topup_${sessionId}`,
      type: "checkout.session.completed",
      data: { object: payload },
    });
    expect(first.ok).toBe(true);

    const billed = await agent
      .get("/api/billing/me")
      .set("x-auth-token", created.body.token);
    expect(billed.body.credits).toBe(7200);

    const lot = await CreditGrant.findOne({ invoiceId: `topup:${sessionId}` });
    expect(lot).toBeTruthy();
    expect(lot.amount).toBe(7200);
    expect(lot.remaining).toBe(7200);
    expect(lot.purchaseMethod).toBe("Credit top-up");
    expect(new Date(lot.expiresAt).getTime()).toBeGreaterThan(
      Date.now() + 29 * 24 * 60 * 60 * 1000,
    );

    const details = await agent
      .get("/api/user-credits/me/details")
      .set("x-auth-token", created.body.token);
    expect(details.body.lots[0].goingToExpire).toBe(7200);
    expect(details.body.lots[0].purchaseMethod).toBe("Credit top-up");

    const again = await handleStripeEvent({
      id: `evt_topup_again_${sessionId}`,
      type: "checkout.session.async_payment_succeeded",
      data: { object: payload },
    });
    expect(again.ok).toBe(true);
    const after = await User.findById(created.body._id).select(
      "token_credit_balance",
    );
    expect(after.token_credit_balance).toBe(7200);
  });

  test("invoice.paid grants monthly credits and activates Pro", async () => {
    const agent = request.agent(app);
    const { res: created } = await register(agent);
    const customerId = `cus_test_${created.body._id}`;
    await User.findByIdAndUpdate(created.body._id, {
      $set: { stripeCustomerId: customerId },
    });

    const invoiceId = `in_test_${created.body._id}`;
    const result = await handleStripeEvent({
      id: `evt_paid_${invoiceId}`,
      type: "invoice.paid",
      data: {
        object: {
          id: invoiceId,
          object: "invoice",
          customer: customerId,
          billing_reason: "subscription_create",
          paid: true,
          amount_paid: 1200,
          amount_due: 1200,
          currency: "gbp",
        },
      },
    });
    expect(result.ok).toBe(true);

    const billed = await agent
      .get("/api/subscriptions/me")
      .set("x-auth-token", created.body.token);
    expect(billed.status).toBe(200);
    expect(billed.body.plan).toBe("pro");
    expect(billed.body.credits).toBe(3600);
    expect(billed.body.ai).toBe(true);

    const welcomed = await User.findById(created.body._id).select(
      "subscriptionWelcomeEmailSentAt",
    );
    expect(welcomed.subscriptionWelcomeEmailSentAt).toBeTruthy();
    const grantLog = await UsageRecord.findOne({
      userId: created.body._id,
      callType: "stripe-credit-grant",
    });
    expect(grantLog).toBeTruthy();
    expect(grantLog.metadata.newBalance).toBe(3600);

    const again = await handleStripeEvent({
      id: `evt_paid_again_${invoiceId}`,
      type: "invoice.paid",
      data: {
        object: {
          id: invoiceId,
          object: "invoice",
          customer: customerId,
          billing_reason: "subscription_cycle",
          paid: true,
          amount_paid: 1200,
          amount_due: 1200,
          currency: "gbp",
        },
      },
    });
    expect(again.ok).toBe(true);

    const after = await User.findById(created.body._id).select(
      "token_credit_balance",
    );
    expect(after.token_credit_balance).toBe(3600);

    const lot = await CreditGrant.findOne({ invoiceId });
    expect(lot.amount).toBe(3600);
    expect(lot.remaining).toBe(3600);
    expect(new Date(lot.expiresAt).getTime()).toBeGreaterThan(Date.now() + 29 * 24 * 60 * 60 * 1000);
  });

  test("AI usage depletes granted credits", async () => {
    const agent = request.agent(app);
    const { res: created } = await register(agent);
    const customerId = `cus_use_${created.body._id}`;
    await User.findByIdAndUpdate(created.body._id, {
      $set: { stripeCustomerId: customerId },
    });
    await handleStripeEvent({
      id: `evt_use_${created.body._id}`,
      type: "invoice.paid",
      data: {
        object: {
          id: `in_use_${created.body._id}`,
          customer: customerId,
          billing_reason: "subscription_create",
          paid: true,
          amount_paid: 1200,
          amount_due: 1200,
          currency: "gbp",
        },
      },
    });

    const spent = await deductCredits(created.body._id, 25, {
      reason: "section-tidy",
      callType: "section-tidy",
    });
    expect(spent.success).toBe(true);
    expect(spent.newBalance).toBe(3575);

    const details = await agent
      .get("/api/user-credits/me/details")
      .set("x-auth-token", created.body.token);
    expect(details.status).toBe(200);
    expect(details.body.balance).toBe(3575);
    expect(details.body.lots[0].used).toBe(25);
    expect(details.body.lots[0].goingToExpire).toBe(3575);
    expect(details.body.creditCalculator.creditsPerSecond).toBe(1);
    expect(JSON.stringify(details.body)).not.toMatch(/\$2/);
  });

  test("a new subscription invoice adds credits instead of resetting unused ones", async () => {
    const agent = request.agent(app);
    const { res: created } = await register(agent);
    const customerId = `cus_add_${created.body._id}`;
    await User.findByIdAndUpdate(created.body._id, {
      $set: { stripeCustomerId: customerId },
    });
    await handleStripeEvent({
      id: `evt_add1_${created.body._id}`,
      type: "invoice.paid",
      data: {
        object: {
          id: `in_add1_${created.body._id}`,
          customer: customerId,
          billing_reason: "subscription_create",
          paid: true,
          amount_paid: 1200,
          amount_due: 1200,
          currency: "gbp",
        },
      },
    });
    await deductCredits(created.body._id, 1000, { reason: "tidy", callType: "section-tidy" });
    await handleStripeEvent({
      id: `evt_add2_${created.body._id}`,
      type: "invoice.paid",
      data: {
        object: {
          id: `in_add2_${created.body._id}`,
          customer: customerId,
          billing_reason: "subscription_cycle",
          paid: true,
          amount_paid: 1200,
          amount_due: 1200,
          currency: "gbp",
        },
      },
    });
    const user = await User.findById(created.body._id).select("token_credit_balance");
    expect(user.token_credit_balance).toBe(3600 - 1000 + 3600);
  });

  test("subscription deleted returns the account to Free", async () => {
    const agent = request.agent(app);
    const { res: created } = await register(agent);
    const customerId = `cus_del_${created.body._id}`;
    await User.findByIdAndUpdate(created.body._id, {
      $set: {
        stripeCustomerId: customerId,
        subscriptionTier: "pro",
        subscriptionStatus: "active",
        token_credit_balance: 5000,
      },
    });

    await handleStripeEvent({
      id: `evt_del_${created.body._id}`,
      type: "customer.subscription.deleted",
      data: {
        object: {
          id: `sub_del_${created.body._id}`,
          customer: customerId,
          status: "canceled",
        },
      },
    });

    const billed = await agent
      .get("/api/billing/me")
      .set("x-auth-token", created.body.token);
    expect(billed.body.plan).toBe("free");
    expect(billed.body.ai).toBe(false);
    const user = await User.findById(created.body._id).select(
      "token_credit_balance subscriptionCancelFeedbackEmailSentAt",
    );
    expect(user.token_credit_balance).toBe(5000);
    expect(user.subscriptionCancelFeedbackEmailSentAt).toBeTruthy();
  });

  test("duplicate webhook event is ignored", async () => {
    const agent = request.agent(app);
    const { res: created } = await register(agent);
    const customerId = `cus_dup_${created.body._id}`;
    await User.findByIdAndUpdate(created.body._id, {
      $set: { stripeCustomerId: customerId },
    });
    const event = {
      id: `evt_dup_${created.body._id}`,
      type: "invoice.paid",
      data: {
        object: {
          id: `in_dup_${created.body._id}`,
          customer: customerId,
          billing_reason: "subscription_create",
          paid: true,
          amount_paid: 1200,
          amount_due: 1200,
          currency: "gbp",
        },
      },
    };
    const first = await handleStripeEvent(event);
    const second = await handleStripeEvent(event);
    expect(first.ok).toBe(true);
    expect(second.duplicate).toBe(true);
  });

  test("refund claws back remaining credits from the paid invoice lot", async () => {
    const agent = request.agent(app);
    const { res: created } = await register(agent);
    const customerId = `cus_rf_${created.body._id}`;
    const invoiceId = `in_rf_${created.body._id}`;
    await User.findByIdAndUpdate(created.body._id, {
      $set: { stripeCustomerId: customerId },
    });
    await handleStripeEvent({
      id: `evt_rf_pay_${created.body._id}`,
      type: "invoice.paid",
      data: {
        object: {
          id: invoiceId,
          customer: customerId,
          billing_reason: "subscription_create",
          paid: true,
          amount_paid: 1200,
          amount_due: 1200,
          currency: "gbp",
        },
      },
    });
    await deductCredits(created.body._id, 600, {
      reason: "call",
      callType: "voice-call",
    });

    const refunded = await handleStripeEvent({
      id: `evt_rf_${created.body._id}`,
      type: "charge.refunded",
      data: {
        object: {
          id: `ch_rf_${created.body._id}`,
          object: "charge",
          customer: customerId,
          invoice: invoiceId,
          amount: 1200,
          amount_refunded: 1200,
          currency: "gbp",
          refunded: true,
        },
      },
    });
    expect(refunded.ok).toBe(true);

    const user = await User.findById(created.body._id).select(
      "token_credit_balance",
    );
    expect(user.token_credit_balance).toBe(0);
    const lot = await CreditGrant.findOne({ invoiceId });
    expect(lot.remaining).toBe(0);
    expect(lot.used).toBe(600);
    expect(lot.clawed).toBe(3000);
  });

  test("partial refund claws a proportional share, then the rest on full refund", async () => {
    const agent = request.agent(app);
    const { res: created } = await register(agent);
    const customerId = `cus_prf_${created.body._id}`;
    const invoiceId = `in_prf_${created.body._id}`;
    await User.findByIdAndUpdate(created.body._id, {
      $set: { stripeCustomerId: customerId },
    });
    await handleStripeEvent({
      id: `evt_prf_pay_${created.body._id}`,
      type: "invoice.paid",
      data: {
        object: {
          id: invoiceId,
          customer: customerId,
          billing_reason: "subscription_create",
          paid: true,
          amount_paid: 1200,
          amount_due: 1200,
          currency: "gbp",
        },
      },
    });

    await handleStripeEvent({
      id: `evt_prf_half_${created.body._id}`,
      type: "charge.refunded",
      data: {
        object: {
          id: `ch_prf_${created.body._id}`,
          object: "charge",
          customer: customerId,
          invoice: invoiceId,
          amount: 1200,
          amount_refunded: 600,
          currency: "gbp",
          refunded: false,
        },
      },
    });
    let lot = await CreditGrant.findOne({ invoiceId });
    expect(lot.clawed).toBe(1800);
    expect(lot.remaining).toBe(1800);

    await handleStripeEvent({
      id: `evt_prf_full_${created.body._id}`,
      type: "charge.refunded",
      data: {
        object: {
          id: `ch_prf_${created.body._id}`,
          object: "charge",
          customer: customerId,
          invoice: invoiceId,
          amount: 1200,
          amount_refunded: 1200,
          currency: "gbp",
          refunded: true,
        },
      },
    });
    lot = await CreditGrant.findOne({ invoiceId });
    expect(lot.clawed).toBe(3600);
    expect(lot.remaining).toBe(0);
    const user = await User.findById(created.body._id).select(
      "token_credit_balance",
    );
    expect(user.token_credit_balance).toBe(0);
  });

  test("dispute created claws remaining credits for that purchase", async () => {
    const agent = request.agent(app);
    const { res: created } = await register(agent);
    const customerId = `cus_dp_${created.body._id}`;
    const invoiceId = `in_dp_${created.body._id}`;
    await User.findByIdAndUpdate(created.body._id, {
      $set: { stripeCustomerId: customerId },
    });
    await handleStripeEvent({
      id: `evt_dp_pay_${created.body._id}`,
      type: "invoice.paid",
      data: {
        object: {
          id: invoiceId,
          customer: customerId,
          billing_reason: "subscription_create",
          paid: true,
          amount_paid: 1200,
          amount_due: 1200,
          currency: "gbp",
        },
      },
    });

    const disputed = await handleStripeEvent({
      id: `evt_dp_${created.body._id}`,
      type: "charge.dispute.created",
      data: {
        object: {
          id: `dp_${created.body._id}`,
          object: "dispute",
          amount: 1200,
          currency: "gbp",
          reason: "fraudulent",
          status: "needs_response",
          charge: {
            id: `ch_dp_${created.body._id}`,
            object: "charge",
            customer: customerId,
            invoice: invoiceId,
            amount: 1200,
            currency: "gbp",
          },
        },
      },
    });
    expect(disputed.ok).toBe(true);
    const user = await User.findById(created.body._id).select(
      "token_credit_balance",
    );
    expect(user.token_credit_balance).toBe(0);
  });

  test("unpaid or zero-amount Stripe events do not grant credits", async () => {
    const agent = request.agent(app);
    const { res: created } = await register(agent);
    const customerId = `cus_unpaid_${created.body._id}`;
    await User.findByIdAndUpdate(created.body._id, {
      $set: { stripeCustomerId: customerId },
    });

    await handleStripeEvent({
      id: `evt_unpaid_co_${created.body._id}`,
      type: "checkout.session.completed",
      data: {
        object: {
          id: `cs_unpaid_${created.body._id}`,
          mode: "subscription",
          payment_status: "unpaid",
          amount_total: 1200,
          customer: customerId,
          invoice: `in_unpaid_${created.body._id}`,
          metadata: { userId: String(created.body._id), plan: "pro" },
        },
      },
    });
    await handleStripeEvent({
      id: `evt_free_co_${created.body._id}`,
      type: "checkout.session.completed",
      data: {
        object: {
          id: `cs_free_${created.body._id}`,
          mode: "subscription",
          payment_status: "no_payment_required",
          amount_total: 0,
          customer: customerId,
          invoice: `in_free_${created.body._id}`,
          metadata: { userId: String(created.body._id), plan: "pro" },
        },
      },
    });
    await handleStripeEvent({
      id: `evt_zero_inv_${created.body._id}`,
      type: "invoice.paid",
      data: {
        object: {
          id: `in_zero_${created.body._id}`,
          customer: customerId,
          billing_reason: "subscription_create",
          paid: true,
          amount_paid: 0,
          amount_due: 0,
          currency: "gbp",
        },
      },
    });
    await handleStripeEvent({
      id: `evt_unpaid_topup_${created.body._id}`,
      type: "checkout.session.completed",
      data: {
        object: {
          id: `cs_topup_unpaid_${created.body._id}`,
          mode: "payment",
          payment_status: "unpaid",
          amount_total: 1200,
          customer: customerId,
          metadata: {
            userId: String(created.body._id),
            type: "credit_topup",
            packs: "1",
          },
        },
      },
    });

    const user = await User.findById(created.body._id).select(
      "token_credit_balance subscriptionTier",
    );
    expect(user.token_credit_balance).toBe(0);
    expect(user.subscriptionTier).toBe("free");
    expect(await CreditGrant.countDocuments({ userId: created.body._id })).toBe(0);
  });

  test("webhook without signature is 400 once Stripe webhook secret is set", async () => {
    const prevSecret = process.env.STRIPE_SECRET_KEY;
    const prevWhsec = process.env.STRIPE_WEBHOOK_SECRET;
    process.env.STRIPE_SECRET_KEY = "sk_test_billing_dummy";
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_test_secret";
    resetStripeClientForTests();

    const res = await request(app)
      .post("/api/stripe/webhook")
      .set("Content-Type", "application/json")
      .send({ type: "invoice.paid" });
    expect(res.status).toBe(400);
    expect(String(res.text)).toMatch(/Webhook Error/i);

    if (prevSecret) process.env.STRIPE_SECRET_KEY = prevSecret;
    else delete process.env.STRIPE_SECRET_KEY;
    if (prevWhsec) process.env.STRIPE_WEBHOOK_SECRET = prevWhsec;
    else delete process.env.STRIPE_WEBHOOK_SECRET;
    resetStripeClientForTests();
  });
});
