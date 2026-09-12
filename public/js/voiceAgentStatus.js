/**
 * Pure voice-agent status phase mapping.
 * Shared by the main UI and unit tests (no DOM / no WebSocket).
 *
 * Maps realtime session events and tool lifecycle stages to human-readable
 * labels for the chat voice-status chrome and the agent-progress panel.
 */

export const VOICE_STATUS_PHASE = Object.freeze({
  CONNECTING: "connecting",
  LISTENING: "listening",
  HEARING: "hearing",
  THINKING: "thinking",
  WORKING: "working",
  RECEIVING: "receiving",
  SEARCHING: "searching",
  CALLING_AGENT: "calling_agent",
  SPEAKING: "speaking",
  ERROR: "error",
});

/** User-facing labels for the chat `.voice-status` line. */
export const VOICE_STATUS_LABELS = Object.freeze({
  [VOICE_STATUS_PHASE.CONNECTING]: "Connecting…",
  [VOICE_STATUS_PHASE.LISTENING]: "Listening",
  [VOICE_STATUS_PHASE.HEARING]: "Hearing you…",
  [VOICE_STATUS_PHASE.THINKING]: "Thinking…",
  [VOICE_STATUS_PHASE.WORKING]: "Working…",
  [VOICE_STATUS_PHASE.RECEIVING]: "Receiving…",
  [VOICE_STATUS_PHASE.SEARCHING]: "Searching…",
  [VOICE_STATUS_PHASE.CALLING_AGENT]: "Calling agent…",
  [VOICE_STATUS_PHASE.SPEAKING]: "Speaking…",
  [VOICE_STATUS_PHASE.ERROR]: "Voice error",
});

/**
 * Panel states accepted by normalizeAgentProgressState / publishAgentStatusEvent.
 * "completed" is used for idle listening so the run can settle as terminal.
 */
export const VOICE_STATUS_PANEL_STATE = Object.freeze({
  [VOICE_STATUS_PHASE.CONNECTING]: "working",
  [VOICE_STATUS_PHASE.LISTENING]: "completed",
  [VOICE_STATUS_PHASE.HEARING]: "working",
  [VOICE_STATUS_PHASE.THINKING]: "working",
  [VOICE_STATUS_PHASE.WORKING]: "working",
  [VOICE_STATUS_PHASE.RECEIVING]: "working",
  [VOICE_STATUS_PHASE.SEARCHING]: "working",
  [VOICE_STATUS_PHASE.CALLING_AGENT]: "working",
  [VOICE_STATUS_PHASE.SPEAKING]: "working",
  [VOICE_STATUS_PHASE.ERROR]: "failed",
});

/** Icons for agent-progress rows. */
export const VOICE_STATUS_ICONS = Object.freeze({
  [VOICE_STATUS_PHASE.CONNECTING]: "hourglass_top",
  [VOICE_STATUS_PHASE.LISTENING]: "mic",
  [VOICE_STATUS_PHASE.HEARING]: "hearing",
  [VOICE_STATUS_PHASE.THINKING]: "psychology",
  [VOICE_STATUS_PHASE.WORKING]: "progress_activity",
  [VOICE_STATUS_PHASE.RECEIVING]: "download",
  [VOICE_STATUS_PHASE.SEARCHING]: "search",
  [VOICE_STATUS_PHASE.CALLING_AGENT]: "smart_toy",
  [VOICE_STATUS_PHASE.SPEAKING]: "volume_up",
  [VOICE_STATUS_PHASE.ERROR]: "error",
});

/** High-volume inbound event types — do not flood UI or console. */
export const VOICE_HIGH_VOLUME_EVENT_TYPES = Object.freeze(
  new Set([
    "response.output_audio.delta",
    "response.output_audio_transcript.delta",
    "response.output_text.delta",
  ]),
);

export function isKnownVoiceStatusPhase(phase) {
  return Object.prototype.hasOwnProperty.call(
    VOICE_STATUS_LABELS,
    String(phase || ""),
  );
}

export function getVoiceStatusLabel(phase) {
  const key = String(phase || "").trim();
  return VOICE_STATUS_LABELS[key] || VOICE_STATUS_LABELS[VOICE_STATUS_PHASE.LISTENING];
}

export function getVoicePanelState(phase) {
  const key = String(phase || "").trim();
  return VOICE_STATUS_PANEL_STATE[key] || "idle";
}

export function getVoiceStatusIcon(phase) {
  const key = String(phase || "").trim();
  return VOICE_STATUS_ICONS[key] || "record_voice_over";
}

export function isHighVolumeVoiceEvent(eventType) {
  return VOICE_HIGH_VOLUME_EVENT_TYPES.has(String(eventType || "").trim());
}

/**
 * Build a normalized status update object.
 * @param {string} phase
 * @param {object} [options]
 */
