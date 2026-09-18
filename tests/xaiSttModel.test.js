import {
  XAI_STT_MODEL_LATEST,
  XAI_STT_MODELS,
  getXaiSttModel,
  isAllowedXaiSttModel,
} from "../utils/xaiSttModel.js";

describe("xaiSttModel", () => {
  const originalEnv = process.env.XAI_STT_MODEL;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.XAI_STT_MODEL;
    } else {
      process.env.XAI_STT_MODEL = originalEnv;
    }
  });

  test("latest constant is Transcribe 2.0", () => {
    expect(XAI_STT_MODEL_LATEST).toBe("grok-voice-transcribe-2.0");
    expect(XAI_STT_MODELS).toContain("grok-voice-transcribe-2.0");
    expect(XAI_STT_MODELS).toContain("grok-voice-transcribe-1.0");
  });

  test("getXaiSttModel defaults to latest when env unset", () => {
    delete process.env.XAI_STT_MODEL;
    expect(getXaiSttModel()).toBe("grok-voice-transcribe-2.0");
  });

  test("getXaiSttModel accepts allowlisted env override", () => {
    process.env.XAI_STT_MODEL = "grok-voice-transcribe-1.0";
    expect(getXaiSttModel()).toBe("grok-voice-transcribe-1.0");
  });

  test("getXaiSttModel ignores unknown env and preferred values", () => {
    process.env.XAI_STT_MODEL = "not-a-real-model";
    expect(getXaiSttModel("also-fake")).toBe("grok-voice-transcribe-2.0");
  });

  test("preferred allowlisted model wins over env", () => {
    process.env.XAI_STT_MODEL = "grok-voice-transcribe-1.0";
    expect(getXaiSttModel("grok-voice-transcribe-2.0")).toBe(
      "grok-voice-transcribe-2.0",
    );
  });

  test("isAllowedXaiSttModel", () => {
    expect(isAllowedXaiSttModel("grok-voice-transcribe-2.0")).toBe(true);
    expect(isAllowedXaiSttModel("GROK-VOICE-TRANSCRIBE-1.0")).toBe(true);
    expect(isAllowedXaiSttModel("grok-voice-latest")).toBe(false);
  });
});
