/**
 * Voice-agent voice list / sample helpers (pure, no DOM).
 * Used by chat mic-menu voice picker and unit tests.
 */

/** Default realtime / TTS voice id (xAI lowercase). */
export const VOICE_AGENT_DEFAULT_VOICE_ID = "eve";

/** Fallback roster when /voice/voices is unavailable. */
export const VOICE_AGENT_FALLBACK_VOICES = Object.freeze([
  {
    voice_id: "ara",
    name: "Ara",
    language: "multilingual",
    description: "Warm, friendly",
  },
  {
    voice_id: "eve",
    name: "Eve",
    language: "multilingual",
    description: "Energetic, upbeat",
  },
  {
    voice_id: "leo",
    name: "Leo",
    language: "multilingual",
    description: "Authoritative, strong",
  },
  {
    voice_id: "rex",
    name: "Rex",
    language: "multilingual",
    description: "Confident, clear",
  },
  {
    voice_id: "sal",
    name: "Sal",
    language: "multilingual",
    description: "Smooth, balanced",
  },
]);

/**
 * Local sample files shipped under /call-agent/voice-samples/{id}.mp3
 * (subset of xAI voice ids for which we have preview audio).
 */
export const VOICE_AGENT_LOCAL_SAMPLE_IDS = Object.freeze(
  new Set([
    "0895a5b8ce5c",
    "0hhfxxqq",
    "0ih5oi34",
    "0p0rt7o1",
    "182a91893636",
    "1b12d5daee6b",
    "1f046a033914",
    "23468361b4ef",
    "23be42535a45",
    "244e27b39200",
    "247783ebdd51",
    "26w6ihxi",
    "2badb5f46b1e",
    "33g9t0jl",
    "34fd4dce1ba3",
    "35c8d7f60dc8",
    "37329fd8895a",
    "3a7889066fa2",
    "3d030bc92a87",
    "40f31906b23d",
    "41321eb41295",
    "458705c07139",
    "490ea3be50b1",
    "4ff93971bfdc",
    "58d27475085e",
    "670a0c3ac005",
    "69smp8rm",
    "6da5baee46d0",
    "70013edeb8e8",
    "73xd5dum",
    "78a495fdbb39",
    "79f3a8b96d43",
    "7a9ee820b342",
    "83c6f4fea98e",
    "89q2pnko",
    "908c4626660f",
    "96819d0bd28d",
    "97fabd54445f",
    "97zmdc6s",
    "a0401c9101f8",
    "a13662ba951c",
    "abfbdf26f115",
    "ara",
    "b1a7441b97a1",
    "b5ae17439907",
    "bcs7l2c3",
    "bf9fe5b5f981",
    "c3a2c594479e",
    "d0cb9ff07d95",
    "d18jlf6v",
    "d634b6da3d3b",
    "dfe7b9e7d217",
    "dr8gqysu",
    "e22152e06fd8",
    "ekhwx401",
    "eve",
    "f8cf5c2c78d4",
    "fc7de6afcf6c",
    "gwnexu6y",
    "h27ltdnz",
    "hbxkrnwm",
    "hqxr4yub",
    "jpi39icg",
    "jupvcf34",
    "leo",
    "om17cury",
    "rex",
    "sal",
    "wy0m9l5w",
    "x7avnu1k",
    "yis75yfp",
  ]),
);

export const VOICE_AGENT_LOCAL_SAMPLE_BASE_PATH = "/call-agent/voice-samples";

export function normalizeVoiceAgentVoiceId(voiceId) {
  return String(voiceId || "")
    .trim()
    .toLowerCase();
}

/**
 * Extract a remote sample URL from an xAI voice payload if present.
 * @param {object} voice
 * @returns {string|null}
 */
export function getRemoteVoiceSampleUrl(voice = {}) {
  const candidates = [
    voice.sample_url,
    voice.sampleUrl,
    voice.preview_url,
    voice.previewUrl,
    voice.sample,
    voice.preview,
    voice.audio_url,
    voice.audioUrl,
  ];
  for (const value of candidates) {
    if (typeof value === "string" && /^https?:\/\//i.test(value.trim())) {
      return value.trim();
    }
    if (value && typeof value === "object") {
      const nested = value.url || value.href || value.src;
      if (typeof nested === "string" && /^https?:\/\//i.test(nested.trim())) {
        return nested.trim();
      }
    }
  }
  return null;
}

