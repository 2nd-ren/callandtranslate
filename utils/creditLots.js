/**
 * FIFO credit lots with 30-day expiry.
 *
 * CreditGrant rows are the purchase ledger (EventAnnouncer-style tokenPurchases).
 * token_credit_balance is the cached sum of unexpired remaining credits.
 */

import mongoose from "mongoose";
import { User } from "../models/user.js";
import { CreditGrant } from "../models/creditGrant.js";
import {
  CREDIT_EXPIRY_DAYS,
  addDays,
} from "./creditCalculator.js";

function toObjectId(userId) {
  if (!userId) return null;
  if (userId instanceof mongoose.Types.ObjectId) return userId;
  if (mongoose.Types.ObjectId.isValid(userId)) {
    return new mongoose.Types.ObjectId(String(userId));
  }
  return null;
}

function toDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function lotPurchasedAt(lot) {
  return toDate(lot?.purchasedAt) || toDate(lot?.createdAt) || new Date();
}

export function lotExpiresAt(lot, now = new Date()) {
  return toDate(lot?.expiresAt) || addDays(lotPurchasedAt(lot) || now, CREDIT_EXPIRY_DAYS);
}

export function summarizeLots(lots, now = new Date()) {
  const rows = [];
  let purchased = 0;
  let used = 0;
  let remaining = 0;
  let expired = 0;
  let goingToExpire = 0;
  let nextExpiration = null;
  let lastPurchaseDate = null;

  for (const lot of lots || []) {
    const purchasedAt = lotPurchasedAt(lot);
    const expiresAt = lotExpiresAt(lot, now);
    const amount = Math.max(0, Number(lot.amount) || 0);
    let lotRemaining =
      lot.remaining == null ? amount : Math.max(0, Number(lot.remaining) || 0);
    let lotUsed = Math.max(0, Number(lot.used) || 0);
    let lotExpired = Math.max(0, Number(lot.expired) || 0);
    const isExpired = expiresAt.getTime() <= now.getTime();
    if (isExpired && lotRemaining > 0) {
      lotExpired += lotRemaining;
      lotRemaining = 0;
    }
    purchased += amount;
    used += lotUsed;
    expired += lotExpired;
    remaining += lotRemaining;
    if (!isExpired && lotRemaining > 0) {
      goingToExpire += lotRemaining;
      if (!nextExpiration || expiresAt < nextExpiration) nextExpiration = expiresAt;
    }
    if (purchasedAt && (!lastPurchaseDate || purchasedAt > lastPurchaseDate)) {
      lastPurchaseDate = purchasedAt;
    }
    rows.push({
      id: lot._id ? String(lot._id) : "",
      purchasedAt: purchasedAt ? purchasedAt.toISOString() : null,
      expiresAt: expiresAt.toISOString(),
      purchased: amount,
      used: lotUsed,
      remaining: lotRemaining,
      expired: lotExpired,
      goingToExpire: isExpired ? 0 : lotRemaining,
      source: lot.source || "",
      purchaseMethod: lot.purchaseMethod || lot.billingReason || "",
      billingReason: lot.billingReason || "",
    });
  }

  rows.sort((a, b) => {
    const aTime = a.purchasedAt ? Date.parse(a.purchasedAt) : 0;
    const bTime = b.purchasedAt ? Date.parse(b.purchasedAt) : 0;
    return bTime - aTime;
  });

  return {
    lots: rows,
    totals: {
      purchased,
      used,
      remaining,
      expired,
      goingToExpire,
    },
    nextExpiration: nextExpiration ? nextExpiration.toISOString() : null,
    lastPurchaseDate: lastPurchaseDate ? lastPurchaseDate.toISOString() : null,
  };
}

async function loadLots(userId) {
  const id = toObjectId(userId);
  if (!id) return [];
  return CreditGrant.find({ userId: id }).sort({ purchasedAt: 1, createdAt: 1 });
}

