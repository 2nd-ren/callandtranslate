/**
 * Pure voice-agent subtitle buffer helpers.
 * Shared by the main UI and unit tests (no DOM / no WebSocket).
 *
 * Buffers assistant transcript deltas for a compact subtitle strip above chat.
 */

/** Soft cap so a long session does not grow unbounded in memory. */
export const VOICE_SUBTITLE_MAX_CHARS = 4000;

/**
 * Default: subtitles on when voice starts (user can toggle off).
 */
export function createVoiceSubtitleState(overrides = {}) {
  return {
    enabled: true,
    text: "",
    ...overrides,
  };
}

/**
 * Append a transcript delta to the subtitle buffer.
 * Always accumulates so re-enabling mid-response can show current text.
 *
 * @param {string} currentText
 * @param {string|null|undefined} delta
 * @param {{ maxChars?: number }} [options]
 * @returns {string} next buffer text
 */
export function appendVoiceSubtitleText(currentText, delta, options = {}) {
  const maxChars =
    Number.isFinite(options.maxChars) && options.maxChars > 0
      ? options.maxChars
      : VOICE_SUBTITLE_MAX_CHARS;
  const piece = delta == null ? "" : String(delta);
  if (!piece) return String(currentText || "");
  const next = String(currentText || "") + piece;
  if (next.length <= maxChars) return next;
  return next.slice(-maxChars);
}

/**
 * Whether the subtitle strip should be in the DOM / visible.
 * @param {{ voiceActive?: boolean, subtitlesEnabled?: boolean }} flags
 */
export function shouldShowVoiceSubtitleStrip({
  voiceActive = false,
  subtitlesEnabled = false,
} = {}) {
  return Boolean(voiceActive && subtitlesEnabled);
}

/**
 * Toggle / set enabled flag. Returns next boolean.
 * @param {boolean} currentlyEnabled
 * @param {boolean|null|undefined} [force] - if boolean, set explicitly; else flip
 */
export function nextVoiceSubtitlesEnabled(currentlyEnabled, force) {
  if (typeof force === "boolean") return force;
  return !Boolean(currentlyEnabled);
}

/**
 * Detect overflow that warrants slow auto-scroll.
 * @param {{ scrollHeight: number, clientHeight: number, epsilon?: number }} dims
 */
export function isVoiceSubtitleOverflow({
  scrollHeight = 0,
  clientHeight = 0,
  epsilon = 1,
} = {}) {
  return Number(scrollHeight) - Number(clientHeight) > Number(epsilon);
}

/**
 * One step of calm auto-scroll toward the bottom (newest text).
 * @param {{ scrollTop: number, scrollHeight: number, clientHeight: number, fraction?: number, minStep?: number }} args
 * @returns {number} next scrollTop
 */
export function computeSlowScrollTop({
  scrollTop = 0,
  scrollHeight = 0,
  clientHeight = 0,
  fraction = 0.14,
  minStep = 0.75,
} = {}) {
  const maxScroll = Math.max(0, Number(scrollHeight) - Number(clientHeight));
  const current = Math.max(0, Number(scrollTop) || 0);
  if (maxScroll <= 0) return 0;
  if (current >= maxScroll - 0.5) return maxScroll;
  const gap = maxScroll - current;
  const step = Math.max(Number(minStep) || 0.75, gap * (Number(fraction) || 0.14));
  return Math.min(maxScroll, current + step);
}

/**
 * Whether an inbound voice WS event should clear the subtitle buffer
 * so a new assistant turn starts fresh (previous text stays until then).
 * @param {string} eventType
 */
export function shouldClearVoiceSubtitlesOnEvent(eventType) {
  const type = String(eventType || "").trim();
  return (
    type === "response.created" ||
    type === "input_audio_buffer.speech_started"
  );
}

/**
 * Events that carry assistant spoken text deltas for subtitles.
 * @param {string} eventType
 */
export function isVoiceSubtitleTranscriptDeltaEvent(eventType) {
  return (
    String(eventType || "").trim() === "response.output_audio_transcript.delta"
  );
}

/**
 * Approx line capacity helper for tests / layout checks.
 * @param {{ fontSizePx?: number, lineHeight?: number, lineCount?: number }} opts
 * @returns {{ maxHeightPx: number, lineCount: number }}
 */
export function computeVoiceSubtitleBandMetrics({
  fontSizePx = 11,
  lineHeight = 1.25,
  lineCount = 5,
} = {}) {
  const lines = Math.max(1, Math.floor(Number(lineCount) || 3));
  const size = Number(fontSizePx) || 11;
  const lh = Number(lineHeight) || 1.25;
  return {
    lineCount: lines,
    maxHeightPx: size * lh * lines,
  };
}
