import { grokChatCompletion } from "./grokClient.js";
import { getDefaultGrokTextModel } from "./xaiGrokModel.js";
import { languageName, normalizeLanguageCode } from "./languages.js";
import {
  durationFromSttResponse,
  transcriptFromSttResponse,
  transcribeAudioBufferWithXai,
} from "./xaiSpeechToText.js";
import { logLlmUsage, logTranscriptionUsage } from "./usageLogger.js";
import { assertCallAccess } from "./plans.js";
import { CallAgentServiceError } from "./callAgentService.js";
import { formatCallTime } from "./creditCalculator.js";

export const MAX_FILL_AUDIO_BYTES = 8 * 1024 * 1024;
export const MAX_FOLLOW_UPS = 8;

const FILL_SYSTEM_PROMPT = `You turn a person's spoken or written description into a call brief for Call & Translate.
The brief is used by a live voice agent sitting with the operator on speakerphone. The agent will speak on the operator's behalf.

The operator is trying to get something done by calling a person, business, office, clinic, hotel desk, landlord, government counter, or similar.

Return JSON with:
- goal: what they need done, one or two sentences, imperative, ready to use on a live call
- rules: how to handle the call — who they are calling on behalf of, tone, constraints, what to do if something is missing
- information: facts already known that the other side is likely to ask for, and facts the operator wants to find out. Do not invent missing facts. If a needed fact is still missing after follow-ups, say so so the agent will check with the operator on the call.
- calling: a short label for who or what they are calling (for example "hotel front desk", "GP reception", "the landlord"). If unknown, describe the role as best you can from the description.
- followUps: questions to ask the OPERATOR before the call — not questions for the agent to ask the other party. Each item has:
  - question: a short, direct question the operator can answer in a few words
  - reason: one short sentence on why that person, business, or office will likely ask for this

Think like the other side of the call. Given the goal and who they are calling, what will they ask for? Check what is already in the description and only ask for what is still missing.
Do not invent names, numbers, dates, account IDs, or prices that were not in the description.
If an existing brief is provided, keep useful facts from it and complete or correct it from the new description.
Ask 3–6 high-value follow-ups when something important is missing. If nothing important is missing, return an empty followUps array.
Keep each field concise. Write in the operator's language.`;

const APPLY_FOLLOW_UP_PROMPT = `You update a call brief after the operator answered pre-call follow-up questions.

The voice agent will speak on the operator's behalf. Fold the new answers into the Information section as facts the agent can use on the live call.

Return JSON with:
- goal: keep or lightly tighten the existing goal
- rules: keep useful rules; adjust only if the answers change how the call should be handled
- information: existing facts plus the new answers, written as usable call facts. Do not invent names, numbers, dates, account IDs, or prices. If the operator skipped a question or said they do not know, note that the agent should check with the operator if asked.
- calling: keep or correct the short label for who they are calling
- followUps: always return an empty array

Write in the operator's language. Keep fields concise.`;

const CALL_BRIEF_JSON_SCHEMA = {
  type: "json_schema",
  json_schema: {
    name: "call_brief",
    strict: true,
    schema: {
      type: "object",
      properties: {
        goal: { type: "string" },
        rules: { type: "string" },
        information: { type: "string" },
        calling: { type: "string" },
        followUps: {
          type: "array",
          items: {
            type: "object",
            properties: {
              question: { type: "string" },
              reason: { type: "string" },
            },
            required: ["question", "reason"],
            additionalProperties: false,
          },
        },
      },
      required: ["goal", "rules", "information", "calling", "followUps"],
      additionalProperties: false,
    },
  },
};

function throwFillError(message, { status = 400, code = "FILL_BRIEF_ERROR" } = {}) {
  throw new CallAgentServiceError(message, { status, code });
}

export function decodeAudioBase64(audioBase64) {
  const raw = String(audioBase64 || "").trim();
  if (!raw) return null;
  const payload = raw.includes(",") ? raw.slice(raw.indexOf(",") + 1) : raw;
  const buffer = Buffer.from(payload, "base64");
  if (!buffer.length) return null;
  return buffer;
}