export async function persistExpiredLots(userId, now = new Date()) {
  const lots = await loadLots(userId);
  let changed = false;
  for (const lot of lots) {
    const purchasedAt = lotPurchasedAt(lot);
    const expiresAt = lotExpiresAt(lot, now);
    const updates = {};
    if (!lot.purchasedAt) updates.purchasedAt = purchasedAt;
    if (!lot.expiresAt) updates.expiresAt = expiresAt;
    if (lot.remaining == null) updates.remaining = Number(lot.amount) || 0;
    if (lot.used == null) updates.used = 0;
    if (lot.expired == null) updates.expired = 0;
    const remaining =
      updates.remaining != null ? updates.remaining : Number(lot.remaining) || 0;
    if (expiresAt.getTime() <= now.getTime() && remaining > 0) {
      updates.expired = (Number(lot.expired) || 0) + remaining;
      updates.remaining = 0;
    }
    if (Object.keys(updates).length) {
      Object.assign(lot, updates);
      await lot.save();
      changed = true;
    }
  }
  return { lots, changed };
}

async function seedUntrackedBalance(userId) {
  const id = toObjectId(userId);
  if (!id) return null;
  const existing = await CreditGrant.countDocuments({ userId: id });
  if (existing > 0) return null;
  const user = await User.findById(id).select("token_credit_balance");
  if (!user) return null;
  const balance = Math.max(0, Math.round(Number(user.token_credit_balance) || 0));
  if (balance <= 0) return null;
  return addCreditLot(id, balance, {
    invoiceId: `legacy-seed-${String(id)}`,
    source: "legacy-seed",
    purchaseMethod: "Existing balance",
    applyToBalance: false,
  });
}

export async function expireAndSyncBalance(userId, now = new Date()) {
  const id = toObjectId(userId);
  if (!id) return { success: false, error: "User ID is required", balance: 0 };
  const user = await User.findById(id).select("token_credit_balance");
  if (!user) return { success: false, error: "User not found", balance: 0 };

  await seedUntrackedBalance(id);
  await persistExpiredLots(id, now);
  const lotCount = await CreditGrant.countDocuments({ userId: id });
  if (lotCount === 0) {
    return {
      success: true,
      balance: Math.max(0, Number(user.token_credit_balance) || 0),
    };
  }
  const remainingRows = await CreditGrant.aggregate([
    {
      $match: {
        userId: id,
        remaining: { $gt: 0 },
        expiresAt: { $gt: now },
      },
    },
    { $group: { _id: null, total: { $sum: "$remaining" } } },
  ]);
  const balance = Math.max(0, Number(remainingRows[0]?.total) || 0);
  if ((Number(user.token_credit_balance) || 0) !== balance) {
    await User.updateOne({ _id: id }, { $set: { token_credit_balance: balance } });
  }
  return { success: true, balance };
}

export async function addCreditLot(
  userId,
  amount,
  {
    invoiceId,
    billingReason = "",
    stripeEventId = "",
    source = "manual",
    purchaseMethod = "",
    purchasedAt = new Date(),
    expiryDays = CREDIT_EXPIRY_DAYS,
    applyToBalance = true,
    stripePaymentIntentId = "",
    stripeCheckoutSessionId = "",
  } = {},
) {
  const id = toObjectId(userId);
  if (!id) return { granted: false, error: "User ID is required" };
  const grantAmount = Math.round(Number(amount) || 0);
  if (!Number.isFinite(grantAmount) || grantAmount <= 0) {
    return { granted: false, error: "Amount must be a positive number" };
  }

  const user = await User.findById(id).select("token_credit_balance");
  if (!user) return { granted: false, error: "User not found" };

  const when = toDate(purchasedAt) || new Date();
  const expiresAt = addDays(when, expiryDays);
  const uniqueId = invoiceId || `${source}-${new mongoose.Types.ObjectId()}`;

  try {
    await CreditGrant.create({
      invoiceId: uniqueId,
      userId: id,
      amount: grantAmount,
      remaining: grantAmount,
      used: 0,
      expired: 0,
      billingReason,
      stripeEventId,
      source,
      purchaseMethod,
      purchasedAt: when,
      expiresAt,
      clawed: 0,
      stripePaymentIntentId: String(stripePaymentIntentId || ""),
      stripeCheckoutSessionId: String(stripeCheckoutSessionId || ""),
    });
  } catch (err) {
    if (err?.code === 11000) {
      return { granted: false, duplicate: true, invoiceId: uniqueId };
    }
    throw err;
  }

  let newBalance = Number(user.token_credit_balance) || 0;
  const previousBalance = newBalance;
  if (applyToBalance) {
    const updated = await User.findByIdAndUpdate(
      id,
      { $inc: { token_credit_balance: grantAmount } },
      { new: true, select: "token_credit_balance" },
    );
    newBalance = updated?.token_credit_balance ?? previousBalance + grantAmount;
  }

  return {
    granted: true,
    amount: grantAmount,
    invoiceId: uniqueId,
    expiresAt,
    purchasedAt: when,
    previousBalance,
    newBalance,
  };
}

