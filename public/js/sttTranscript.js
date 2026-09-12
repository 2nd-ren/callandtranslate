/**
 * xAI streaming STT (`transcript.partial`) uses two flags:
 *   is_final=false                 interim — text may still change
 *   is_final=true, speech_final=false  chunk locked (~3s of speech)
 *   is_final=true, speech_final=true   utterance complete (stitched)
 *
 * Chunk-final and utterance-final often carry identical text, so a short
 * mic line like "OK" is emitted twice. Keep one caller turn open until
 * speech_final; never append a second row for the same utterance.
 */

function asBoolean(value) {
  return value === true || value === "true";
}

export function spokenTextKey(text) {
  return String(text || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

export function displaySpeakerLabel(speaker) {
  const name = String(speaker || "").trim();
  if (!name) return "Other person";
  if (name === "Agent" || name === "You") return name;
  const caller = name.match(/^Caller(?:\s+(\d+))?$/i);
  if (caller) {
    const n = caller[1] ? Number(caller[1]) : 1;
    return n > 1 ? `Other person ${n}` : "Other person";
  }
  if (/^Speaker(?:\s+\d+)?$/i.test(name)) return "Other person";
  return name;
}

export function turnVisualKind(speaker) {
  const name = String(speaker || "");
  if (name === "Agent") return "agent";
  if (name === "You") return "you";
  if (/^Caller/i.test(name) || /^Speaker/i.test(name)) return "caller";
  return "you";
}

export function composeCallerPreviewText(chunks, latestText) {
  const latest = String(latestText || "").trim();
  const values = Object.keys(chunks || {})
    .sort((a, b) => Number(a) - Number(b))
    .map((key) => String(chunks[key] || "").trim())
    .filter(Boolean);
  if (latest && !values.includes(latest)) values.push(latest);
  if (!values.length) return latest;
  if (values.length === 1) return values[0];
  const longest = values.reduce((a, b) => (a.length >= b.length ? a : b));
  if (values.every((part) => longest.includes(part))) return longest;
  return values.join(" ").replace(/\s+/g, " ").trim();
}

export function parseSttTranscriptEvent(data) {
  if (!data || typeof data !== "object") return null;
  const type = String(data.type || "");
  if (type !== "transcript.partial" && type !== "transcript.done") return null;
  const text = String(
    data.text || data.transcript || data.channel?.text || "",
  ).trim();
  const wordSpeaker = Array.isArray(data.words)
    ? data.words.find((word) => typeof word?.speaker === "number")?.speaker
    : undefined;
  const speakerIndex =
    typeof data.speaker === "number"
      ? data.speaker
      : typeof wordSpeaker === "number"
        ? wordSpeaker
        : null;
  return {
    type,
    text,
    isFinal: asBoolean(data.is_final),
    speechFinal: asBoolean(data.speech_final) || type === "transcript.done",
    speaker:
      speakerIndex == null ? "Caller" : `Caller ${speakerIndex + 1}`,
    start: typeof data.start === "number" ? data.start : null,
  };
}

function lastMicTurn(transcript) {
  if (!Array.isArray(transcript)) return null;
  for (let i = transcript.length - 1; i >= 0; i -= 1) {
    const row = transcript[i];
    if (!row) continue;
    if (row.source === "stt" || String(row.speaker || "").startsWith("Caller")) {
      return row;
    }
  }
  return null;
}

function isSameUtterance(turn, text, nowMs, windowMs = 800) {
  if (!turn || spokenTextKey(turn.text) !== spokenTextKey(text)) return false;
  if (turn.status !== "final") return true;
  const stamp = Date.parse(turn.updatedAt || turn.timestamp || "");
  return Number.isFinite(stamp) && nowMs - stamp < windowMs;
}

/**
 * Mutates `state.transcript` / interim pointers. Returns whether UI should
 * update and whether the closed turn needs translation.
 */
export function applyCallerSttEvent(state, data, options = {}) {
  const parsed = parseSttTranscriptEvent(data);
  if (!parsed) return { changed: false, turn: null, shouldTranslate: false };
  if (!parsed.text) {
    if (parsed.type === "transcript.done") {
      const open = state.callerInterimTurnId
        ? state.transcript.find((row) => row.id === state.callerInterimTurnId)
        : null;
      if (open && open.status !== "final") {
        open.status = "final";
        state.callerInterimTurnId = null;
        state.callerInterimChunks = null;
        return {
          changed: true,
          turn: open,
          shouldTranslate: Boolean(open.text) && !open.translation,
        };
      }
    }
    return { changed: false, turn: null, shouldTranslate: false };
  }

  const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
  const nowMs = now.getTime();
  const nextId =
    options.nextId ||
    (() => `t${++state.transcriptSeq}`);
  const utteranceDone = parsed.speechFinal === true;

  let turn = state.callerInterimTurnId
    ? state.transcript.find((row) => row.id === state.callerInterimTurnId)
    : null;

  if (!turn) {
    const last = lastMicTurn(state.transcript);
    if (last && last.status !== "final") {
      turn = last;
    } else if (utteranceDone && last && isSameUtterance(last, parsed.text, nowMs)) {
      turn = last;
    }
  }

  if (!turn) {
    turn = {
      id: nextId(),
      speaker: parsed.speaker,
      text: parsed.text,
      translation: "",
      status: utteranceDone ? "final" : "interim",
      source: "stt",
      timestamp: now.toISOString(),
      updatedAt: now.toISOString(),
    };
    state.transcript.push(turn);
    state.callerInterimChunks =
      parsed.start != null ? { [parsed.start]: parsed.text } : {};
    if (utteranceDone) {
      state.callerInterimTurnId = null;
      state.callerInterimChunks = null;
      return { changed: true, turn, shouldTranslate: true };
    }
    state.callerInterimTurnId = turn.id;
    return { changed: true, turn, shouldTranslate: false };
  }

  if (!state.callerInterimChunks || typeof state.callerInterimChunks !== "object") {
    state.callerInterimChunks = {};
  }
  if (parsed.start != null) {
    state.callerInterimChunks[parsed.start] = parsed.text;
  }

  const nextText = utteranceDone
    ? parsed.text
    : composeCallerPreviewText(state.callerInterimChunks, parsed.text);
  const speakerChanged = parsed.speaker && parsed.speaker !== turn.speaker;
  const textChanged = turn.text !== nextText;
  const statusChanged = (utteranceDone ? "final" : "interim") !== turn.status;

  turn.speaker = parsed.speaker || turn.speaker;
  turn.text = nextText;
  turn.status = utteranceDone ? "final" : "interim";
  turn.updatedAt = now.toISOString();
  if (textChanged) turn.translation = "";

  if (utteranceDone) {
    state.callerInterimTurnId = null;
    state.callerInterimChunks = null;
    return {
      changed: true,
      turn,
      shouldTranslate: Boolean(turn.text) && !turn.translation,
    };
  }

  state.callerInterimTurnId = turn.id;
  return {
    changed: textChanged || statusChanged || speakerChanged,
    turn,
    shouldTranslate: false,
  };
}

export function collapseAdjacentDuplicateTurns(turns = []) {
  const out = [];
  for (const turn of turns) {
    const prev = out[out.length - 1];
    if (
      prev &&
      displaySpeakerLabel(prev.speaker) === displaySpeakerLabel(turn.speaker) &&
      spokenTextKey(prev.text) === spokenTextKey(turn.text)
    ) {
      if (turn.status === "final") prev.status = "final";
      if (turn.translation && !prev.translation) prev.translation = turn.translation;
      if (turn.id) prev.id = prev.id || turn.id;
      continue;
    }
    out.push(turn);
  }
  return out;
}