function fileNameForMime(mimeType) {
  const mime = String(mimeType || "").toLowerCase();
  if (mime.includes("mp4") || mime.includes("m4a") || mime.includes("aac")) {
    return { fileName: "dictation.mp4", contentType: mime || "audio/mp4" };
  }
  if (mime.includes("ogg") || mime.includes("opus")) {
    return { fileName: "dictation.ogg", contentType: mime || "audio/ogg" };
  }
  if (mime.includes("wav")) {
    return { fileName: "dictation.wav", contentType: mime || "audio/wav" };
  }
  if (mime.includes("mpeg") || mime.includes("mp3")) {
    return { fileName: "dictation.mp3", contentType: mime || "audio/mpeg" };
  }
  return { fileName: "dictation.webm", contentType: mime || "audio/webm" };
}

export function parseFilledBrief(text) {
  const raw = String(text || "").trim();
  if (!raw) {
    throwFillError("Grok did not return a call brief.", {
      status: 502,
      code: "FILL_BRIEF_EMPTY",
    });
  }
  const match = raw.match(/\{[\s\S]*\}/);
  const jsonText = match ? match[0] : raw;
  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    throwFillError("Grok returned a brief that could not be read.", {
      status: 502,
      code: "FILL_BRIEF_PARSE",
    });
  }
  return {
    goal: String(parsed?.goal || "").trim(),
    rules: String(parsed?.rules || "").trim(),
    information: String(parsed?.information || "").trim(),
    calling: normalizeCalling(parsed?.calling || parsed?.callee),
    followUps: parseFollowUps(parsed?.followUps || parsed?.followups || parsed?.questions),
  };
}

function compactText(value, max = 240) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

export function normalizeCalling(value) {
  return compactText(value, 120);
}

export function parseFollowUps(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const seen = new Set();
  const followUps = [];
  for (const row of list) {
    const question = compactText(row?.question || row?.prompt || "", 240);
    if (!question) continue;
    const key = question.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    followUps.push({
      id: `fu-${followUps.length + 1}`,
      question,
      reason: compactText(row?.reason || row?.why || "", 280),
    });
    if (followUps.length >= MAX_FOLLOW_UPS) break;
  }
  return followUps;
}