/**
 * Remove unspent credits from one lot (refund / dispute). Used minutes stay used.
 * Idempotent when `alreadyClawed` is applied by the caller via lot.clawed.
 */
export async function clawBackCredits(userId, { lot, amount, reason = "refund" } = {}) {
  const id = toObjectId(userId);
  if (!id) return { success: false, error: "User ID is required" };
  const grant = lot?._id
    ? await CreditGrant.findById(lot._id)
    : null;
  if (!grant) return { success: false, error: "Credit lot not found" };

  await expireAndSyncBalance(id);
  const fresh = await CreditGrant.findById(grant._id);
  const user = await User.findById(id).select("token_credit_balance");
  if (!fresh || !user) {
    return { success: false, error: "User or lot not found" };
  }

  const requested = Math.max(0, Math.round(Number(amount) || 0));
  const take = Math.min(
    requested,
    Math.max(0, Number(fresh.remaining) || 0),
    Math.max(0, Number(user.token_credit_balance) || 0),
  );

  if (take <= 0) {
    return {
      success: true,
      clawed: 0,
      alreadyUsed: Math.max(0, Number(fresh.used) || 0),
      remaining: Math.max(0, Number(fresh.remaining) || 0),
      alreadyClawed: Math.max(0, Number(fresh.clawed) || 0),
      previousBalance: Number(user.token_credit_balance) || 0,
      newBalance: Number(user.token_credit_balance) || 0,
      invoiceId: fresh.invoiceId,
      reason,
    };
  }

  const updatedLot = await CreditGrant.findOneAndUpdate(
    { _id: fresh._id, remaining: { $gte: take } },
    { $inc: { remaining: -take, clawed: take } },
    { new: true },
  );
  if (!updatedLot) {
    return { success: false, error: "Lot remaining changed, retry" };
  }

  const previousBalance = Number(user.token_credit_balance) || 0;
  const nextBalance = Math.max(0, previousBalance - take);
  await User.updateOne({ _id: id }, { $set: { token_credit_balance: nextBalance } });

  return {
    success: true,
    clawed: take,
    alreadyUsed: Math.max(0, Number(updatedLot.used) || 0),
    remaining: Math.max(0, Number(updatedLot.remaining) || 0),
    alreadyClawed: Math.max(0, Number(updatedLot.clawed) || 0),
    previousBalance,
    newBalance: nextBalance,
    invoiceId: updatedLot.invoiceId,
    reason,
  };
}