export function buildVoiceStatusUpdate(phase, options = {}) {
  const resolvedPhase = isKnownVoiceStatusPhase(phase)
    ? phase
    : VOICE_STATUS_PHASE.LISTENING;
  return {
    phase: resolvedPhase,
    label: options.label || getVoiceStatusLabel(resolvedPhase),
    panelState: options.panelState || getVoicePanelState(resolvedPhase),
    icon: options.icon || getVoiceStatusIcon(resolvedPhase),
    detail: options.detail != null ? String(options.detail) : "",
    shouldUpdateUi: options.shouldUpdateUi !== false,
    shouldPublishPanel: options.shouldPublishPanel !== false,
    shouldLog: options.shouldLog !== false,
    logSummary: options.logSummary || options.detail || resolvedPhase,
  };
}

/**
 * Map a server WebSocket event type (+ light context) to a status update.
 *
 * @param {string} eventType - e.g. "input_audio_buffer.speech_stopped"
 * @param {object} [context]
 * @param {boolean} [context.hasPendingTools]
 * @param {string} [context.previousPhase]
 * @param {string} [context.toolName]
 * @param {boolean} [context.isMutationTool]
 * @param {boolean} [context.isReadTool]
 * @param {string} [context.transcript]
 * @param {string} [context.errorMessage]
 * @returns {object} voice status update
 */
export function mapVoiceWebSocketEventToStatus(eventType, context = {}) {
  const type = String(eventType || "").trim();
  const hasPendingTools = Boolean(context.hasPendingTools);
  const previousPhase =
    context.previousPhase && isKnownVoiceStatusPhase(context.previousPhase)
      ? context.previousPhase
      : VOICE_STATUS_PHASE.LISTENING;

  switch (type) {
    case "session.created":
    case "session.updated":
    case "conversation.created":
      // Stay listening once session is up; only force UI if we were connecting.
      return buildVoiceStatusUpdate(VOICE_STATUS_PHASE.LISTENING, {
        detail: type,
        shouldUpdateUi:
          previousPhase === VOICE_STATUS_PHASE.CONNECTING ||
          previousPhase === VOICE_STATUS_PHASE.LISTENING,
        shouldPublishPanel: previousPhase === VOICE_STATUS_PHASE.CONNECTING,
      });

    case "input_audio_buffer.speech_started":
      return buildVoiceStatusUpdate(VOICE_STATUS_PHASE.HEARING, {
        detail: "User speech detected",
      });

    case "input_audio_buffer.speech_stopped":
      // Critical latency window: speech ended, model has not responded yet.
      return buildVoiceStatusUpdate(VOICE_STATUS_PHASE.THINKING, {
        detail: "Speech ended — processing",
      });

    case "conversation.item.input_audio_transcription.completed": {
      const transcript = String(context.transcript || "").trim();
      return buildVoiceStatusUpdate(VOICE_STATUS_PHASE.THINKING, {
        detail: transcript
          ? `Heard: ${transcript.slice(0, 120)}${transcript.length > 120 ? "…" : ""}`
          : "Transcript ready",
      });
    }

    case "response.created":
    case "response.output_item.added":
      if (hasPendingTools) {
        return buildVoiceStatusUpdate(previousPhase, {
          detail: "Response in progress (tool running)",
          shouldUpdateUi: false,
          shouldPublishPanel: false,
        });
      }
      return buildVoiceStatusUpdate(VOICE_STATUS_PHASE.THINKING, {
        detail: "Response started",
      });

    case "response.function_call_arguments.done": {
      const toolName = String(context.toolName || "").trim();
      if (context.isMutationTool) {
        return buildVoiceStatusUpdate(VOICE_STATUS_PHASE.CALLING_AGENT, {
          detail: toolName || "run_agent_request",
        });
      }
      if (context.isReadTool || toolName) {
        return buildVoiceStatusUpdate(VOICE_STATUS_PHASE.SEARCHING, {
          detail: toolName ? `Looking up via ${toolName}` : "Looking that up",
        });
      }
      return buildVoiceStatusUpdate(VOICE_STATUS_PHASE.WORKING, {
        detail: toolName || "Function call",
      });
    }

    case "response.output_audio.delta":
    case "response.output_audio_transcript.delta":
    case "response.output_text.delta": {
      // High-volume: only transition UI once into receiving/speaking.
      if (hasPendingTools) {
        return buildVoiceStatusUpdate(previousPhase, {
          detail: "",
          shouldUpdateUi: false,
          shouldPublishPanel: false,
          shouldLog: false,
        });
      }
      if (
        previousPhase === VOICE_STATUS_PHASE.RECEIVING ||
        previousPhase === VOICE_STATUS_PHASE.SPEAKING
      ) {
        return buildVoiceStatusUpdate(previousPhase, {
          detail: "",
          shouldUpdateUi: false,
          shouldPublishPanel: false,
          shouldLog: false,
        });
      }
      const nextPhase =
        type === "response.output_audio.delta"
          ? VOICE_STATUS_PHASE.SPEAKING
          : VOICE_STATUS_PHASE.RECEIVING;
      return buildVoiceStatusUpdate(nextPhase, {
        detail: "Streaming response",
        // First transition may log at apply layer; suppress per-delta noise.
        shouldLog: false,
      });
    }

    case "response.output_audio.done":
    case "response.output_audio_transcript.done":
      if (hasPendingTools) {
        return buildVoiceStatusUpdate(previousPhase, {
          detail: "Audio/transcript done (tool running)",
          shouldUpdateUi: false,
          shouldPublishPanel: false,
        });
      }
      return buildVoiceStatusUpdate(VOICE_STATUS_PHASE.RECEIVING, {
        detail: "Finishing response",
      });

    case "response.done":
      if (hasPendingTools) {
        return buildVoiceStatusUpdate(previousPhase, {
          detail: "Response done; tool still running",
          shouldUpdateUi: false,
          shouldPublishPanel: false,
        });
      }
      return buildVoiceStatusUpdate(VOICE_STATUS_PHASE.LISTENING, {
        detail: "Ready for next request",
      });

    case "error":
      return buildVoiceStatusUpdate(VOICE_STATUS_PHASE.ERROR, {
        detail: context.errorMessage || "Error from voice session",
      });

    default:
      return buildVoiceStatusUpdate(previousPhase, {
        detail: type || "unknown",
        shouldUpdateUi: false,
        shouldPublishPanel: false,
        shouldLog: Boolean(type),
        logSummary: type || "unknown",
      });
  }
}