/**
 * Resolve a playable sample URL for a voice, or null if none available.
 * Prefers xAI remote sample fields; falls back to local shipped samples.
 *
 * @param {object|string} voiceOrId - voice object or voice_id string
 * @param {{ localSampleIds?: Set<string>, localBasePath?: string }} [options]
 * @returns {string|null}
 */
export function resolveVoiceSampleUrl(voiceOrId, options = {}) {
  const localIds = options.localSampleIds || VOICE_AGENT_LOCAL_SAMPLE_IDS;
  const basePath =
    options.localBasePath || VOICE_AGENT_LOCAL_SAMPLE_BASE_PATH;

  if (typeof voiceOrId === "string") {
    const id = normalizeVoiceAgentVoiceId(voiceOrId);
    if (id && localIds.has(id)) {
      return `${basePath}/${id}.mp3`;
    }
    return null;
  }

  const voice = voiceOrId && typeof voiceOrId === "object" ? voiceOrId : {};
  const remote = getRemoteVoiceSampleUrl(voice);
  if (remote) return remote;

  const id = normalizeVoiceAgentVoiceId(voice.voice_id || voice.id || "");
  if (id && localIds.has(id)) {
    return `${basePath}/${id}.mp3`;
  }
  return null;
}

export function hasVoiceSample(voiceOrId, options = {}) {
  return Boolean(resolveVoiceSampleUrl(voiceOrId, options));
}

/**
 * Normalize API / fallback voices for the picker list.
 * @param {unknown} payload - raw /voice/voices response or array
 * @returns {Array<object>}
 */
export function normalizeVoiceAgentVoices(payload) {
  const list = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.voices)
      ? payload.voices
      : [];

  const mapped = list
    .map((raw) => {
      if (!raw || typeof raw !== "object") return null;
      const voice_id = normalizeVoiceAgentVoiceId(raw.voice_id || raw.id);
      if (!voice_id) return null;
      return {
        voice_id,
        name: String(raw.name || voice_id),
        language: raw.language || raw.locale || raw.lang || "",
        description: raw.description || raw.tone || raw.accent || "",
        sample_url: getRemoteVoiceSampleUrl(raw) || undefined,
        raw,
      };
    })
    .filter(Boolean);

  if (!mapped.length) {
    return VOICE_AGENT_FALLBACK_VOICES.map((v) => ({ ...v }));
  }

  return mapped.sort((a, b) =>
    String(a.name || a.voice_id).localeCompare(String(b.name || b.voice_id)),
  );
}

/**
 * Pick a valid selected voice id from a list.
 * @param {string} preferred
 * @param {Array<object>} voices
 */
export function resolveSelectedVoiceAgentVoiceId(
  preferred,
  voices = VOICE_AGENT_FALLBACK_VOICES,
) {
  const list = Array.isArray(voices) && voices.length
    ? voices
    : VOICE_AGENT_FALLBACK_VOICES;
  const preferredId = normalizeVoiceAgentVoiceId(preferred);
  if (
    preferredId &&
    list.some(
      (v) => normalizeVoiceAgentVoiceId(v.voice_id || v.id) === preferredId,
    )
  ) {
    return preferredId;
  }
  const first = list[0];
  return (
    normalizeVoiceAgentVoiceId(first?.voice_id || first?.id) ||
    VOICE_AGENT_DEFAULT_VOICE_ID
  );
}

/**
 * Session.update voice value for xAI (prefer API id casing when known).
 * @param {string} voiceId
 * @param {Array<object>} [voices]
 */
export function toSessionVoiceValue(voiceId, voices = []) {
  const id = normalizeVoiceAgentVoiceId(voiceId);
  const match = (voices || []).find(
    (v) => normalizeVoiceAgentVoiceId(v.voice_id || v.id) === id,
  );
  // Realtime accepts lowercase ids from TTS roster (eve, ara, …)
  return match?.voice_id || match?.id || id || VOICE_AGENT_DEFAULT_VOICE_ID;
}