export async function deductFromLots(userId, amount, options = {}) {
  const id = toObjectId(userId);
  if (!id) {
    return { success: false, error: "User ID is required" };
  }
  const credits = Math.round(Number(amount) || 0);
  if (!Number.isFinite(credits) || credits <= 0) {
    return { success: false, error: "Amount must be a positive number" };
  }

  await expireAndSyncBalance(id);

  const updatedUser = await User.findOneAndUpdate(
    { _id: id, token_credit_balance: { $gte: credits } },
    { $inc: { token_credit_balance: -credits } },
    { new: true, select: "token_credit_balance" },
  );

  if (!updatedUser) {
    const user = await User.findById(id).select("token_credit_balance").lean();
    if (!user) return { success: false, error: "User not found" };
    return {
      success: false,
      error: "Insufficient credits",
      balance: user.token_credit_balance ?? 0,
      required: credits,
      shortfall: credits - (user.token_credit_balance ?? 0),
    };
  }

  let left = credits;
  const now = new Date();
  const lots = await CreditGrant.find({
    userId: id,
    remaining: { $gt: 0 },
    expiresAt: { $gt: now },
  }).sort({ purchasedAt: 1, createdAt: 1 });

  for (const lot of lots) {
    if (left <= 0) break;
    const take = Math.min(Number(lot.remaining) || 0, left);
    if (take <= 0) continue;
    const updated = await CreditGrant.findOneAndUpdate(
      { _id: lot._id, remaining: { $gte: take } },
      { $inc: { remaining: -take, used: take } },
      { new: true },
    );
    if (updated) left -= take;
  }

  return {
    success: true,
    previousBalance: updatedUser.token_credit_balance + credits,
    newBalance: updatedUser.token_credit_balance,
    amountDeducted: credits,
    callType: options.callType,
    reason: options.reason,
  };
}

export async function setBalanceViaLots(userId, targetBalance, options = {}) {
  const id = toObjectId(userId);
  if (!id) return { success: false, error: "User ID is required" };
  const next = Math.round(Number(targetBalance));
  if (!Number.isFinite(next) || next < 0) {
    return { success: false, error: "Balance must be a non-negative number" };
  }

  const synced = await expireAndSyncBalance(id);
  if (!synced.success) return synced;
  const previousBalance = synced.balance;
  const delta = next - previousBalance;

  if (delta > 0) {
    const added = await addCreditLot(id, delta, {
      source: options.source || "admin",
      purchaseMethod: options.reason || "Admin credit adjustment",
      billingReason: options.reason || "admin_manual_set",
    });
    if (!added.granted && !added.duplicate) {
      return { success: false, error: added.error || "Failed to add credits" };
    }
  } else if (delta < 0) {
    const deducted = await deductFromLots(id, -delta, {
      reason: options.reason || "Admin credit adjustment",
      callType: "admin-credit-change",
    });
    if (!deducted.success) {
      return deducted;
    }
  }

  const user = await User.findById(id).select("token_credit_balance");
  return {
    success: true,
    previousBalance,
    newBalance: user?.token_credit_balance ?? next,
    reason: options.reason,
  };
}

export async function getCreditLedger(userId, now = new Date()) {
  const id = toObjectId(userId);
  if (!id) return { success: false, error: "User ID is required" };
  const synced = await expireAndSyncBalance(id, now);
  if (!synced.success) return synced;
  const lots = await CreditGrant.find({ userId: id })
    .sort({ purchasedAt: -1, createdAt: -1 })
    .lean();
  const summary = summarizeLots(lots, now);
  return {
    success: true,
    balance: synced.balance,
    ...summary,
  };
}

export async function summarizeLotsByUserIds(userIds, now = new Date()) {
  const ids = (userIds || []).map(toObjectId).filter(Boolean);
  const map = new Map();
  if (!ids.length) return map;
  const lots = await CreditGrant.find({ userId: { $in: ids } }).lean();
  const grouped = new Map();
  for (const lot of lots) {
    const key = String(lot.userId);
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(lot);
  }
  for (const [key, userLots] of grouped) {
    map.set(key, summarizeLots(userLots, now));
  }
  return map;
}

export default {
  summarizeLots,
  persistExpiredLots,
  expireAndSyncBalance,
  addCreditLot,
  clawBackCredits,
  deductFromLots,
  setBalanceViaLots,
  getCreditLedger,
  summarizeLotsByUserIds,
};