/**
 * Map tool dispatch lifecycle (read vs mutation) to status.
 *
 * @param {object} options
 * @param {"read"|"mutation"|string} [options.kind]
 * @param {"start"|"end"|"error"} [options.stage]
 * @param {string} [options.toolName]
 * @param {string} [options.errorMessage]
 */
export function mapVoiceToolLifecycleToStatus({
  kind = "read",
  stage = "start",
  toolName = "",
  errorMessage = "",
} = {}) {
  const name = String(toolName || "").trim();
  const toolKind = String(kind || "read").toLowerCase();
  const toolStage = String(stage || "start").toLowerCase();

  if (toolStage === "error") {
    return buildVoiceStatusUpdate(VOICE_STATUS_PHASE.ERROR, {
      detail:
        errorMessage ||
        (name ? `Tool failed: ${name}` : "Voice tool failed"),
    });
  }

  if (toolStage === "end") {
    return buildVoiceStatusUpdate(VOICE_STATUS_PHASE.LISTENING, {
      detail: name ? `Finished ${name}` : "Tool finished",
    });
  }

  // start
  if (toolKind === "mutation") {
    return buildVoiceStatusUpdate(VOICE_STATUS_PHASE.CALLING_AGENT, {
      detail: name ? `Calling agent (${name})` : "Calling project agent",
    });
  }

  return buildVoiceStatusUpdate(VOICE_STATUS_PHASE.SEARCHING, {
    detail: name ? `Searching via ${name}` : "Searching project data",
  });
}

/**
 * Compact payload summary for console logging (skip raw audio bodies).
 * @param {object} data - parsed WS JSON
 */
export function summarizeVoiceWebSocketEvent(data = {}) {
  const type = String(data?.type || "unknown").trim() || "unknown";
  if (isHighVolumeVoiceEvent(type)) {
    return { type, summary: type, highVolume: true };
  }

  const parts = [type];
  if (data?.name) parts.push(`name=${data.name}`);
  if (data?.call_id || data?.callId) {
    parts.push(`call_id=${data.call_id || data.callId}`);
  }
  if (data?.transcript != null && String(data.transcript).length) {
    const t = String(data.transcript);
    parts.push(
      `transcript="${t.slice(0, 80)}${t.length > 80 ? "…" : ""}"`,
    );
  }
  if (data?.arguments != null) {
    const args =
      typeof data.arguments === "string"
        ? data.arguments
        : JSON.stringify(data.arguments);
    parts.push(
      `args=${String(args).slice(0, 100)}${String(args).length > 100 ? "…" : ""}`,
    );
  }
  if (data?.error != null || data?.message != null) {
    const errText =
      (typeof data.error === "object" && data.error?.message) ||
      data.message ||
      data.error;
    if (errText) parts.push(`error=${String(errText).slice(0, 120)}`);
  }
  if (data?.item?.type) parts.push(`item.type=${data.item.type}`);
  if (data?.response?.id) parts.push(`response.id=${data.response.id}`);

  return { type, summary: parts.join(" "), highVolume: false };
}

/**
 * Stable run key for the agent-progress panel during a voice session.
 */
export function getVoiceSessionRunKey() {
  return "voice:session";
}
