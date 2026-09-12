import mongoose from "mongoose";
import request from "supertest";
import config from "config";
import app from "../app.js";
import { User } from "../models/user.js";
import { CreditGrant } from "../models/creditGrant.js";
import { UsageRecord } from "../models/usageRecord.js";
import { addCreditLot, expireAndSyncBalance, getCreditLedger } from "../utils/creditLots.js";
import { deductCredits } from "../utils/userCredits.js";
import { logLlmUsage, logTranscriptionUsage, logVoiceUsage } from "../utils/usageLogger.js";
import { register } from "./helpers.js";

describe("credit lots and xAI usage billing", () => {
  beforeAll(async () => {
    await mongoose.connect(config.get("db"));
    await CreditGrant.init();
  });

  afterAll(async () => {
    try {
      await Promise.all([
        User.deleteMany({ email: /@example\.com$/ }),
        CreditGrant.deleteMany({}),
        UsageRecord.deleteMany({}),
      ]);
    } catch (err) {
      console.warn("credit lot test cleanup:", err.message);
    }
    await mongoose.disconnect();
  });

  test("deducts FIFO from the oldest unexpired lot", async () => {
    const agent = request.agent(app);
    const { res: created } = await register(agent);
    const userId = created.body._id;
    await addCreditLot(userId, 100, {
      invoiceId: `fifo-a-${userId}`,
      source: "test",
      purchaseMethod: "first",
    });
    await addCreditLot(userId, 50, {
      invoiceId: `fifo-b-${userId}`,
      source: "test",
      purchaseMethod: "second",
    });
    const spent = await deductCredits(userId, 120, { reason: "tidy", callType: "section-tidy" });
    expect(spent.success).toBe(true);
    expect(spent.newBalance).toBe(30);
    const ledger = await getCreditLedger(userId);
    const byMethod = Object.fromEntries(
      ledger.lots.map((lot) => [lot.purchaseMethod, lot]),
    );
    expect(byMethod.first.used).toBe(100);
    expect(byMethod.first.remaining).toBe(0);
    expect(byMethod.second.used).toBe(20);
    expect(byMethod.second.remaining).toBe(30);
    expect(byMethod.second.goingToExpire).toBe(30);
  });

  test("expires leftover credits 30 days after purchase", async () => {
    const agent = request.agent(app);
    const { res: created } = await register(agent);
    const userId = created.body._id;
    const purchasedAt = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
    await addCreditLot(userId, 800, {
      invoiceId: `exp-${userId}`,
      source: "test",
      purchasedAt,
    });
    const synced = await expireAndSyncBalance(userId);
    expect(synced.balance).toBe(0);
    const ledger = await getCreditLedger(userId);
    expect(ledger.totals.expired).toBe(800);
    expect(ledger.totals.remaining).toBe(0);
    expect(ledger.lots[0].expired).toBe(800);
  });

  test("voice usage deducts one credit per second", async () => {
    const agent = request.agent(app);
    const { res: created } = await register(agent);
    const userId = created.body._id;
    await addCreditLot(userId, 1000, {
      invoiceId: `usage-${userId}`,
      source: "test",
    });
    const voice = await logVoiceUsage({
      userId,
      durationSec: 90,
    });
    expect(voice.credits).toBe(90);
    const user = await User.findById(userId).select("token_credit_balance");
    expect(user.token_credit_balance).toBe(910);
  });

  test("Grok token usage deducts call seconds from xAI cost", async () => {
    const agent = request.agent(app);
    const { res: created } = await register(agent);
    const userId = created.body._id;
    await addCreditLot(userId, 1000, {
      invoiceId: `llm-${userId}`,
      source: "test",
    });
    const billed = await logLlmUsage({
      userId,
      callType: "call-brief-fill",
      model: "grok-4.6",
      usage: {
        prompt_tokens: 1000,
        completion_tokens: 500,
        completion_tokens_details: { reasoning_tokens: 200 },
      },
      skipDeduct: false,
    });
    expect(billed.cost).toBeCloseTo(0.0062, 6);
    expect(billed.credits).toBe(5);
    expect(billed.deducted).toBe(true);
    const user = await User.findById(userId).select("token_credit_balance");
    expect(user.token_credit_balance).toBe(995);
    const record = await UsageRecord.findOne({ userId, callType: "call-brief-fill" });
    expect(record.creditsDeducted).toBe(5);
    expect(record.reasoningTokens).toBe(200);
  });

  test("REST speech-to-text deducts call seconds from xAI STT cost", async () => {
    const agent = request.agent(app);
    const { res: created } = await register(agent);
    const userId = created.body._id;
    await addCreditLot(userId, 1000, {
      invoiceId: `stt-${userId}`,
      source: "test",
    });
    const billed = await logTranscriptionUsage({
      userId,
      durationSec: 60,
      model: "xai-stt-rest",
      streaming: false,
      skipDeduct: false,
    });
    expect(billed.cost).toBeCloseTo(0.1 / 60, 8);
    expect(billed.credits).toBe(2);
    const user = await User.findById(userId).select("token_credit_balance");
    expect(user.token_credit_balance).toBe(998);
  });
});