export function normalizeFollowUpAnswers(raw) {
  const list = Array.isArray(raw) ? raw : [];
  return list
    .map((row) => ({
      id: compactText(row?.id || "", 32),
      question: compactText(row?.question || "", 240),
      reason: compactText(row?.reason || "", 280),
      answer: String(row?.answer || "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 800),
    }))
    .filter((row) => row.question || row.answer);
}

export function mergeFollowUpAnswersLocally({
  information = "",
  answers = [],
  notes = "",
} = {}) {
  const facts = [];
  for (const row of normalizeFollowUpAnswers(answers)) {
    const answer = String(row.answer || "").trim();
    if (!answer) continue;
    facts.push(row.question ? `${row.question}: ${answer}` : answer);
  }
  const extra = String(notes || "").trim();
  if (extra) facts.push(extra);
  if (!facts.length) return String(information || "").trim();
  const current = String(information || "").trim();
  const block = ["Additional details from the operator:", ...facts.map((line) => `- ${line}`)].join(
    "\n",
  );
  return current ? `${current}\n\n${block}` : block;
}

function existingBriefBlock({ existingGoal, existingRules, existingInformation, calling } = {}) {
  if (!existingGoal && !existingRules && !existingInformation && !calling) return "";
  return [
    "Existing brief (use as starting context):",
    `Goal: ${existingGoal || "(empty)"}`,
    `Rules: ${existingRules || "(empty)"}`,
    `Information: ${existingInformation || "(empty)"}`,
    calling ? `Calling: ${calling}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

async function completeBriefWithGrok({
  userId,
  systemPrompt,
  userPrompt,
  source,
  metadata = {},
  maxTokens = 2000,
  timeoutMs = 60000,
}) {
  const result = await grokChatCompletion({
    model: getDefaultGrokTextModel(),
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    temperature: 0.2,
    maxTokens,
    timeoutMs,
    reasoningEffort: "low",
    responseFormat: CALL_BRIEF_JSON_SCHEMA,
  });
  const filled = parseFilledBrief(result.text);
  const llmUsage = await logLlmUsage({
    userId,
    callType: source,
    model: result.raw?.model || getDefaultGrokTextModel(),
    usage: result.usage || {},
    skipDeduct: false,
    metadata,
  });
  return { filled, result, llmUsage };
}

function assertAudioSize(audioBuffer) {
  if (audioBuffer && audioBuffer.length > MAX_FILL_AUDIO_BYTES) {
    throwFillError("That recording is too long. Keep dictation under a few minutes.", {
      status: 413,
      code: "FILL_AUDIO_TOO_LARGE",
    });
  }
}

async function transcribeFillAudio({
  userId,
  audioBuffer,
  mimeType,
  audioDurationSec = 0,
  language,
  source = "dictate-and-fill",
}) {
  const file = fileNameForMime(mimeType);
  const sttBody = await transcribeAudioBufferWithXai({
    audioBuffer,
    fileName: file.fileName,
    contentType: file.contentType,
    language,
    format: true,
  });
  const spoken = transcriptFromSttResponse(sttBody);
  const durationSec =
    durationFromSttResponse(sttBody) ||
    Math.max(0, Number(audioDurationSec) || 0);
  const sttUsage = await logTranscriptionUsage({
    userId,
    durationSec,
    model: "xai-stt-rest",
    streaming: false,
    skipDeduct: false,
    metadata: { source },
  });
  return { spoken, sttUsage, durationSec };
}

export async function transcribeDictation({
  userId,
  audioBase64 = "",
  mimeType = "",
  audioDurationSec = 0,
  language = "en",
} = {}) {
  const operatorLanguage = normalizeLanguageCode(language, "en");
  const audioBuffer = decodeAudioBase64(audioBase64);
  assertAudioSize(audioBuffer);
  if (!audioBuffer) {
    throwFillError("Nothing was recorded. Try dictation again, or type the notes.", {
      status: 400,
      code: "DICTATE_AUDIO_MISSING",
    });
  }

  const access = await assertCallAccess(userId);
  const { spoken, sttUsage, durationSec } = await transcribeFillAudio({
    userId,
    audioBuffer,
    mimeType,
    audioDurationSec,
    language: operatorLanguage,
    source: "dictate-transcribe",
  });
  if (!spoken) {
    throwFillError("Nothing could be heard in that recording. Try again, or type the notes.", {
      status: 400,
      code: "FILL_BRIEF_NO_SPEECH",
    });
  }

  const creditsDeducted = Number(sttUsage?.credits) || 0;
  const newBalance = sttUsage?.newBalance ?? access.balance;
  return {
    transcript: spoken,
    creditsDeducted,
    creditsDeductedLabel: formatCallTime(creditsDeducted),
    newBalance,
    remainingSeconds: newBalance,
    remainingLabel: formatCallTime(newBalance || 0),
    usage: {
      stt: sttUsage
        ? {
            durationSec,
            cost: sttUsage.cost,
            credits: sttUsage.credits,
          }
        : null,
    },
  };
}

export async function fillCallBrief({
  userId,
  notes = "",
  audioBase64 = "",
  mimeType = "",
  audioDurationSec = 0,
  language = "en",
  existingGoal = "",
  existingRules = "",
  existingInformation = "",
} = {}) {
  const operatorLanguage = normalizeLanguageCode(language, "en");
  const typedNotes = String(notes || "").trim();
  const audioBuffer = decodeAudioBase64(audioBase64);
  assertAudioSize(audioBuffer);
  if (!typedNotes && !audioBuffer) {
    throwFillError("Type what you need done, or dictate it, then fill the brief.", {
      status: 400,
      code: "FILL_BRIEF_MISSING",
    });
  }

  const access = await assertCallAccess(userId);
  let spoken = "";
  let sttUsage = null;

  if (audioBuffer) {
    const transcribed = await transcribeFillAudio({
      userId,
      audioBuffer,
      mimeType,
      audioDurationSec,
      language: operatorLanguage,
      source: "dictate-and-fill",
    });
    spoken = transcribed.spoken;
    sttUsage = transcribed.sttUsage;
  }

  const transcript = [typedNotes, spoken].filter(Boolean).join("\n\n").trim();
  if (!transcript) {
    throwFillError("Nothing could be heard in that recording. Try again, or type the notes.", {
      status: 400,
      code: "FILL_BRIEF_NO_SPEECH",
    });
  }

  const operatorLanguageName = languageName(operatorLanguage);
  const userPrompt = [
    `Write the brief in ${operatorLanguageName}.`,
    "The agent will speak on the operator's behalf.",
    existingBriefBlock({ existingGoal, existingRules, existingInformation }),
    "Description from the operator:",
    transcript,
    "From that description, infer the goal and who they are calling. Then list follow-up questions for facts the other side is likely to ask that are still missing.",
  ]
    .filter(Boolean)
    .join("\n\n");

  const { filled, llmUsage } = await completeBriefWithGrok({
    userId,
    systemPrompt: FILL_SYSTEM_PROMPT,
    userPrompt,
    source: "call-brief-fill",
    maxTokens: 2200,
    metadata: {
      source: "dictate-and-fill",
      hadAudio: Boolean(audioBuffer),
      notesChars: typedNotes.length,
    },
  });

  const fields = {
    goal: filled.goal || String(existingGoal || "").trim(),
    rules: filled.rules || String(existingRules || "").trim(),
    information: filled.information || String(existingInformation || "").trim(),
  };
  if (!fields.goal) {
    throwFillError("Grok did not produce a goal. Add a bit more detail and try again.", {
      status: 502,
      code: "FILL_BRIEF_NO_GOAL",
    });
  }

  const creditsDeducted =
    (Number(sttUsage?.credits) || 0) + (Number(llmUsage?.credits) || 0);
  const newBalance =
    llmUsage?.newBalance ?? sttUsage?.newBalance ?? access.balance;

  return {
    fields,
    calling: filled.calling,
    followUps: filled.followUps,
    transcript,
    creditsDeducted,
    creditsDeductedLabel: formatCallTime(creditsDeducted),
    newBalance,
    remainingSeconds: newBalance,
    remainingLabel: formatCallTime(newBalance || 0),
    usage: {
      stt: sttUsage
        ? {
            durationSec: sttUsage.durationSec,
            cost: sttUsage.cost,
            credits: sttUsage.credits,
          }
        : null,
      llm: {
        cost: llmUsage.cost,
        credits: llmUsage.credits,
        inputTokens: llmUsage.metrics?.inputTokens || 0,
        outputTokens: llmUsage.metrics?.outputTokens || 0,
        reasoningTokens: llmUsage.metrics?.reasoningTokens || 0,
      },
    },
  };
}

function usagePayload(sttUsage, llmUsage) {
  return {
    stt: sttUsage
      ? {
          durationSec: sttUsage.durationSec,
          cost: sttUsage.cost,
          credits: sttUsage.credits,
        }
      : null,
    llm: llmUsage
      ? {
          cost: llmUsage.cost,
          credits: llmUsage.credits,
          inputTokens: llmUsage.metrics?.inputTokens || 0,
          outputTokens: llmUsage.metrics?.outputTokens || 0,
          reasoningTokens: llmUsage.metrics?.reasoningTokens || 0,
        }
      : null,
  };
}

function billedResult({
  fields,
  calling = "",
  followUps = [],
  transcript = "",
  sttUsage = null,
  llmUsage = null,
  access,
  mergedLocally = false,
}) {
  const creditsDeducted =
    (Number(sttUsage?.credits) || 0) + (Number(llmUsage?.credits) || 0);
  const newBalance =
    llmUsage?.newBalance ?? sttUsage?.newBalance ?? access.balance;
  return {
    fields,
    calling: normalizeCalling(calling),
    followUps,
    transcript,
    mergedLocally,
    creditsDeducted,
    creditsDeductedLabel: formatCallTime(creditsDeducted),
    newBalance,
    remainingSeconds: newBalance,
    remainingLabel: formatCallTime(newBalance || 0),
    usage: usagePayload(sttUsage, llmUsage),
  };
}

export async function applyBriefFollowUps({
  userId,
  notes = "",
  audioBase64 = "",
  mimeType = "",
  audioDurationSec = 0,
  language = "en",
  existingGoal = "",
  existingRules = "",
  existingInformation = "",
  calling = "",
  answers = [],
} = {}) {
  const operatorLanguage = normalizeLanguageCode(language, "en");
  const typedNotes = String(notes || "").trim();
  const normalizedAnswers = normalizeFollowUpAnswers(answers);
  const answered = normalizedAnswers.filter((row) => row.answer);
  const audioBuffer = decodeAudioBase64(audioBase64);
  assertAudioSize(audioBuffer);
  if (!typedNotes && !audioBuffer && !answered.length) {
    throwFillError("Add an answer, dictate it, or skip this step.", {
      status: 400,
      code: "FOLLOW_UP_MISSING",
    });
  }

  const access = await assertCallAccess(userId);
  let spoken = "";
  let sttUsage = null;

  if (audioBuffer) {
    const transcribed = await transcribeFillAudio({
      userId,
      audioBuffer,
      mimeType,
      audioDurationSec,
      language: operatorLanguage,
      source: "brief-follow-up",
    });
    spoken = transcribed.spoken;
    sttUsage = transcribed.sttUsage;
  }

  const transcript = [typedNotes, spoken].filter(Boolean).join("\n\n").trim();
  const localInformation = mergeFollowUpAnswersLocally({
    information: existingInformation,
    answers: answered,
    notes: transcript,
  });
  const fieldsFromLocal = {
    goal: String(existingGoal || "").trim(),
    rules: String(existingRules || "").trim(),
    information: localInformation || String(existingInformation || "").trim(),
  };

  const operatorLanguageName = languageName(operatorLanguage);
  const answerBlock = answered.length
    ? [
        "Answers from the operator:",
        ...answered.map((row, index) => {
          const reason = row.reason ? ` (likely asked because: ${row.reason})` : "";
          return `${index + 1}. ${row.question || "Detail"}${reason}\nAnswer: ${row.answer}`;
        }),
      ].join("\n")
    : "";

  const userPrompt = [
    `Write the updated brief in ${operatorLanguageName}.`,
    "The agent will speak on the operator's behalf. Fold the operator's answers into Information as facts for the call.",
    existingBriefBlock({
      existingGoal,
      existingRules,
      existingInformation,
      calling,
    }),
    answerBlock,
    transcript ? `Additional notes from the operator:\n${transcript}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  try {
    const { filled, llmUsage } = await completeBriefWithGrok({
      userId,
      systemPrompt: APPLY_FOLLOW_UP_PROMPT,
      userPrompt,
      source: "call-brief-follow-up",
      maxTokens: 1800,
      metadata: {
        source: "brief-follow-up",
        hadAudio: Boolean(audioBuffer),
        answerCount: answered.length,
        notesChars: typedNotes.length,
      },
    });
    const fields = {
      goal: filled.goal || fieldsFromLocal.goal,
      rules: filled.rules || fieldsFromLocal.rules,
      information: filled.information || fieldsFromLocal.information,
    };
    if (!fields.goal) {
      throwFillError("Grok did not update the brief. Try adding the answers in Facts for the call.", {
        status: 502,
        code: "FOLLOW_UP_NO_GOAL",
      });
    }
    return billedResult({
      fields,
      calling: filled.calling || calling,
      followUps: [],
      transcript,
      sttUsage,
      llmUsage,
      access,
      mergedLocally: false,
    });
  } catch (error) {
    if (error instanceof CallAgentServiceError && error.status !== 502) {
      throw error;
    }
    if (error?.code === "INSUFFICIENT_CALL_TIME" || error?.status === 402) {
      throw error;
    }
    if (!fieldsFromLocal.information && !fieldsFromLocal.goal) {
      throw error;
    }
    return billedResult({
      fields: fieldsFromLocal,
      calling,
      followUps: [],
      transcript,
      sttUsage,
      llmUsage: null,
      access,
      mergedLocally: true,
    });
  }
}
