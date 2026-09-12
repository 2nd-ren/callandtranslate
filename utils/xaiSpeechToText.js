import fetch from "node-fetch";
import FormData from "form-data";

export const XAI_STT_ENDPOINT = "https://api.x.ai/v1/stt";
export const XAI_STT_MODEL_NAME = "xai-stt-rest";

function appendIfDefined(formData, name, value) {
  if (value === undefined || value === null || value === "") {
    return;
  }

  formData.append(name, String(value));
}

function appendBooleanIfDefined(formData, name, value) {
  if (value === undefined || value === null) {
    return;
  }

  formData.append(name, normalizeBoolean(value) ? "true" : "false");
}

function normalizeBoolean(value) {
  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "1", "yes"].includes(normalized)) return true;
    if (["false", "0", "no"].includes(normalized)) return false;
  }

  return Boolean(value);
}

function normalizeKeyterms(keyterms) {
  const values = Array.isArray(keyterms) ? keyterms : [keyterms];
  return values
    .map((value) => (typeof value === "string" ? value.trim() : ""))
    .filter(Boolean)
    .slice(0, 100);
}

async function readResponseBody(response) {
  const contentType = response.headers.get("content-type") || "";
  const text = await response.text();

  if (contentType.includes("application/json")) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  return text;
}

export async function transcribeAudioBufferWithXai({
  audioBuffer,
  fileName = "audio.webm",
  contentType = "audio/webm",
  apiKey = process.env.XAI_API_KEY,
  endpoint = XAI_STT_ENDPOINT,
  language = "en",
  format = true,
  keyterms = [],
  fillerWords,
  diarize,
  multichannel,
  channels,
  audioFormat,
  sampleRate,
} = {}) {
  if (!apiKey) {
    const error = new Error("XAI_API_KEY is not configured");
    error.status = 503;
    error.code = "XAI_NOT_CONFIGURED";
    throw error;
  }

  if (!Buffer.isBuffer(audioBuffer) || audioBuffer.length === 0) {
    const error = new Error("Audio buffer is required");
    error.status = 400;
    throw error;
  }

  const useFormatting = normalizeBoolean(format);

  if (useFormatting && !language) {
    const error = new Error("language is required when format is enabled");
    error.status = 400;
    throw error;
  }

  const formData = new FormData();
  appendBooleanIfDefined(formData, "format", useFormatting);
  appendIfDefined(formData, "language", language);
  appendBooleanIfDefined(formData, "filler_words", fillerWords);
  appendBooleanIfDefined(formData, "diarize", diarize);
  appendBooleanIfDefined(formData, "multichannel", multichannel);
  appendIfDefined(formData, "channels", channels);
  appendIfDefined(formData, "audio_format", audioFormat);
  appendIfDefined(formData, "sample_rate", sampleRate);

  for (const keyterm of normalizeKeyterms(keyterms)) {
    formData.append("keyterm", keyterm);
  }

  formData.append("file", audioBuffer, {
    filename: fileName,
    contentType,
  });

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      ...formData.getHeaders(),
    },
    body: formData,
  });

  const body = await readResponseBody(response);

  if (!response.ok) {
    const error = new Error("xAI STT request failed");
    error.status = response.status;
    error.details = body;
    throw error;
  }

  if (!body || typeof body !== "object") {
    const error = new Error("xAI STT returned an unexpected response");
    error.status = 502;
    error.details = body;
    throw error;
  }

  return body;
}

export function durationFromSttResponse(body) {
  if (!body || typeof body !== "object") return null;
  const direct = Number(body.duration);
  if (Number.isFinite(direct) && direct >= 0) return direct;
  const words = Array.isArray(body.words) ? body.words : [];
  if (words.length) {
    const last = words[words.length - 1];
    const end = Number(last?.end);
    if (Number.isFinite(end) && end > 0) return end;
  }
  return null;
}

export function transcriptFromSttResponse(body) {
  if (!body) return "";
  if (typeof body === "string") return body.trim();
  if (typeof body !== "object") return "";
  const direct = body.text || body.transcript || body.result;
  if (typeof direct === "string" && direct.trim()) return direct.trim();
  const alt =
    body.results?.channels?.[0]?.alternatives?.[0]?.transcript ||
    body.results?.transcripts?.[0]?.transcript ||
    body.channels?.[0]?.alternatives?.[0]?.transcript;
  return String(alt || "").trim();
}
