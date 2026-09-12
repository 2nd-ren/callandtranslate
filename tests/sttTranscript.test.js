import {
  applyCallerSttEvent,
  collapseAdjacentDuplicateTurns,
  composeCallerPreviewText,
  displaySpeakerLabel,
  parseSttTranscriptEvent,
  spokenTextKey,
  turnVisualKind,
} from "../public/js/sttTranscript.js";

function freshState() {
  return {
    transcript: [],
    transcriptSeq: 0,
    callerInterimTurnId: null,
    callerInterimChunks: null,
  };
}

function apply(state, event, now = "2026-09-09T12:00:00.000Z") {
  return applyCallerSttEvent(state, event, { now });
}

describe("xAI mic transcript merging", () => {
  test("chunk-final then speech-final 'OK' is one turn, not two", () => {
    const state = freshState();
    apply(state, {
      type: "transcript.partial",
      text: "OK",
      is_final: true,
      speech_final: false,
      start: 1.2,
    });
    apply(state, {
      type: "transcript.partial",
      text: "OK",
      is_final: true,
      speech_final: true,
      start: 1.2,
    });

    expect(state.transcript).toHaveLength(1);
    expect(state.transcript[0].text).toBe("OK");
    expect(state.transcript[0].status).toBe("final");
    expect(state.transcript[0].speaker).toBe("Caller");
    expect(state.callerInterimTurnId).toBeNull();
  });

  test("interim then both finals stay a single growing turn", () => {
    const state = freshState();
    apply(state, {
      type: "transcript.partial",
      text: "OK",
      is_final: false,
      speech_final: false,
    });
    apply(state, {
      type: "transcript.partial",
      text: "OK",
      is_final: true,
      speech_final: false,
    });
    const result = apply(state, {
      type: "transcript.partial",
      text: "OK",
      is_final: true,
      speech_final: true,
    });

    expect(state.transcript).toHaveLength(1);
    expect(result.shouldTranslate).toBe(true);
    expect(state.transcript[0].status).toBe("final");
  });

  test("a second speech-final with the same text does not add another row", () => {
    const state = freshState();
    const t0 = "2026-09-09T12:00:00.000Z";
    apply(
      state,
      {
        type: "transcript.partial",
        text: "OK",
        is_final: true,
        speech_final: true,
      },
      t0,
    );
    apply(
      state,
      {
        type: "transcript.partial",
        text: "OK",
        is_final: true,
        speech_final: true,
      },
      "2026-09-09T12:00:00.200Z",
    );

    expect(state.transcript).toHaveLength(1);
  });

  test("a later distinct utterance becomes a second turn", () => {
    const state = freshState();
    apply(
      state,
      {
        type: "transcript.partial",
        text: "OK",
        is_final: true,
        speech_final: true,
      },
      "2026-09-09T12:00:00.000Z",
    );
    apply(
      state,
      {
        type: "transcript.partial",
        text: "See you tomorrow",
        is_final: false,
        speech_final: false,
      },
      "2026-09-09T12:00:04.000Z",
    );
    apply(
      state,
      {
        type: "transcript.partial",
        text: "See you tomorrow",
        is_final: true,
        speech_final: true,
      },
      "2026-09-09T12:00:04.400Z",
    );

    expect(state.transcript.map((row) => row.text)).toEqual([
      "OK",
      "See you tomorrow",
    ]);
  });

  test("does not treat agent turns as mic duplicates", () => {
    const state = freshState();
    state.transcript.push({
      id: "agent1",
      speaker: "Agent",
      text: "OK",
      status: "final",
      source: "voice",
    });
    apply(state, {
      type: "transcript.partial",
      text: "OK",
      is_final: true,
      speech_final: true,
    });

    expect(state.transcript).toHaveLength(2);
    expect(state.transcript[1].source).toBe("stt");
  });

  test("speech_final replaces chunked preview with the stitched utterance", () => {
    const state = freshState();
    apply(state, {
      type: "transcript.partial",
      text: "Hello how",
      is_final: true,
      speech_final: false,
      start: 0,
    });
    apply(state, {
      type: "transcript.partial",
      text: "are you",
      is_final: true,
      speech_final: false,
      start: 3.1,
    });
    apply(state, {
      type: "transcript.partial",
      text: "Hello how are you",
      is_final: true,
      speech_final: true,
      start: 0,
    });

    expect(state.transcript).toHaveLength(1);
    expect(state.transcript[0].text).toBe("Hello how are you");
    expect(state.transcript[0].status).toBe("final");
  });

  test("transcript.done without text finalizes an open interim", () => {
    const state = freshState();
    apply(state, {
      type: "transcript.partial",
      text: "Hold on",
      is_final: false,
      speech_final: false,
    });
    apply(state, { type: "transcript.done", text: "" });

    expect(state.transcript).toHaveLength(1);
    expect(state.transcript[0].status).toBe("final");
    expect(state.callerInterimTurnId).toBeNull();
  });

  test("empty partials are ignored", () => {
    const state = freshState();
    const result = apply(state, {
      type: "transcript.partial",
      text: "  ",
      is_final: true,
      speech_final: true,
    });
    expect(result.changed).toBe(false);
    expect(state.transcript).toHaveLength(0);
  });
});

describe("transcript display helpers", () => {
  test("labels callers as the other person", () => {
    expect(displaySpeakerLabel("Caller")).toBe("Other person");
    expect(displaySpeakerLabel("Caller 1")).toBe("Other person");
    expect(displaySpeakerLabel("Caller 2")).toBe("Other person 2");
    expect(displaySpeakerLabel("Agent")).toBe("Agent");
    expect(displaySpeakerLabel("You")).toBe("You");
  });

  test("turn kind follows speaker", () => {
    expect(turnVisualKind("Agent")).toBe("agent");
    expect(turnVisualKind("Caller 1")).toBe("caller");
    expect(turnVisualKind("You")).toBe("you");
  });

  test("spoken text key ignores punctuation and case", () => {
    expect(spokenTextKey("OK.")).toBe(spokenTextKey("ok"));
  });

  test("collapseAdjacentDuplicateTurns hides repeated mic rows", () => {
    const collapsed = collapseAdjacentDuplicateTurns([
      { speaker: "Caller", text: "OK", status: "final" },
      { speaker: "Caller", text: "OK.", status: "final", translation: "OK" },
      { speaker: "Agent", text: "Claro", status: "final" },
    ]);
    expect(collapsed).toHaveLength(2);
    expect(collapsed[0].translation).toBe("OK");
    expect(collapsed[1].speaker).toBe("Agent");
  });

  test("preview prefers the longest cumulative chunk", () => {
    expect(
      composeCallerPreviewText({ 0: "Hello", 1: "Hello there" }, "Hello there"),
    ).toBe("Hello there");
    expect(composeCallerPreviewText({ 0: "Hello how", 3: "are you" }, "")).toBe(
      "Hello how are you",
    );
  });

  test("parseSttTranscriptEvent reads speaker from words when needed", () => {
    const parsed = parseSttTranscriptEvent({
      type: "transcript.partial",
      text: "Sí",
      is_final: true,
      speech_final: true,
      words: [{ speaker: 1, word: "Sí" }],
    });
    expect(parsed.speaker).toBe("Caller 2");
    expect(parsed.speechFinal).toBe(true);
  });
});
