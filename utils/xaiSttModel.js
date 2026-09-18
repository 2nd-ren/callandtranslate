/**
 * Shared xAI speech-to-text model defaults for REST and streaming STT.
 *
 * Research (xAI Speech-to-Text docs):
 * - `grok-voice-transcribe-2.0` = best / current Transcribe 2.0
 * - `grok-voice-transcribe-1.0` = default when `model` is omitted
 * - Unlike voice (`grok-voice-latest`), xAI has NO documented STT `-latest`
 *   alias. Bump `XAI_STT_MODEL_LATEST` when a newer version ships so the app
 *   always tracks the best model from this one place.
 *
 * Override with env `XAI_STT_MODEL` when the value is allowlisted.
 */

/** Current best documented STT model (bump when a newer Transcribe ships). */
export const XAI_STT_MODEL_LATEST = "grok-voice-transcribe-2.0";

/**
 * Models allowed for xAI STT requests.
 * Keep prior majors so env overrides and older prefs still validate.
 */
export const XAI_STT_MODELS = Object.freeze([
  "grok-voice-transcribe-2.0",
  "grok-voice-transcribe-1.0",
]);

const XAI_STT_MODEL_SET = new Set(
  XAI_STT_MODELS.map((m) => m.toLowerCase()),
);

/**
 * Resolve the configured default xAI STT model.
 * Prefer env override when it is allowlisted; otherwise latest constant.
 *
 * @param {string} [preferred] Optional preferred model (also allowlist-checked)
 * @returns {string}
 */
export function getXaiSttModel(preferred) {
  const fromPreferred = String(preferred || "")
    .trim()
    .toLowerCase();
  if (fromPreferred && XAI_STT_MODEL_SET.has(fromPreferred)) {
    return fromPreferred;
  }

  const fromEnv = String(process.env.XAI_STT_MODEL || "")
    .trim()
    .toLowerCase();
  if (fromEnv && XAI_STT_MODEL_SET.has(fromEnv)) {
    return fromEnv;
  }

  return XAI_STT_MODEL_LATEST;
}

/**
 * True if the id is in the STT allowlist (case-insensitive).
 */
export function isAllowedXaiSttModel(model) {
  const normalized = String(model || "")
    .trim()
    .toLowerCase();
  return Boolean(normalized) && XAI_STT_MODEL_SET.has(normalized);
}
