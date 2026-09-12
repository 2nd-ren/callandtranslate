import mongoose from "mongoose";

const adminActivitySchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      index: true,
    },
    userEmail: { type: String, default: "" },
    userName: { type: String, default: "" },
    eventType: { type: String, required: true, index: true },
    source: { type: String, default: "admin", index: true },
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
    actorId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    actorEmail: { type: String, default: "" },
  },
  { timestamps: true },
);

adminActivitySchema.index({ createdAt: -1 });

export const AdminActivity =
  mongoose.models.AdminActivity ||
  mongoose.model("AdminActivity", adminActivitySchema);

export async function recordAdminActivity(fields) {
  try {
    return await AdminActivity.create(fields);
  } catch (error) {
    console.error("Failed to record admin activity", error);
    return null;
  }
}

export default AdminActivity;
