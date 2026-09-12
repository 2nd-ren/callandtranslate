import mongoose from "mongoose";
import request from "supertest";
import config from "config";
import app from "../app.js";
import { User } from "../models/user.js";
import CallAgentSession from "../models/callAgentSession.js";
import { UsageRecord } from "../models/usageRecord.js";
import { CreditGrant } from "../models/creditGrant.js";
import { AdminActivity } from "../models/adminActivity.js";
import { register, registerAdmin } from "./helpers.js";
import seedInitialAdmins from "../startup/seedAdmins.js";

describe("Admin dashboard", () => {
  beforeAll(async () => {
    await mongoose.connect(config.get("db"));
    await Promise.all([CreditGrant.init(), AdminActivity.init()]);
  });

  afterAll(async () => {
    try {
      await Promise.all([
        User.deleteMany({ email: /@(example\.com|delvecreative\.eu)$/ }),
        CallAgentSession.deleteMany({}),
        UsageRecord.deleteMany({}),
        CreditGrant.deleteMany({}),
        AdminActivity.deleteMany({}),
      ]);
    } catch (err) {
      console.warn("admin test cleanup:", err.message);
    }
    await mongoose.disconnect();
  });

  test("dashboard requires auth", async () => {
    const res = await request(app).get("/api/admin/dashboard");
    expect(res.status).toBe(401);
  });

  test("non-admin cannot open the dashboard or HTML page", async () => {
    const agent = request.agent(app);
    const { token } = await register(agent);
    const api = await agent
      .get("/api/admin/dashboard")
      .set("x-auth-token", token);
    expect(api.status).toBe(403);
    expect(api.body.code).toBe("ADMIN_REQUIRED");

    const page = await agent.get("/admin").set("x-auth-token", token);
    expect(page.status).toBe(302);
    expect(page.headers.location).toBe("/app.html");
  });

  test("unauthenticated HTML /admin redirects to login", async () => {
    const page = await request(app).get("/admin");
    expect(page.status).toBe(302);
    expect(page.headers.location).toBe("/index.html");
  });

  test("admin can load users, subscriptions, analytics, and HTML", async () => {
    const agent = request.agent(app);
    const adminUser = await registerAdmin(agent, {
      name: "Ada Admin",
      email: `ada${Date.now()}@example.com`,
    });
    const member = await register(agent, {
      name: "Crew Member",
      email: `crew${Date.now()}@example.com`,
    });
    await User.updateOne(
      { _id: member.userId },
      {
        $set: {
          subscriptionTier: "pro",
          subscriptionStatus: "active",
          token_credit_balance: 50000,
        },
      },
    );
    await UsageRecord.create({
      userId: member.userId,
      callType: "section-tidy",
      model: "grok-4.6",
      totalTokens: 120,
      creditsDeducted: 120,
      cost: 0.001,
      success: true,
    });

    const dash = await agent
      .get("/api/admin/dashboard")
      .set("x-auth-token", adminUser.token);
    expect(dash.status).toBe(200);
    expect(Array.isArray(dash.body.users)).toBe(true);
    const crew = dash.body.users.find(
      (row) => String(row.id) === String(member.userId),
    );
    expect(crew).toBeTruthy();
    expect(crew.subscription.tier).toBe("pro");
    expect(crew.credits).toBe(50000);
    expect(crew.creditsUsed).toBe(120);
    expect(dash.body.plans.map((plan) => plan.id)).toEqual(["free", "pro"]);
    expect(dash.body.totals.totalUsers).toBeGreaterThanOrEqual(2);

    const analytics = await agent
      .get("/api/admin/model-usage/analytics")
      .query({ range: "month" })
      .set("x-auth-token", adminUser.token);
    expect(analytics.status).toBe(200);
    expect(analytics.body.periodTotalCredits).toBeGreaterThanOrEqual(120);
    expect(analytics.body.series.length).toBeGreaterThan(0);

    const page = await agent.get("/admin").set("x-auth-token", adminUser.token);
    expect(page.status).toBe(200);
    expect(page.text).toContain("Admin Dashboard");
    expect(page.text).toContain("Message all users");
    expect(page.text).toContain("Modify credits");
    expect(page.text).toContain("Going to expire");
    expect(page.text).toContain("Valid credits");
    expect(page.text).toContain("Change plan");
    expect(page.text).toContain("Type DELETE to confirm");
    expect(page.headers["x-robots-tag"]).toMatch(/noindex/);

    const cookiePage = await request(app)
      .get("/admin")
      .set("Cookie", `authToken=${adminUser.token}`);
    expect(cookiePage.status).toBe(200);
  });

  test("admin can add credits, message a user, and broadcast", async () => {
    const agent = request.agent(app);
    const adminUser = await registerAdmin(agent, {
      email: `adminmsg${Date.now()}@example.com`,
    });
    const member = await register(agent, {
      name: "Pat",
      email: `pat${Date.now()}@example.com`,
    });

    const credits = await agent
      .post(`/api/admin/users/${member.userId}/credits`)
      .set("x-auth-token", adminUser.token)
      .send({ credits: 2500, message: "Courtesy top-up." });
    expect(credits.status).toBe(200);
    expect(credits.body.creditsAdded).toBe(2500);
    const updated = await User.findById(member.userId);
    expect(updated.token_credit_balance).toBe(2500);
    const ledger = await agent
      .get(`/api/admin/users/${member.userId}/credits`)
      .set("x-auth-token", adminUser.token);
    expect(ledger.status).toBe(200);
    expect(ledger.body.balance).toBe(2500);
    expect(ledger.body.lots[0].purchased).toBe(2500);
    expect(ledger.body.lots[0].goingToExpire).toBe(2500);
    const addLog = await UsageRecord.findOne({
      userId: member.userId,
      callType: "admin-credit-change",
    }).sort({ createdAt: -1 });
    expect(addLog).toBeTruthy();
    expect(addLog.metadata.delta).toBe(2500);
    expect(addLog.metadata.newBalance).toBe(2500);

    const message = await agent
      .post(`/api/admin/users/${member.userId}/message`)
      .set("x-auth-token", adminUser.token)
      .send({
        subject: "Hello from admin",
        message: "Please check your call brief.",
      });
    expect(message.status).toBe(200);
    expect(message.body.success).toBe(true);

    const broadcast = await agent
      .post("/api/admin/message-all/send")
      .set("x-auth-token", adminUser.token)
      .send({
        subject: "Service note",
        message: "The share QR download is live.",
      });
    expect(broadcast.status).toBe(200);
    expect(broadcast.body.sent).toBeGreaterThanOrEqual(2);

    const draft = await agent
      .post("/api/admin/message-all/draft")
      .set("x-auth-token", adminUser.token)
      .send({ prompt: "Tell users about a new feature" });
    expect(draft.status).toBe(503);
  });

  test("admin can set a credit balance and the change is logged", async () => {
    const agent = request.agent(app);
    const adminUser = await registerAdmin(agent, {
      email: `adminset${Date.now()}@example.com`,
    });
    const member = await register(agent, {
      name: "Pat",
      email: `setcredits${Date.now()}@example.com`,
    });
    await User.updateOne(
      { _id: member.userId },
      { $set: { token_credit_balance: 1000 } },
    );

    const setCreditsRes = await agent
      .post(`/api/admin/users/${member.userId}/credits`)
      .set("x-auth-token", adminUser.token)
      .send({ credits: 400, mode: "set" });
    expect(setCreditsRes.status).toBe(200);
    expect(setCreditsRes.body.updatedBalance).toBe(400);
    expect(setCreditsRes.body.creditsRemoved).toBe(600);
    expect(setCreditsRes.body.previousBalance).toBe(1000);

    const updated = await User.findById(member.userId);
    expect(updated.token_credit_balance).toBe(400);

    const log = await UsageRecord.findOne({
      userId: member.userId,
      callType: "admin-credit-change",
    }).sort({ createdAt: -1 });
    expect(log).toBeTruthy();
    expect(log.metadata.previousBalance).toBe(1000);
    expect(log.metadata.newBalance).toBe(400);
    expect(log.metadata.delta).toBe(-600);
    expect(log.metadata.mode).toBe("set");
    expect(log.creditsDeducted).toBe(0);
  });

  test("admin can override plan and delete a non-admin user", async () => {
    const agent = request.agent(app);
    const adminUser = await registerAdmin(agent, {
      email: `admindel${Date.now()}@example.com`,
    });
    const member = await register(agent, {
      email: `gone${Date.now()}@example.com`,
    });

    const tier = await agent
      .put(`/api/admin/users/${member.userId}/tier`)
      .set("x-auth-token", adminUser.token)
      .send({ tier: "pro" });
    expect(tier.status).toBe(200);
    expect(tier.body.newTier).toBe("pro");
    const promoted = await User.findById(member.userId);
    expect(promoted.subscriptionTier).toBe("pro");
    expect(promoted.subscriptionStatus).toBe("active");

    const deniedSelf = await agent
      .delete(`/api/admin/users/${adminUser.userId}`)
      .set("x-auth-token", adminUser.token);
    expect(deniedSelf.status).toBe(403);

    const deleted = await agent
      .delete(`/api/admin/users/${member.userId}`)
      .set("x-auth-token", adminUser.token);
    expect(deleted.status).toBe(200);
    expect(deleted.body.purged).toBe(true);
    expect(await User.findById(member.userId)).toBeNull();
  });

  test("seedInitialAdmins promotes jacob@delvecreative.eu", async () => {
    const email = "jacob@delvecreative.eu";
    await User.deleteMany({ email });
    const created = await register(request.agent(app), {
      name: "Jacob",
      email,
      password: "secret12",
    });
    expect(created.res.status).toBe(201);
    await User.updateOne({ email }, { $set: { isAdmin: false, role: "user" } });
    await seedInitialAdmins();
    const user = await User.findOne({ email });
    expect(user.isAdmin).toBe(true);
    expect(user.role).toBe("admin");
    expect(user.emailValidated).toBe(true);
  });

  test("admin menu includes Admin for privileged users", async () => {
    const agent = request.agent(app);
    const adminUser = await registerAdmin(agent, {
      email: `menua${Date.now()}@example.com`,
    });
    const menu = await agent
      .get("/api/menu/main")
      .set("x-auth-token", adminUser.token);
    expect(menu.status).toBe(200);
    const labels = menu.body.menu.right.map((item) => item.label);
    expect(labels).toContain("Admin");
  });
});
