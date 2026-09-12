import mongoose from "mongoose";
import { CREDIT_EXPIRY_DAYS, addDays } from "../utils/creditCalculator.js";

/**
 * One row per credit purchase / grant (Stripe invoice, admin top-up, refund).
 * Unique invoiceId makes webhook retries safe. Remaining credits expire
 * 30 days after purchasedAt.
 */
const creditGrantSchema = new mongoose.Schema(
  {
    invoiceId: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    amount: {
      type: Number,
      required: true,
      min: 0,
    },
    remaining: {
      type: Number,
      min: 0,
    },
    used: {
      type: Number,
      default: 0,
      min: 0,
    },
    expired: {
      type: Number,
      default: 0,
      min: 0,
    },
    purchasedAt: {
      type: Date,
      default: Date.now,
      index: true,
    },
    expiresAt: {
      type: Date,
      index: true,
    },
    billingReason: {
      type: String,
      default: "",
    },
    stripeEventId: {
      type: String,
      default: "",
    },
    source: {
      type: String,
      default: "stripe",
    },
    purchaseMethod: {
      type: String,
      default: "",
    },
    clawed: {
      type: Number,
      default: 0,
      min: 0,
    },
    stripePaymentIntentId: {
      type: String,
      default: "",
      index: true,
    },
    stripeCheckoutSessionId: {
      type: String,
      default: "",
      index: true,
    },
  },
  { timestamps: true },
);

creditGrantSchema.index({ userId: 1, purchasedAt: 1 });
creditGrantSchema.index({ userId: 1, expiresAt: 1, remaining: 1 });

creditGrantSchema.pre("save", function creditGrantDefaults(next) {
  if (!this.purchasedAt) this.purchasedAt = this.createdAt || new Date();
  if (!this.expiresAt) this.expiresAt = addDays(this.purchasedAt, CREDIT_EXPIRY_DAYS);
  if (this.remaining == null) this.remaining = Number(this.amount) || 0;
  if (this.used == null) this.used = 0;
  if (this.expired == null) this.expired = 0;
  next();
});

export const CreditGrant =
  mongoose.models.CreditGrant || mongoose.model("CreditGrant", creditGrantSchema);

export default CreditGrant;
