import bcrypt from "bcrypt";
import crypto from "crypto";
import logger from "../middleware/logger.js";
import { User } from "../models/user.js";

export const INITIAL_ADMINS = [
  { name: "Jacob", email: "jacob@delvecreative.eu" },
];

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export default async function seedInitialAdmins(admins = INITIAL_ADMINS) {
  for (const admin of admins) {
    const email = String(admin.email || "")
      .trim()
      .toLowerCase();
    if (!email) continue;

    let user = await User.findOne({
      email: { $regex: new RegExp(`^${escapeRegex(email)}$`, "i") },
    });

    if (!user) {
      const salt = await bcrypt.genSalt(10);
      const password = await bcrypt.hash(
        crypto.randomBytes(32).toString("hex"),
        salt,
      );
      user = new User({
        name: admin.name || "Admin",
        email,
        password,
        role: "admin",
        isAdmin: true,
        isDev: false,
        emailValidated: true,
        subscriptionTier: "free",
        subscriptionStatus: "none",
        token_credit_balance: 0,
      });
      await user.save();
      logger.info(`Seeded admin account for ${email}`);
      continue;
    }

    let changed = false;
    if (user.email !== email) {
      user.email = email;
      changed = true;
    }
    if (!user.isAdmin) {
      user.isAdmin = true;
      changed = true;
    }
    if (user.role !== "admin") {
      user.role = "admin";
      changed = true;
    }
    if (!user.emailValidated) {
      user.emailValidated = true;
      changed = true;
    }
    if (changed) {
      await user.save();
      logger.info(`Promoted ${email} to admin`);
    }
  }
}
