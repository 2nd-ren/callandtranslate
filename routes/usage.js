import express from "express";
import auth from "../middleware/auth.js";
import { UsageRecord } from "../models/usageRecord.js";

const router = express.Router();

router.get("/me", auth, async (req, res) => {
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 25));
  const records = await UsageRecord.find({ userId: req.user._id })
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean();
  res.json({ records });
});

export default router;
