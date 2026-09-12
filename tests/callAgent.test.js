import { composeCallAgentInstructions, CALL_AGENT_DEFAULT_PROMPT } from "../utils/callAgentPrompt.js";
import { normalizeLanguageCode, languageName } from "../utils/languages.js";
import { creditsFromCallSeconds } from "../utils/creditCalculator.js";
import {
  parseFilledBrief,
  parseFollowUps,
  decodeAudioBase64,
  transcribeDictation,
  applyBriefFollowUps,
  mergeFollowUpAnswersLocally,
} from "../utils/callAgentFill.js";
import { transcriptFromSttResponse } from "../utils/xaiSpeechToText.js";
import { CallAgent } from "../public/js/callAgent.js";
import { isNonFatalRealtimeError } from "../public/js/voiceRealtimeSession.js";

describe("call agent brief", () => {
  test("injects both languages and speakerphone rules", () => {
    const text = composeCallAgentInstructions({
      prompt: CALL_AGENT_DEFAULT_PROMPT,
      goal: "Book a table for two",
      rules: "Be polite",
      information: "Name: Ada",
      yourLanguage: "en",
      theirLanguage: "fr",
      discloseAi: true,
    });
    expect(text).toMatch(/English/);
    expect(text).toMatch(/French/);
    expect(text).toMatch(/speakerphone/i);
    expect(text).toMatch(/Book a table for two/);
    expect(text).toMatch(/AI assistant/);
    expect(text).toMatch(/Never invent missing facts/);
    expect(text).toMatch(/Hard language rule/);
    expect(text).toMatch(/Default when more information is needed/);
    expect(text).toMatch(/hold on a second/);
    expect(text).toMatch(/address the operator only in English/);
    expect(text).toMatch(/address the other person only in French/);
  });

  test("injects the operator name when provided", () => {
    const named = composeCallAgentInstructions({
      goal: "Book a table",
      yourName: "  Ada   Lovelace  ",
      yourLanguage: "en",
      theirLanguage: "fr",
      discloseAi: true,
    });
    expect(named).toMatch(/The operator's name is Ada Lovelace/);
    expect(named).toMatch(/helping Ada Lovelace/);

    const unnamed = composeCallAgentInstructions({
      goal: "Book a table",
      yourLanguage: "en",
      theirLanguage: "fr",
      discloseAi: true,
    });
    expect(unnamed).not.toMatch(/The operator's name is/);
    expect(unnamed).toMatch(/helping the operator/);
  });

  test("default prompt asks the operator when more information is needed", () => {
    expect(CALL_AGENT_DEFAULT_PROMPT).toMatch(/Language lock/);
    expect(CALL_AGENT_DEFAULT_PROMPT).toMatch(
      /Always talk to the operator in the operator's language/,
    );
    expect(CALL_AGENT_DEFAULT_PROMPT).toMatch(
      /The default is to ask the operator/,
    );
    expect(CALL_AGENT_DEFAULT_PROMPT).toMatch(/hold on a second/);
    expect(CALL_AGENT_DEFAULT_PROMPT).toMatch(
      /First tell the other person, in their language/,
    );
  });

  test("normalizes language codes", () => {
    expect(normalizeLanguageCode("es-MX")).toBe("es");
    expect(languageName("ja")).toBe("Japanese");
  });

  test("call seconds become credits 1:1", () => {
    expect(creditsFromCallSeconds(125)).toBe(125);
  });

  test("parses a Grok-filled call brief", () => {
    const fields = parseFilledBrief(
      '```json\n{"goal":"Extend the stay","rules":"Be brief","information":"Name: Ada"}\n```',
    );
    expect(fields.goal).toBe("Extend the stay");
    expect(fields.rules).toBe("Be brief");
    expect(fields.information).toBe("Name: Ada");
    expect(fields.followUps).toEqual([]);
    expect(decodeAudioBase64("aGVsbG8=").toString("utf8")).toBe("hello");
    expect(
      transcriptFromSttResponse({
        results: { channels: [{ alternatives: [{ transcript: "Extend two nights" }] }] },
      }),
    ).toBe("Extend two nights");
  });

  test("parses follow-up questions the other side is likely to ask", () => {
    const fields = parseFilledBrief(
      JSON.stringify({
        goal: "Extend the stay two nights",
        rules: "Call on behalf of Ada",
        information: "Name: Ada Lovelace",
        calling: "hotel front desk",
        followUps: [
          {
            question: "What is the booking number?",
            reason: "Front desks usually need the reservation id before they change dates.",
          },
          { question: "What is the booking number?", reason: "duplicate" },
          { question: "", reason: "skip empty" },
        ],
      }),
    );
    expect(fields.calling).toBe("hotel front desk");
    expect(fields.followUps).toEqual([
      {
        id: "fu-1",
        question: "What is the booking number?",
        reason: "Front desks usually need the reservation id before they change dates.",
      },
    ]);
    expect(parseFollowUps([{ prompt: "Dates of the stay?", why: "They will confirm nights." }])).toEqual([
      {
        id: "fu-1",
        question: "Dates of the stay?",
        reason: "They will confirm nights.",
      },
    ]);
    const many = parseFollowUps(
      Array.from({ length: 12 }, (_, i) => ({ question: `Q${i + 1}?`, reason: "Need it." })),
    );
    expect(many).toHaveLength(8);
    expect(many[7].id).toBe("fu-8");
  });

  test("merges follow-up answers into facts without inventing details", () => {
    const information = mergeFollowUpAnswersLocally({
      information: "Name: Ada Lovelace",
      answers: [
        { question: "What is the booking number?", answer: "4419" },
        { question: "Any dietary needs?", answer: "  " },
      ],
      notes: "She wants a late checkout if possible.",
    });
    expect(information).toMatch(/Name: Ada Lovelace/);
    expect(information).toMatch(/What is the booking number\?: 4419/);
    expect(information).toMatch(/late checkout/);
    expect(information).not.toMatch(/dietary/);
  });

  test("transcribeDictation requires audio", async () => {
    await expect(transcribeDictation({})).rejects.toMatchObject({
      code: "DICTATE_AUDIO_MISSING",
    });
  });

  test("applyBriefFollowUps requires answers or notes", async () => {
    await expect(applyBriefFollowUps({})).rejects.toMatchObject({
      code: "FOLLOW_UP_MISSING",
    });
  });
});

describe("live call pause", () => {
  test("pause keeps the session running and freezes billed time", () => {
    const realNow = Date.now;
    let now = 1_700_000_000_000;
    Date.now = () => now;
    try {
      const agent = new CallAgent({ onChange() {}, onToast() {} });
      agent.state.status = "listening";
      agent.state.startedAt = now - 12_000;
      agent.pause();
      expect(agent.state.paused).toBe(true);
      expect(agent.state.status).toBe("paused");
      expect(agent.isRunning()).toBe(true);
      expect(agent.durationSec()).toBe(12);
      now += 60_000;
      expect(agent.durationSec()).toBe(12);
      agent.resume();
      expect(agent.state.paused).toBe(false);
      expect(agent.state.status).toBe("listening");
      expect(agent.isRunning()).toBe(true);
      now += 5_000;
      expect(agent.durationSec()).toBe(17);
    } finally {
      Date.now = realNow;
    }
  });

  test("clearing the input buffer is treated as a non-fatal realtime error", () => {
    expect(isNonFatalRealtimeError("input_audio_buffer.clear is not supported")).toBe(
      true,
    );
    expect(isNonFatalRealtimeError("Voice API error")).toBe(false);
  });
});
