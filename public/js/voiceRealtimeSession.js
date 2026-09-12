/**
 * Shared xAI Speech-to-Speech (realtime) helpers.
 *
 * Keep this aligned with https://docs.x.ai/developers/model-capabilities/audio/voice-agent
 * — model alias, session.update shape, VAD, binary transport, error parsing.
 * Browser capture/playback lives here so Call Agent and chat voice stay fast
 * (no extra JSON/base64 hops, no ScriptProcessor on the happy path).
 */

/** Current xAI alias for the flagship voice model. */
export const VOICE_REALTIME_MODEL = "grok-voice-latest";
export const VOICE_REALTIME_WS_BASE = "wss://api.x.ai/v1/realtime";

/** PCM rates accepted by the Speech-to-Speech API. */
export const VOICE_PCM_SAMPLE_RATES = Object.freeze([
  8000, 16000, 22050, 24000, 32000, 44100, 48000,
]);

export const VOICE_PREFERRED_SAMPLE_RATE = 24000;

/**
 * Voice conversations should not wait on reasoning. xAI only accepts
 * "high" | "none" (default "high"). "low" is rejected and leaves the
 * websocket open with an error event.
 */
export const VOICE_REALTIME_REASONING_EFFORT = "none";

/** ~20ms capture frames — small enough for barge-in, large enough to batch. */
export const VOICE_CAPTURE_FRAME_MS = 20;

/**
 * Server VAD tuned for live calls. Defaults (threshold 0.85, longer silence)
 * feel sluggish; these values keep turn-taking snappy without clipping words.
 */
export const VOICE_SERVER_VAD = Object.freeze({
  type: "server_vad",
  threshold: 0.5,
  silence_duration_ms: 400,
  prefix_padding_ms: 200,
});

export const PCM_CAPTURE_WORKLET_NAME = "pcm-capture";

export const PCM_CAPTURE_WORKLET_SOURCE = `
class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._chunks = [];
    this._length = 0;
    this._frameSamples = Math.max(160, Math.round(sampleRate * 0.02));
    this.port.onmessage = (event) => {
      const next = Number(event.data && event.data.frameSamples);
      if (Number.isFinite(next) && next > 0) {
        this._frameSamples = next | 0;
      }
    };
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel || !channel.length) return true;
    this._chunks.push(Float32Array.from(channel));
    this._length += channel.length;
    if (this._length < this._frameSamples) return true;

    const pcm16 = new Int16Array(this._length);
    let offset = 0;
    for (const chunk of this._chunks) {
      for (let i = 0; i < chunk.length; i++) {
        const sample = Math.max(-1, Math.min(1, chunk[i]));
        pcm16[offset++] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
      }
    }
    this._chunks = [];
    this._length = 0;
    this.port.postMessage(pcm16, [pcm16.buffer]);
    return true;
  }
}

registerProcessor("${PCM_CAPTURE_WORKLET_NAME}", PcmCaptureProcessor);
`;

export function snapVoicePcmSampleRate(rate) {
  const n = Number(rate);
  if (!Number.isFinite(n) || n <= 0) return VOICE_PREFERRED_SAMPLE_RATE;
  let best = VOICE_PREFERRED_SAMPLE_RATE;
  let bestDiff = Infinity;
  for (const supported of VOICE_PCM_SAMPLE_RATES) {
    const diff = Math.abs(supported - n);
    if (diff < bestDiff) {
      best = supported;
      bestDiff = diff;
    }
  }
  return best;
}

export function buildRealtimeWebSocketUrl(model = VOICE_REALTIME_MODEL) {
  const chosen = String(model || "").trim() || VOICE_REALTIME_MODEL;
  return `${VOICE_REALTIME_WS_BASE}?model=${encodeURIComponent(chosen)}`;
}

export function extractRealtimeErrorMessage(event) {
  if (!event) return "";
  if (typeof event === "string") return event.trim();
  const nested =
    (event.error && typeof event.error === "object" && event.error.message) ||
    (typeof event.error === "string" && event.error) ||
    event.message ||
    event.reason ||
    "";
  return String(nested || "").trim();
}

export function isNonFatalRealtimeError(message) {
  const text = String(message || "").toLowerCase();
  if (!text) return false;
  return (
    /no active response/.test(text) ||
    /nothing to cancel/.test(text) ||
    /already cancelled/.test(text) ||
    /cancellation failed/.test(text) ||
    /response\.cancel/.test(text) ||
    /cannot cancel/.test(text) ||
    /input_audio_buffer\.clear/.test(text)
  );
}

/** How often a live call refreshes the injected clock in session instructions. */
export const CALL_AGENT_CLOCK_REFRESH_MS = 60_000;

function formatUtcOffset(date) {
  const minutes = -date.getTimezoneOffset();
  const sign = minutes >= 0 ? "+" : "-";
  const abs = Math.abs(minutes);
  const hh = String(Math.floor(abs / 60)).padStart(2, "0");
  const mm = String(abs % 60).padStart(2, "0");
  return `UTC${sign}${hh}:${mm}`;
}

