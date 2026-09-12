import express from "express";
import auth from "../middleware/auth.js";
import {
  getUserCreditInfo,
  checkCredits,
} from "../utils/userCredits.js";
import { getCreditLedger } from "../utils/creditLots.js";
import {
  creditsFromCallSeconds,
  publicCreditCalculator,
  formatCallTime,
} from "../utils/creditCalculator.js";
import { UsageRecord } from "../models/usageRecord.js";

const router = express.Router();

router.get("/me", auth, async (req, res) => {
  const result = await getUserCreditInfo(req.user._id);
  if (!result.success) return res.status(404).json({ error: result.error });
  res.json({
    ...result.credits,
    remainingLabel: formatCallTime(result.credits?.balance || 0),
    creditCalculator: publicCreditCalculator(),
  });
});

router.get("/me/details", auth, async (req, res) => {
  const ledger = await getCreditLedger(req.user._id);
  if (!ledger.success) {
    return res.status(404).json({ error: ledger.error || "User not found" });
  }
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 25));
  const records = await UsageRecord.find({ userId: req.user._id })
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean();
  res.json({
    balance: ledger.balance,
    remainingLabel: formatCallTime(ledger.balance),
    totals: ledger.totals,
    lots: ledger.lots,
    nextExpiration: ledger.nextExpiration,
    lastPurchaseDate: ledger.lastPurchaseDate,
    creditCalculator: publicCreditCalculator(),
    usage: records.map((row) => ({
      id: String(row._id),
      createdAt: row.createdAt,
      callType: row.callType,
      model: row.model || "",
      creditsDeducted: row.creditsDeducted || 0,
      durationSec: row.durationSec,
      success: row.success !== false,
      metadata: row.metadata || {},
    })),
  });
});

router.get("/me/check", auth, async (req, res) => {
  const amount = Number(req.query.amount || 0);
  const result = await checkCredits(req.user._id, amount);
  res.json(result);
});

router.post("/estimate", async (req, res) => {
  const durationSec = Number(req.body?.durationSec);
  const minutes = Number(req.body?.minutes);
  const seconds = Number.isFinite(durationSec)
    ? durationSec
    : Number.isFinite(minutes)
      ? minutes * 60
      : 0;
  const credits = creditsFromCallSeconds(seconds);
  res.json({
    creditCalculator: publicCreditCalculator(),
    durationSec: Math.max(0, seconds),
    totalCredits: credits,
    remainingLabel: formatCallTime(credits),
  });
});

export default router;
