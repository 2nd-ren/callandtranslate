import mongoose from "mongoose";
import request from "supertest";
import config from "config";
import app from "../app.js";
import { User } from "../models/user.js";
import { LEGAL_VERSION } from "../utils/legal.js";
import { registerAccount } from "./helpers.js";

describe("legal pages and registration consent", () => {
  beforeAll(async () => {
    await mongoose.connect(config.get("db"));
  });

  afterAll(async () => {
    try {
      await User.deleteMany({ email: /@example\.com$/ });
    } catch (err) {
      console.warn("legal test cleanup:", err.message);
    }
    await mongoose.disconnect();
  });

  const pages = [
    ["/privacy", "Privacy Policy", "GDPR"],
    ["/privacy.html", "Privacy Policy", "Your rights"],
    ["/privacy-policy", "Privacy Policy", "data controller"],
    ["/cookies", "Cookie Policy", "cat_cookie_consent"],
    ["/cookie-policy", "Cookie Policy", "Strictly necessary"],
    ["/terms", "Terms of Service", "Limitation of liability"],
    ["/terms-of-service", "Terms of Service", "as is"],
    ["/acceptable-use", "Acceptable Use Policy", "lawful"],
    ["/acceptable-use-policy", "Acceptable Use Policy", "Harass"],
  ];

  test.each(pages)("%s is published", async (path, title, snippet) => {
    const res = await request(app).get(path);
    expect(res.status).toBe(200);
    expect(res.text).toContain(title);
    expect(res.text).toMatch(new RegExp(snippet, "i"));
    expect(res.text).toContain("/privacy");
    expect(res.text).toContain("/terms");
    expect(res.text).toContain("data-cookie-settings");
  });

  test("landing and register point at the legal documents", async () => {
    const home = await request(app).get("/index.html");
    expect(home.status).toBe(200);
    expect(home.text).toContain('href="/privacy"');
    expect(home.text).toContain('href="/terms"');
    expect(home.text).toContain('href="/cookies"');
    expect(home.text).toContain('href="/acceptable-use"');

    const register = await request(app).get("/register.html");
    expect(register.status).toBe(200);
    expect(register.text).toContain("termsAccepted");
    expect(register.text).toContain("Terms of Service");
    expect(register.text).toContain("Privacy Policy");
  });

  test("register rejects missing terms acceptance", async () => {
    const res = await request(app).post("/api/users").send({
      name: "No Terms",
      email: `noterms${Date.now()}@example.com`,
      password: "secret12",
    });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/Terms of Service and Privacy Policy/i);
  });

  test("register rejects termsAccepted false", async () => {
    const res = await request(app).post("/api/users").send({
      name: "No Terms",
      email: `falseterms${Date.now()}@example.com`,
      password: "secret12",
      termsAccepted: false,
    });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/Terms of Service and Privacy Policy/i);
  });

  test("register stores terms acceptance and legal version", async () => {
    const agent = request.agent(app);
    const { res, email } = await registerAccount(agent, {
      email: `legalok${Date.now()}@example.com`,
      legalVersion: LEGAL_VERSION,
    });
    expect(res.status).toBe(201);
    const user = await User.findOne({ email });
    expect(user).toBeTruthy();
    expect(user.termsAcceptedAt).toBeInstanceOf(Date);
    expect(user.privacyAcknowledgedAt).toBeInstanceOf(Date);
    expect(user.legalVersionAccepted).toBe(LEGAL_VERSION);
  });
});