function formatClockPart(date, timeZone, options) {
  try {
    return new Intl.DateTimeFormat("en-GB", { timeZone, ...options }).format(date);
  } catch {
    return new Intl.DateTimeFormat("en-GB", options).format(date);
  }
}

/**
 * Hidden context injected into every Call Agent session so the model knows
 * the current instant. Callers are asked where they are before a local time
 * is given — the operator clock is not assumed to be the caller's timezone.
 *
 * @param {Date} [now]
 * @returns {string}
 */
export function buildVoiceClockContext(now = new Date()) {
  const date = now instanceof Date && !Number.isNaN(now.getTime()) ? now : new Date();
  const timeZone =
    (typeof Intl !== "undefined" &&
      Intl.DateTimeFormat().resolvedOptions().timeZone) ||
    "UTC";
  const weekday = formatClockPart(date, timeZone, { weekday: "long" });
  const calendarDate = formatClockPart(date, timeZone, {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
  const localTime = formatClockPart(date, timeZone, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const utcTime = formatClockPart(date, "UTC", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const offset = formatUtcOffset(date);

  return [
    "[CURRENT DATE AND TIME]",
    "This block is injected automatically on every call. It is hidden context — do not read it aloud, quote it, or mention that you were given the date or time.",
    `Right now it is ${weekday}, ${calendarDate}.`,
    `Operator local time: ${localTime} (${timeZone}, ${offset}).`,
    `UTC: ${utcTime} (${date.toISOString()}).`,
    "If the caller asks what time it is, or needs a time for a meeting, reminder, or deadline, first ask where they are (city, country, or timezone). Then give the current time in that place. Do not assume they share the operator timezone. Do not give only the operator local time unless they say they are in the same place. If they name a city or timezone, convert from the UTC instant above. If you are unsure of a location's timezone, ask a short clarifying question.",
  ].join("\n");
}

export function buildRealtimeSessionUpdate({
  voice,
  instructions,
  sampleRate,
  tools = null,
  extraSession = null,
  binaryTransport = true,
} = {}) {
  const rate = snapVoicePcmSampleRate(sampleRate);
  const input = { format: { type: "audio/pcm", rate } };
  const output = { format: { type: "audio/pcm", rate } };
  if (binaryTransport) {
    input.transport = "binary";
    output.transport = "binary";
  }
  const session = {
    voice: String(voice || "eve").trim() || "eve",
    instructions: String(instructions || "").trim(),
    reasoning: { effort: VOICE_REALTIME_REASONING_EFFORT },
    turn_detection: { ...VOICE_SERVER_VAD },
    audio: { input, output },
  };
  if (Array.isArray(tools) && tools.length) {
    session.tools = tools;
  }
  if (extraSession && typeof extraSession === "object") {
    Object.assign(session, extraSession);
  }
  return { type: "session.update", session };
}

export function float32ToPcm16(float32) {
  const input = float32 || [];
  const pcm16 = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const sample = Math.max(-1, Math.min(1, input[i]));
    pcm16[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }
  return pcm16;
}

export function pcm16ToFloat32(pcm16) {
  const input = pcm16 || [];
  const float32 = new Float32Array(input.length);
  for (let i = 0; i < input.length; i++) {
    float32[i] = input[i] / 32768;
  }
  return float32;
}

export function pcm16FromBinary(data) {
  if (!data) return new Int16Array(0);
  let bytes;
  if (ArrayBuffer.isView(data)) {
    bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  } else if (typeof data.byteLength === "number") {
    try {
      bytes = new Uint8Array(data);
    } catch {
      return new Int16Array(0);
    }
  } else {
    return new Int16Array(0);
  }
  const evenLength = bytes.byteLength - (bytes.byteLength % 2);
  if (evenLength <= 0) return new Int16Array(0);
  const copy = new ArrayBuffer(evenLength);
  new Uint8Array(copy).set(bytes.subarray(0, evenLength));
  return new Int16Array(copy);
}

export function isRealtimeBinaryMessage(data) {
  if (data == null || typeof data === "string") return false;
  if (ArrayBuffer.isView(data)) return true;
  if (typeof Blob !== "undefined" && data instanceof Blob) return true;
  return Object.prototype.toString.call(data) === "[object ArrayBuffer]";
}

/**
 * Gapless PCM16 player. Schedules buffers against AudioContext.currentTime
 * instead of waiting for onended, which is what used to add barge-in lag.
 */
export function createPcmStreamPlayer() {
  let nextTime = 0;
  let generation = 0;
  const sources = new Set();

  return {
    enqueuePcm16(audioContext, sampleRate, pcm16) {
      if (!audioContext || audioContext.state === "closed") return;
      const samples = pcm16 && pcm16.length ? pcm16 : null;
      if (!samples) return;
      const rate = snapVoicePcmSampleRate(
        sampleRate || audioContext.sampleRate || VOICE_PREFERRED_SAMPLE_RATE,
      );
      const float32 = pcm16ToFloat32(samples);
      const buffer = audioContext.createBuffer(1, float32.length, rate);
      buffer.getChannelData(0).set(float32);
      const source = audioContext.createBufferSource();
      source.buffer = buffer;
      source.connect(audioContext.destination);
      const now = audioContext.currentTime;
      if (nextTime < now) nextTime = now;
      const startAt = nextTime;
      try {
        source.start(startAt);
      } catch {
        return;
      }
      nextTime = startAt + buffer.duration;
      const gen = generation;
      sources.add(source);
      source.onended = () => {
        if (gen === generation) sources.delete(source);
      };
    },
    stop() {
      generation += 1;
      for (const source of sources) {
        try {
          source.stop();
        } catch {
          // already stopped
        }
      }
      sources.clear();
      nextTime = 0;
    },
    get isPlaying() {
      return sources.size > 0;
    },
  };
}

export async function ensurePcmCaptureWorklet(audioContext) {
  if (!audioContext?.audioWorklet?.addModule) return false;
  if (audioContext.__pcmCaptureWorkletReady) return true;
  const blob = new Blob([PCM_CAPTURE_WORKLET_SOURCE], {
    type: "application/javascript",
  });
  const url = URL.createObjectURL(blob);
  try {
    await audioContext.audioWorklet.addModule(url);
    audioContext.__pcmCaptureWorkletReady = true;
    return true;
  } catch (error) {
    console.warn("[VoiceRealtime] AudioWorklet unavailable:", error);
    return false;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Start mic capture. Prefers AudioWorklet; falls back to ScriptProcessor.
 * Never routes mic to the speakers (that caused echo and extra mixing work).
 */
export async function attachPcmCapture({
  audioContext,
  mediaStream,
  onPcm16,
  sampleRate,
} = {}) {
  if (!audioContext || !mediaStream || typeof onPcm16 !== "function") {
    return null;
  }

  const source = audioContext.createMediaStreamSource(mediaStream);
  const mute = audioContext.createGain();
  mute.gain.value = 0;
  mute.connect(audioContext.destination);

  const frameSamples = Math.max(
    160,
    Math.round(
      (sampleRate || audioContext.sampleRate || VOICE_PREFERRED_SAMPLE_RATE) *
        (VOICE_CAPTURE_FRAME_MS / 1000),
    ),
  );

  const workletOk = await ensurePcmCaptureWorklet(audioContext);
  if (workletOk) {
    const node = new AudioWorkletNode(audioContext, PCM_CAPTURE_WORKLET_NAME, {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCount: 1,
    });
    node.port.onmessage = (event) => {
      if (event.data) onPcm16(event.data);
    };
    node.port.postMessage({ frameSamples });
    source.connect(node);
    node.connect(mute);
    return {
      source,
      mute,
      node,
      kind: "worklet",
      disconnect() {
        try {
          node.port.onmessage = null;
          node.disconnect();
        } catch {
          // ignore
        }
        try {
          source.disconnect();
        } catch {
          // ignore
        }
        try {
          mute.disconnect();
        } catch {
          // ignore
        }
      },
    };
  }

  const bufferSize = 2048;
  const processor = audioContext.createScriptProcessor(bufferSize, 1, 1);
  processor.onaudioprocess = (event) => {
    const input = event.inputBuffer.getChannelData(0);
    onPcm16(float32ToPcm16(input));
  };
  source.connect(processor);
  processor.connect(mute);
  return {
    source,
    mute,
    node: processor,
    kind: "script",
    disconnect() {
      try {
        processor.onaudioprocess = null;
        processor.disconnect();
      } catch {
        // ignore
      }
      try {
        source.disconnect();
      } catch {
        // ignore
      }
      try {
        mute.disconnect();
      } catch {
        // ignore
      }
    },
  };
}

export function sendRealtimePcm16(ws, pcm16, { binary = true } = {}) {
  if (!ws || ws.readyState !== 1 || !pcm16 || !pcm16.length) return false;
  if (binary) {
    const view = pcm16 instanceof Int16Array ? pcm16 : new Int16Array(pcm16);
    const start = view.byteOffset || 0;
    const end = start + (view.byteLength || view.length * 2);
    ws.send(view.buffer.slice(start, end));
    return true;
  }
  const bytes = new Uint8Array(
    pcm16.buffer,
    pcm16.byteOffset || 0,
    pcm16.byteLength || pcm16.length * 2,
  );
  let binaryString = "";
  for (let i = 0; i < bytes.length; i++) {
    binaryString += String.fromCharCode(bytes[i]);
  }
  ws.send(
    JSON.stringify({
      type: "input_audio_buffer.append",
      audio: btoa(binaryString),
    }),
  );
  return true;
}

export function sendRealtimeJson(ws, payload) {
  if (!ws || ws.readyState !== 1) return false;
  ws.send(JSON.stringify(payload));
  return true;
}

export function sendRealtimeResponseCancel(ws) {
  return sendRealtimeJson(ws, { type: "response.cancel" });
}

export function sendRealtimeInputAudioClear(ws) {
  return sendRealtimeJson(ws, { type: "input_audio_buffer.clear" });
}
