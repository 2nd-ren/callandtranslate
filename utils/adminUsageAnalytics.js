import mongoose from "mongoose";
import { UsageRecord } from "../models/usageRecord.js";
import { User } from "../models/user.js";
import { CREDIT_BALANCE_CALL_TYPES } from "./usageLogger.js";

export function startOfDayUTC(date) {
  const next = new Date(date);
  next.setUTCHours(0, 0, 0, 0);
  return next;
}

export function getPeriodBounds(range, anchorDate) {
  const anchor = startOfDayUTC(anchorDate);

  if (range === "day") {
    const end = new Date(anchor);
    end.setUTCDate(end.getUTCDate() + 1);
    return {
      start: anchor,
      end,
      label: anchor.toISOString().slice(0, 10),
    };
  }

  if (range === "week") {
    const day = anchor.getUTCDay();
    const diff = day === 0 ? -6 : 1 - day;
    const start = new Date(anchor);
    start.setUTCDate(start.getUTCDate() + diff);
    const end = new Date(start);
    end.setUTCDate(end.getUTCDate() + 7);
    return {
      start,
      end,
      label: `Week of ${start.toISOString().slice(0, 10)}`,
    };
  }

  const start = new Date(
    Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth(), 1),
  );
  const end = new Date(
    Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth() + 1, 1),
  );
  const label = start.toLocaleString("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
  return { start, end, label };
}

function providerFromModel(model, callType) {
  const value = String(model || "").toLowerCase();
  if (value.includes("grok") || value.startsWith("xai")) return "xai";
  if (String(callType || "") === "transcription") return "xai";
  if (!value) return String(callType || "unknown");
  return "xai";
}

function formatModelKey(provider, model) {
  return `${provider}::${model}`;
}

async function privilegedUserIds() {
  const rows = await User.find({
    $or: [{ isAdmin: true }, { isDev: true }, { role: "admin" }],
  })
    .select("_id")
    .lean();
  return rows.map((row) => row._id);
}

