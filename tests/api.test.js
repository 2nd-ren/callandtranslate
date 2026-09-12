import mongoose from "mongoose";
import request from "supertest";
import config from "config";
import app from "../app.js";
import { User } from "../models/user.js";
import { RefreshToken } from "../models/refreshToken.js";
import { UsageRecord } from "../models/usageRecord.js";
import { CreditGrant } from "../models/creditGrant.js";
import CallAgentTemplate from "../models/callAgentTemplate.js";
import CallAgentSession from "../models/callAgentSession.js";
import { grantProPlanLocally } from "../utils/plans.js";
import { register, registerAccount, verifyEmailFor } from "./helpers.js";
import {
  ACCOUNT_DELETION_GRACE_MS,
  purgeExpiredAccounts,
} from "../utils/accountDeletion.js";

describe("Call & Translate API", () => {
  beforeAll(async () => {
    await mongoose.connect(config.get("db"));
  });

  afterAll(async () => {
    try {
      await Promise.all([
        User.deleteMany({ email: /@example\.com$/ }),
        RefreshToken.deleteMany({}),
        UsageRecord.deleteMany({}),
        CreditGrant.deleteMany({}),
        CallAgentTemplate.deleteMany({}),
        CallAgentSession.deleteMany({}),
      ]);
    } catch (err) {
      console.warn("test cleanup:", err.message);
    }
    await mongoose.disconnect();
  });

  test("health", async () => {
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body.app).toBe("Call & Translate");
  });

  test("about page is public", async () => {
    const res = await request(app).get("/about");
    expect(res.status).toBe(200);
    expect(res.text).toMatch(/Someone to make the call/i);
    expect(res.text).toMatch(/When they ask for something it doesn.t have/i);
  });

  test("landing page positions the product", async () => {
    const res = await request(app).get("/");
    expect(res.status).toBe(200);
    expect(res.text).toMatch(/We.ll make the call/i);
    expect(res.text).toMatch(/New in a country/i);
    expect(res.text).toMatch(/Teams without a translator/i);
    expect(res.text).toMatch(/data-theme-toggle/);
    expect(res.text).not.toMatch(/>Theme<\/button>/);
  });

  test("signed-in users can save a light, dark, or system theme", async () => {
    const agent = request.agent(app);
    const { token } = await register(agent);

    const invalid = await agent
      .put("/api/users/me/preferences")
      .set("x-auth-token", token)
      .send({ userPreferences: { theme: "neon" } });
    expect(invalid.status).toBe(400);

    const saved = await agent
      .put("/api/users/me/preferences")
      .set("x-auth-token", token)
      .send({ userPreferences: { theme: "light" } });
    expect(saved.status).toBe(200);
    expect(saved.body.userPreferences.theme).toBe("light");

    const me = await agent.get("/api/users/me").set("x-auth-token", token);
    expect(me.status).toBe(200);
    expect(me.body.userPreferences.theme).toBe("light");

    const system = await agent
      .put("/api/users/me/preferences")
      .set("x-auth-token", token)
      .send({ userPreferences: { theme: "system" } });
    expect(system.status).toBe(200);
    expect(system.body.userPreferences.theme).toBe("system");
  });

  test("register starts with zero credits and requires verification", async () => {
    const agent = request.agent(app);
    const { res: created, email } = await registerAccount(agent);
    expect(created.status).toBe(201);
    expect(created.body.verificationRequired).toBe(true);
    expect(created.body.token_credit_balance).toBe(0);
    expect(created.body.subscriptionTier).toBe("free");

    const loginBlocked = await agent
      .post("/api/auth")
      .send({ email, password: "secret12" });
    expect(loginBlocked.status).toBe(403);
    expect(loginBlocked.body.code).toBe("EMAIL_NOT_VERIFIED");

    const { token } = await verifyEmailFor(agent, email);
    const login = await agent.post("/api/auth").send({ email, password: "secret12" });
    expect(login.status).toBe(200);
    expect(login.body.token || token).toBeTruthy();
    expect(login.body.token_credit_balance).toBe(0);
  });

  test("free user can save templates and sessions but cannot mint a voice token", async () => {
    const agent = request.agent(app);
    const { token } = await register(agent);
    const template = await agent
      .post("/api/call-agent/templates")
      .set("x-auth-token", token)
      .send({
        name: "Hotel desk",
        fields: {
          goal: "Ask if a room is available Friday",
          theirLanguage: "fr",
          yourLanguage: "en",
          yourName: "Ada Lovelace",
        },
      });
    expect(template.status).toBe(201);
    expect(template.body.template.fields.theirLanguage).toBe("fr");
    expect(template.body.template.fields.yourName).toBe("Ada Lovelace");

    const session = await agent
      .post("/api/call-agent/sessions")
      .set("x-auth-token", token)
      .send({
        name: "Test call",
        fields: { goal: "Ask for hours" },
        transcript: [{ speaker: "Caller", text: "Bonjour" }],
      });
    expect(session.status).toBe(201);

    const voice = await agent
      .post("/api/voice/token")
      .set("x-auth-token", token)
      .send({ goal: "Ask for hours" });
    expect(voice.status).toBe(402);
    expect(voice.body.code).toBe("INSUFFICIENT_CALL_TIME");
  });

  test("dictate-and-fill requires notes or audio, credits, and Grok", async () => {
    const agent = request.agent(app);
    const created = await register(agent);

    const empty = await agent
      .post("/api/call-agent/fill-brief")
      .set("x-auth-token", created.token)
      .send({});
    expect(empty.status).toBe(400);

    const noTime = await agent
      .post("/api/call-agent/fill-brief")
      .set("x-auth-token", created.token)
      .send({ notes: "Extend the hotel stay two nights." });
    expect(noTime.status).toBe(402);
    expect(noTime.body.code).toBe("INSUFFICIENT_CALL_TIME");

    await grantProPlanLocally(created.userId);
    const noGrok = await agent
      .post("/api/call-agent/fill-brief")
      .set("x-auth-token", created.token)
      .send({ notes: "Extend the hotel stay two nights." });
    expect(noGrok.status).toBe(503);
    expect(noGrok.body.code).toBe("XAI_NOT_CONFIGURED");
  });

  test("transcribe-dictation requires audio, credits, and Grok", async () => {
    const agent = request.agent(app);
    const created = await register(agent);

    const empty = await agent
      .post("/api/call-agent/transcribe-dictation")
      .set("x-auth-token", created.token)
      .send({});
    expect(empty.status).toBe(400);
    expect(empty.body.code).toBe("DICTATE_AUDIO_MISSING");

    const noTime = await agent
      .post("/api/call-agent/transcribe-dictation")
      .set("x-auth-token", created.token)
      .send({ audioBase64: "aGVsbG8=", mimeType: "audio/webm" });
    expect(noTime.status).toBe(402);
    expect(noTime.body.code).toBe("INSUFFICIENT_CALL_TIME");

    await grantProPlanLocally(created.userId);
    const noGrok = await agent
      .post("/api/call-agent/transcribe-dictation")
      .set("x-auth-token", created.token)
      .send({ audioBase64: "aGVsbG8=", mimeType: "audio/webm" });
    expect(noGrok.status).toBe(503);
    expect(noGrok.body.code).toBe("XAI_NOT_CONFIGURED");
  });

  test("paid grant allows a voice token preflight when xAI is configured, else 503", async () => {
    const agent = request.agent(app);
    const created = await register(agent);
    await grantProPlanLocally(created.userId);
    const voice = await agent
      .post("/api/voice/token")
      .set("x-auth-token", created.token)
      .send({ goal: "Book a table" });
    expect([200, 502, 503]).toContain(voice.status);
    if (voice.status === 503) {
      expect(voice.body.error).toMatch(/not configured/i);
    }
  });

  test("plans are free plus paid at £12 with an hour of call time", async () => {
    const plans = await request(app).get("/api/subscriptions/plans");
    expect(plans.status).toBe(200);
    expect(plans.body.plans.map((p) => p.id)).toEqual(["free", "pro"]);
    expect(plans.body.plans[1].priceGbp).toBe(12);
    expect(plans.body.plans[1].monthlyCredits).toBe(3600);
    expect(plans.body.creditCalculator.monthlyCredits).toBe(3600);
    expect(plans.body.creditTopUp.credits).toBe(3600);
    expect(plans.body.creditTopUp.priceGbp).toBe(12);
  });

  test("app chrome uses an icon theme menu", async () => {
    const res = await request(app).get("/app.html");
    expect(res.status).toBe(200);
    expect(res.text).toMatch(/data-theme-menu/);
    expect(res.text).not.toMatch(/>Theme<\/button>/);
    expect(res.text).toMatch(/Dictate and fill/);
    expect(res.text).toMatch(/uses some of your remaining call time/);
    expect(res.text).toMatch(/id="dictateWave"/);
    expect(res.text).toMatch(/id="fillNotesWorking"/);
    expect(res.text).toMatch(/Filling brief/);
    expect(res.text).toMatch(/id="followUpModal"/);
    expect(res.text).toMatch(/They’ll likely ask for more/);
    expect(res.text).toMatch(/smoother this will go/);
    expect(res.text).toMatch(/id="followUpDictateBtn"/);
  });

  test("apply-follow-ups requires answers, credits, and can merge without Grok", async () => {
    const agent = request.agent(app);
    const created = await register(agent);

    const empty = await agent
      .post("/api/call-agent/apply-follow-ups")
      .set("x-auth-token", created.token)
      .send({});
    expect(empty.status).toBe(400);
    expect(empty.body.code).toBe("FOLLOW_UP_MISSING");

    const noTime = await agent
      .post("/api/call-agent/apply-follow-ups")
      .set("x-auth-token", created.token)
      .send({
        existingGoal: "Extend the stay",
        existingInformation: "Name: Ada",
        answers: [{ question: "Booking number?", answer: "4419" }],
      });
    expect(noTime.status).toBe(402);
    expect(noTime.body.code).toBe("INSUFFICIENT_CALL_TIME");

    await grantProPlanLocally(created.userId);
    const merged = await agent
      .post("/api/call-agent/apply-follow-ups")
      .set("x-auth-token", created.token)
      .send({
        existingGoal: "Extend the stay",
        existingInformation: "Name: Ada",
        calling: "hotel front desk",
        answers: [{ question: "Booking number?", answer: "4419" }],
      });
    expect(merged.status).toBe(200);
    expect(merged.body.fields.information).toMatch(/4419/);
    expect(merged.body.fields.goal).toMatch(/Extend the stay/i);
    if (!process.env.XAI_API_KEY) {
      expect(merged.body.mergedLocally).toBe(true);
    }
  });

  test("dictation waveform assets are served", async () => {
    const appJs = await request(app).get("/js/app.js");
    expect(appJs.status).toBe(200);
    expect(appJs.text).toMatch(/wavesurfer/);
    expect(appJs.text).toMatch(/transcribe-dictation/);
    expect(appJs.text).toMatch(/apply-follow-ups/);
    const ws = await request(app).get("/js/vendor/wavesurfer.esm.js");
    expect(ws.status).toBe(200);
    const record = await request(app).get("/js/vendor/wavesurfer.record.esm.js");
    expect(record.status).toBe(200);
  });

  test("menu includes Call & Translate branding", async () => {
    const agent = request.agent(app);
    const { token } = await register(agent);
    const menu = await agent.get("/api/menu/main").set("x-auth-token", token);
    expect(menu.status).toBe(200);
    expect(menu.body.menu.left.content[0].text).toBe("Call & Translate");
  });

  test("account deletion purges sessions after the grace period", async () => {
    const agent = request.agent(app);
    const created = await register(agent);
    await agent
      .post("/api/call-agent/sessions")
      .set("x-auth-token", created.token)
      .send({ name: "To delete", fields: { goal: "x" } });
    await agent
      .post("/api/users/me/deletion")
      .set("x-auth-token", created.token)
      .send({ confirm: true });
    await User.updateOne(
      { _id: created.userId },
      {
        $set: {
          deletionScheduledAt: new Date(Date.now() - ACCOUNT_DELETION_GRACE_MS - 1000),
        },
      },
    );
    const result = await purgeExpiredAccounts();
    expect(result.purged).toBeGreaterThanOrEqual(1);
    expect(await User.findById(created.userId)).toBeNull();
    expect(await CallAgentSession.countDocuments({ ownerId: created.userId })).toBe(0);
  });
});
