import { User } from "../models/user.js";

export async function registerAccount(agent, overrides = {}) {
  const email =
    overrides.email ||
    `user${Date.now()}${Math.random().toString(16).slice(2)}@example.com`;
  const password = overrides.password || "secret12";
  const res = await agent.post("/api/users").send({
    name: overrides.name || "Test User",
    email,
    password,
    termsAccepted: overrides.termsAccepted !== undefined ? overrides.termsAccepted : true,
    legalVersion: overrides.legalVersion,
  });
  return { res, email, password };
}

export async function verifyEmailFor(agent, email) {
  const user = await User.findOne({ email });
  if (!user) throw new Error(`No user for ${email}`);
  const token = user.generateEmailVerificationToken();
  const verified = await agent.get("/api/users/verify-email").query({ token });
  return {
    verified,
    user,
    token: verified.body.token || verified.body.authToken,
  };
}

/** Create a verified account and attach a session token onto the register response. */
export async function register(agent, overrides = {}) {
  const created = await registerAccount(agent, overrides);
  if (created.res.status !== 201) return created;
  const { user, token } = await verifyEmailFor(agent, created.email);
  created.res.body.token = token;
  created.res.body._id = created.res.body._id || user._id;
  created.token = token;
  created.userId = user._id;
  return created;
}

export async function registerAdmin(agent, overrides = {}) {
  const created = await register(agent, overrides);
  if (created.res.status !== 201) return created;
  await User.updateOne(
    { _id: created.userId },
    { $set: { isAdmin: true, role: "admin" } },
  );
  return created;
}