export async function getUsageAnalytics({
  range = "month",
  anchorDate = new Date(),
} = {}) {
  const { start, end, label } = getPeriodBounds(range, anchorDate);
  const excludedIds = await privilegedUserIds();
  const excludeMatch = {
    callType: { $nin: CREDIT_BALANCE_CALL_TYPES },
    ...(excludedIds.length > 0 ? { userId: { $nin: excludedIds } } : {}),
  };

  const [periodRows, allTimeRows, seriesRows] = await Promise.all([
    UsageRecord.aggregate([
      {
        $match: {
          createdAt: { $gte: start, $lt: end },
          ...excludeMatch,
        },
      },
      {
        $group: {
          _id: { model: "$model", callType: "$callType" },
          credits: { $sum: "$creditsDeducted" },
          tokens: { $sum: "$totalTokens" },
          calls: { $sum: 1 },
        },
      },
    ]),
    UsageRecord.aggregate([
      { $match: excludeMatch },
      {
        $group: {
          _id: { model: "$model", callType: "$callType" },
          credits: { $sum: "$creditsDeducted" },
          tokens: { $sum: "$totalTokens" },
          calls: { $sum: 1 },
        },
      },
    ]),
    UsageRecord.aggregate([
      {
        $match: {
          createdAt: { $gte: start, $lt: end },
          ...excludeMatch,
        },
      },
      {
        $group: {
          _id: {
            day: {
              $dateToString: { format: "%Y-%m-%d", date: "$createdAt" },
            },
            model: "$model",
            callType: "$callType",
          },
          credits: { $sum: "$creditsDeducted" },
        },
      },
      { $sort: { "_id.day": 1 } },
    ]),
  ]);

  const normalize = (row) => {
    const model = row._id?.model || row._id?.callType || "unknown";
    const callType = row._id?.callType || "";
    const provider = providerFromModel(model, callType);
    return {
      provider,
      model: model || callType || "unknown",
      callType,
      credits: Number(row.credits) || 0,
      tokens: Number(row.tokens) || 0,
      calls: Number(row.calls) || 0,
    };
  };

  const periodByModel = periodRows.map(normalize).sort((a, b) => b.credits - a.credits);
  const allTimeByModel = allTimeRows
    .map(normalize)
    .sort((a, b) => b.credits - a.credits);

  const modelMap = new Map();
  const addModel = (entry) => {
    const key = formatModelKey(entry.provider, entry.model);
    if (!modelMap.has(key)) {
      modelMap.set(key, {
        key,
        provider: entry.provider,
        model: entry.model,
      });
    }
  };
  allTimeByModel.forEach(addModel);
  periodByModel.forEach(addModel);
  const models = Array.from(modelMap.values());

  const seriesMap = new Map();
  if (range === "day") {
    const bucketKey = start.toISOString().slice(0, 10);
    seriesMap.set(bucketKey, { label: bucketKey, totals: {} });
  } else if (range === "week") {
    for (let i = 0; i < 7; i += 1) {
      const day = new Date(start);
      day.setUTCDate(day.getUTCDate() + i);
      const bucketKey = day.toISOString().slice(0, 10);
      seriesMap.set(bucketKey, { label: bucketKey, totals: {} });
    }
  } else {
    const cursor = new Date(start);
    while (cursor < end) {
      const bucketKey = cursor.toISOString().slice(0, 10);
      seriesMap.set(bucketKey, { label: bucketKey, totals: {} });
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
  }

  for (const row of seriesRows) {
    const bucketKey = row._id?.day;
    if (!bucketKey) continue;
    const model = row._id?.model || row._id?.callType || "unknown";
    const provider = providerFromModel(model, row._id?.callType);
    const modelKey = formatModelKey(provider, model);
    if (!seriesMap.has(bucketKey)) {
      seriesMap.set(bucketKey, { label: bucketKey, totals: {} });
    }
    const bucket = seriesMap.get(bucketKey);
    bucket.totals[modelKey] =
      (bucket.totals[modelKey] || 0) + (Number(row.credits) || 0);
  }

  const periodTotalCredits = periodByModel.reduce(
    (sum, row) => sum + row.credits,
    0,
  );
  const allTimeTotalCredits = allTimeByModel.reduce(
    (sum, row) => sum + row.credits,
    0,
  );
  const periodTotalCalls = periodByModel.reduce((sum, row) => sum + row.calls, 0);

  return {
    range,
    anchor: startOfDayUTC(anchorDate).toISOString(),
    periodStart: start.toISOString(),
    periodEnd: end.toISOString(),
    periodLabel: label,
    periodTotalCredits,
    allTimeTotalCredits,
    periodTotalCalls,
    periodByModel,
    allTimeByModel,
    models,
    series: Array.from(seriesMap.values()),
  };
}

export async function getUsageByUserIds(userIds) {
  if (!Array.isArray(userIds) || userIds.length === 0) return new Map();
  const objectIds = userIds
    .filter((id) => mongoose.Types.ObjectId.isValid(id))
    .map((id) => new mongoose.Types.ObjectId(String(id)));
  if (objectIds.length === 0) return new Map();
  const rows = await UsageRecord.aggregate([
    {
      $match: {
        userId: { $in: objectIds },
        callType: { $nin: CREDIT_BALANCE_CALL_TYPES },
      },
    },
    {
      $group: {
        _id: "$userId",
        credits: { $sum: "$creditsDeducted" },
        tokens: { $sum: "$totalTokens" },
        calls: { $sum: 1 },
      },
    },
  ]);
  const map = new Map();
  for (const row of rows) {
    map.set(String(row._id), {
      creditsUsed: Number(row.credits) || 0,
      tokens: Number(row.tokens) || 0,
      calls: Number(row.calls) || 0,
    });
  }
  return map;
}
