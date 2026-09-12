import mongoose from "mongoose";

const processedStripeEventSchema = new mongoose.Schema(
  {
    eventId: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    type: {
      type: String,
      required: true,
    },
  },
  { timestamps: true },
);

export const ProcessedStripeEvent =
  mongoose.models.ProcessedStripeEvent ||
  mongoose.model("ProcessedStripeEvent", processedStripeEventSchema);

export default ProcessedStripeEvent;
