import logger from "../middleware/logger.js";
import { User } from "../models/user.js";
import { RefreshToken } from "../models/refreshToken.js";
import { UsageRecord } from "../models/usageRecord.js";
import { CreditGrant } from "../models/creditGrant.js";
import CallAgentTemplate from "../models/callAgentTemplate.js";
import CallAgentSession from "../models/callAgentSession.js";
import { getStripe } from "./stripeClient.js";

export const ACCOUNT_DELETION_GRACE_MS = 24 * 60 * 60 * 1000;
const SWEEP_INTERVAL_MS = 60 * 1000;

let sweepTimer = null;

export function isAccountDeletionDue(user, now = new Date()) {
  if (!user?.deletionScheduledAt) return false;
  return new Date(user.deletionScheduledAt).getTime() <= now.getTime();
}

export function deletionStatus(user) {
  const at = user?.deletionScheduledAt || null;
  return {
    deletionPending: Boolean(at),
    deletionScheduledAt: at,
  };
}

export async function purgeIfDeletionDue(user) {
  if (!isAccountDeletionDue(user)) return false;
  await purgeUserData(user._id);
  return true;
}

async function removeStripeRecords(user) {
  const stripe = getStripe();
  if (!stripe) return;
  if (user.stripeSubscriptionId) {
    try {
      await stripe.subscriptions.cancel(String(user.stripeSubscriptionId));
    } catch (err) {
      logger.warn(
        `Stripe subscription cancel failed for user ${user._id}: ${err.message}`,
      );
    }
  }
  if (user.stripeCustomerId) {
    try {
      await stripe.customers.del(String(user.stripeCustomerId));
    } catch (err) {
      logger.warn(
        `Stripe customer delete failed for user ${user._id}: ${err.message}`,
      );
    }
  }
}

export async function purgeUserData(userId) {
  const user = await User.findById(userId);
  if (!user) return { purged: false };

  await removeStripeRecords(user);

  await Promise.all([
    CallAgentTemplate.deleteMany({ ownerId: user._id }),
    CallAgentSession.deleteMany({ ownerId: user._id }),
    RefreshToken.deleteMany({ userId: user._id }),
    UsageRecord.deleteMany({ userId: user._id }),
    CreditGrant.deleteMany({ userId: user._id }),
  ]);

  await User.deleteOne({ _id: user._id });
  return { purged: true, userId: String(user._id) };
}

export async function purgeExpiredAccounts(now = new Date()) {
  const due = await User.find({
    deletionScheduledAt: { $ne: null, $lte: now },
  }).select("_id");
  let purged = 0;
  for (const row of due) {
    try {
      const result = await purgeUserData(row._id);
      if (result.purged) purged += 1;
    } catch (err) {
      logger.error(`Failed to purge deleted account ${row._id}: ${err.message}`);
    }
  }
  return { purged, checked: due.length };
}

export function startAccountDeletionSweeper() {
  if (sweepTimer) return;
  const run = () => {
    purgeExpiredAccounts().catch((err) => {
      logger.error(`account deletion sweep failed: ${err.message}`);
    });
  };
  run();
  sweepTimer = setInterval(run, SWEEP_INTERVAL_MS);
  if (typeof sweepTimer.unref === "function") sweepTimer.unref();
}

export function stopAccountDeletionSweeper() {
  if (!sweepTimer) return;
  clearInterval(sweepTimer);
  sweepTimer = null;
}
