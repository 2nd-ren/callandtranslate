/**
 * Shared Grok text-model defaults and normalization for xAI chat/completions.
 *
 * Research (xAI Models docs, 2026):
 * - Bare `grok-latest` is NOT a documented model id.
 * - Family aliases: `<name>` → latest stable of that family;
 *   `<name>-latest` → latest (including pre-stable) of that family.
 * - Flagship text model is `grok-4.6` with aliases `grok-4.6-latest` and
 *   `grok-build-latest`. List-models samples may also expose a special `latest` id.
 *
 * Product default: use the documented flagship family alias so requests track the
 * newest stable Grok 4.6 without inventing unsupported names. Override with
 * `XAI_GROK_TEXT_MODEL` when needed.
 */

/** Documented flagship text model (stable family alias). */
export const GROK_FLAGSHIP_TEXT_MODEL = "grok-4.6";

/**
 * Models / aliases allowed for Grok text LLM requests.
 * Includes current flagship, prior flagships, and documented aliases so
 * project settings and older stored prefs still validate.
 */
export const GROK_TEXT_MODELS = Object.freeze([
  "grok-4.6",
  "grok-4.6-latest",
  "grok-4.5",
  "grok-4.5-latest",
  "grok-build-latest",
  "grok-4.3",
  "grok-4.3-latest",
  "grok-4.20",
  "grok-4.20-latest",
  "grok-4.20-multi-agent-0309",
  "grok-4.20-multi-agent-latest",
  "grok-4.20-0309-reasoning",
  "grok-4.20-0309-non-reasoning",
  "latest",
]);

const GROK_TEXT_MODEL_SET = new Set(
  GROK_TEXT_MODELS.map((m) => m.toLowerCase()),
);

/** Rejected product names that must never be sent to xAI as model ids. */
const UNSUPPORTED_GROK_ALIASES = new Set([
  "grok-latest",
  "grok_latest",
  "groklatest",
]);

/**
 * Resolve the configured default Grok text model.
 * Prefer env override when it is an allowed alias; otherwise flagship.
 */
export function getDefaultGrokTextModel() {
  const fromEnv = String(process.env.XAI_GROK_TEXT_MODEL || "")
    .trim()
    .toLowerCase();
  if (fromEnv && GROK_TEXT_MODEL_SET.has(fromEnv)) {
    return fromEnv;
  }
  return GROK_FLAGSHIP_TEXT_MODEL;
}

/**
 * True if the id is in the allowlist (case-insensitive).
 */
export function isAllowedGrokTextModel(model) {
  const normalized = String(model || "")
    .trim()
    .toLowerCase();
  return Boolean(normalized) && GROK_TEXT_MODEL_SET.has(normalized);
}

/**
 * Normalize a preferred model to a safe, allowed Grok text model id.
 * - Allowed aliases pass through (lowercased).
 * - Unsupported invents like `grok-latest` map to the shared default.
 * - Unknown/empty values map to the shared default.
 *
 * @param {string} [preferred]
 * @returns {string}
 */
export function normalizeGrokTextModel(preferred) {
  const raw = String(preferred || "").trim();
  if (!raw) return getDefaultGrokTextModel();

  const normalized = raw.toLowerCase();
  if (UNSUPPORTED_GROK_ALIASES.has(normalized)) {
    return getDefaultGrokTextModel();
  }
  if (GROK_TEXT_MODEL_SET.has(normalized)) {
    return normalized;
  }
  return getDefaultGrokTextModel();
}

/**
 * Human-readable note for logs / docs about why not bare grok-latest.
 */
export function getGrokLatestAliasNote() {
  return (
    "xAI does not document a bare 'grok-latest' model id. " +
    "Use family aliases such as 'grok-4.6' / 'grok-4.6-latest', " +
    `or the special 'latest' id. App default: ${getDefaultGrokTextModel()}.`
  );
}

/**
 * grok-4.6 / grok-4.5 `reasoning_effort` (xAI Reasoning docs).
 * Allowed: low, medium, high (documented default), xhigh.
 * Reasoning cannot be disabled — `none` / `minimal` are not valid and 400.
 */
export const GROK_REASONING_EFFORTS = Object.freeze([
  "low",
  "medium",
  "high",
  "xhigh",
]);

/** Lowest effort grok-4.6 accepts. Use for tiny one-line jobs. */
export const LOWEST_GROK_REASONING_EFFORT = "low";

/** xAI documented default when the parameter is omitted. */
export const DEFAULT_GROK_REASONING_EFFORT = "high";

const GROK_REASONING_EFFORT_ALIASES = Object.freeze({
  none: LOWEST_GROK_REASONING_EFFORT,
  off: LOWEST_GROK_REASONING_EFFORT,
  disable: LOWEST_GROK_REASONING_EFFORT,
  disabled: LOWEST_GROK_REASONING_EFFORT,
  minimal: LOWEST_GROK_REASONING_EFFORT,
  min: LOWEST_GROK_REASONING_EFFORT,
});

/**
 * Normalize a preferred reasoning_effort for grok-4.6.
 * - empty / invalid → high (xAI default for regular work)
 * - none / minimal → low (lowest allowed; tiny tasks)
 * - `{ tiny: true }` empty fallback is low
 *
 * @param {string} [preferred]
 * @param {{ tiny?: boolean }} [options]
 * @returns {"low"|"medium"|"high"|"xhigh"}
 */
export function normalizeGrokReasoningEffort(preferred, options = {}) {
  const fallback = options.tiny
    ? LOWEST_GROK_REASONING_EFFORT
    : DEFAULT_GROK_REASONING_EFFORT;
  const raw = String(preferred || "")
    .trim()
    .toLowerCase();
  if (!raw) return fallback;
  if (GROK_REASONING_EFFORT_ALIASES[raw]) {
    return GROK_REASONING_EFFORT_ALIASES[raw];
  }
  if (GROK_REASONING_EFFORTS.includes(raw)) return raw;
  return fallback;
}
