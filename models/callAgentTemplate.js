import mongoose from "mongoose";

const CallAgentFieldsSchema = new mongoose.Schema(
  {
    goal: { type: String, default: "", maxlength: 50000 },
    rules: { type: String, default: "", maxlength: 50000 },
    information: { type: String, default: "", maxlength: 100000 },
    prompt: { type: String, default: "", maxlength: 150000 },
    yourName: { type: String, default: "", trim: true, maxlength: 80 },
    yourLanguage: { type: String, default: "en", trim: true, maxlength: 16 },
    theirLanguage: { type: String, default: "es", trim: true, maxlength: 16 },
    discloseAi: { type: Boolean, default: true },
  },
  { _id: false },
);

const CallAgentTemplateSchema = new mongoose.Schema(
  {
    ownerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: 180,
    },
    nameKey: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      maxlength: 180,
    },
    description: {
      type: String,
      default: "",
      trim: true,
      maxlength: 2000,
    },
    fields: {
      type: CallAgentFieldsSchema,
      default: () => ({}),
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
  },
  { timestamps: true },
);

CallAgentTemplateSchema.index({ ownerId: 1, nameKey: 1 }, { unique: true });
CallAgentTemplateSchema.index({ ownerId: 1, updatedAt: -1 });

const CallAgentTemplate = mongoose.model(
  "CallAgentTemplate",
  CallAgentTemplateSchema,
);

export { CallAgentFieldsSchema, CallAgentTemplate };
export default CallAgentTemplate;
