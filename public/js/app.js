import { getAuthToken, ensureValidSession, clearAuthState } from "./auth.js";
import { applyTheme } from "./theme.js";
import {
  cancelSubscription,
  openBillingPortal,
  reactivateSubscription,
  startProCheckout,
} from "./billing.js";
import { formatCallTime } from "./creditCalculator.js";
import { CallAgent, formatDuration, DEFAULT_PROMPT } from "./callAgent.js";
import {
  collapseAdjacentDuplicateTurns,
  displaySpeakerLabel,
  turnVisualKind,
} from "./sttTranscript.js";
import WaveSurfer from "./vendor/wavesurfer.esm.js";
import RecordPlugin from "./vendor/wavesurfer.record.esm.js";
import { t, setLocale, getLocale, initI18n, applyTranslations, onLocaleChange, readStoredLocale, hasStoredLocale, normalizeLanguageCode } from "./i18n.js";

const apiBase = () => String(AppConfig?.apiBaseUrl || "").replace(/\/+$/, "");

function token() {
  return getAuthToken();
}

async function api(path, options = {}) {
  const headers = new Headers(options.headers || {});
  if (!headers.has("Content-Type") && options.body && !(options.body instanceof FormData)) {
    headers.set("Content-Type", "application/json");
  }
  if (token()) headers.set("x-auth-token", token());
  const response = await fetch(`${apiBase()}${path}`, {
    credentials: "include",
    ...options,
    headers,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const err = new Error(data.error || data.message || t("toast.requestFailed"));
    err.status = response.status;
    err.data = data;
    throw err;
  }
  return data;
}

function toast(message, kind = "info") {
  const el = document.getElementById("toast");
  if (!el) return;
  el.hidden = false;
  el.className = `toast${kind === "error" ? " error" : ""}`;
  el.textContent = message;
  window.clearTimeout(toast._t);
  toast._t = window.setTimeout(() => {
    el.hidden = true;
  }, 4200);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const BRIEF_PANE_WIDTH_KEY = "cat-brief-pane-width";
const BRIEF_PANE_DEFAULT = 380;
const BRIEF_PANE_MIN = 260;
const BRIEF_PANE_MAX = 720;
const BRAND_SELECT_CHEVRON = `<svg class="brand-select-chevron" viewBox="0 0 12 8" aria-hidden="true"><path d="M1.2 1.5 L6 6.2 L10.8 1.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

function getBrandSelectPanel(root) {
  const uid = root.getAttribute("data-brand-select");
  return (
    root.querySelector(".brand-select-panel") ||
    document.querySelector(`[data-brand-select-panel="${uid}"]`)
  );
}

function closeBrandSelects(except) {
  document.querySelectorAll("[data-brand-select]").forEach((root) => {
    if (except && root === except) return;
    const trigger = root.querySelector(".brand-select-trigger");
    const panel = getBrandSelectPanel(root);
    if (trigger) trigger.setAttribute("aria-expanded", "false");
    if (panel) {
      panel.hidden = true;
      if (panel.parentElement !== root) root.appendChild(panel);
    }
  });
}

function placeBrandSelectPanel(root) {
  const trigger = root.querySelector(".brand-select-trigger");
  const panel = getBrandSelectPanel(root);
  if (!trigger || !panel || panel.hidden) return;
  const rect = trigger.getBoundingClientRect();
  const minWidth = Math.max(rect.width, 220);
  const left = Math.min(Math.max(8, rect.left), window.innerWidth - minWidth - 8);
  panel.style.width = `${rect.width}px`;
  panel.style.minWidth = `${minWidth}px`;
  panel.style.left = `${left}px`;
  panel.style.right = "auto";
  const spaceBelow = window.innerHeight - rect.bottom - 12;
  const spaceAbove = rect.top - 12;
  if (spaceBelow >= 180 || spaceBelow >= spaceAbove) {
    panel.style.top = `${rect.bottom + 6}px`;
    panel.style.bottom = "auto";
    panel.style.maxHeight = `${Math.max(120, spaceBelow)}px`;
  } else {
    panel.style.bottom = `${window.innerHeight - rect.top + 6}px`;
    panel.style.top = "auto";
    panel.style.maxHeight = `${Math.max(120, spaceAbove)}px`;
  }
}

function brandSelectMarkup({ id, label, value, items, emptyText }) {
  const selected = items.find((item) => String(item.value) === String(value));
  const triggerText = selected?.label || label;
  const optionHtml = items.length
    ? items
        .map((item) => {
          const isSelected = String(item.value) === String(value);
          return `<button type="button" role="option" data-value="${escapeHtml(item.value)}" aria-selected="${
            isSelected ? "true" : "false"
          }">${escapeHtml(item.label)}</button>`;
        })
        .join("")
    : `<p class="brand-select-empty">${escapeHtml(emptyText || t("brandSelect.nothing"))}</p>`;
  const nativeOptions = [
    `<option value="">${escapeHtml(label)}</option>`,
    ...items.map(
      (item) =>
        `<option value="${escapeHtml(item.value)}"${
          String(item.value) === String(value) ? " selected" : ""
        }>${escapeHtml(item.label)}</option>`,
    ),
  ].join("");
  const uid = `brand-select-${id}`;
  return `
    <div class="brand-select" data-brand-select="${escapeHtml(uid)}">
      <button type="button" class="brand-select-trigger" aria-haspopup="listbox" aria-expanded="false" aria-label="${escapeHtml(
        label,
      )}" data-empty="${selected ? "false" : "true"}" title="${escapeHtml(triggerText)}">
        <span class="brand-select-label">${escapeHtml(triggerText)}</span>
        ${BRAND_SELECT_CHEVRON}
      </button>
      <div class="brand-select-panel" data-brand-select-panel="${escapeHtml(
        uid,
      )}" role="listbox" aria-label="${escapeHtml(label)}" hidden>
        ${optionHtml}
      </div>
      <select id="${escapeHtml(id)}" class="brand-select-native" tabindex="-1" aria-hidden="true">${nativeOptions}</select>
    </div>
  `;
}

function bindBrandSelect(root, { onChange } = {}) {
  const trigger = root.querySelector(".brand-select-trigger");
  const panel = getBrandSelectPanel(root);
  const native = root.querySelector("select");
  if (!trigger || !panel) return;

  const options = () => [...panel.querySelectorAll("[data-value]")];

  const open = ({ keyboard = false } = {}) => {
    closeBrandSelects();
    document.body.appendChild(panel);
    panel.hidden = false;
    trigger.setAttribute("aria-expanded", "true");
    placeBrandSelectPanel(root);
    if (keyboard) {
      (panel.querySelector('[aria-selected="true"]') || options()[0])?.focus({
        preventScroll: true,
      });
    }
  };

  const choose = (value) => {
    if (native) native.value = value;
    const option = options().find((btn) => (btn.getAttribute("data-value") || "") === value);
    const fallback = trigger.getAttribute("aria-label") || "";
    const text = option?.textContent?.trim() || fallback;
    const labelEl = trigger.querySelector(".brand-select-label");
    if (labelEl) labelEl.textContent = text;
    trigger.dataset.empty = value ? "false" : "true";
    trigger.title = text;
    options().forEach((btn) => {
      btn.setAttribute(
        "aria-selected",
        (btn.getAttribute("data-value") || "") === value ? "true" : "false",
      );
    });
    onChange?.(value);
    closeBrandSelects();
    trigger.focus({ preventScroll: true });
  };

  trigger.addEventListener("click", (event) => {
    event.preventDefault();
    if (panel.hidden) open();
    else closeBrandSelects();
  });
  trigger.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (panel.hidden) open({ keyboard: true });
    }
  });
  panel.addEventListener("click", (event) => {
    const option = event.target.closest("[data-value]");
    if (!option) return;
    choose(option.getAttribute("data-value") || "");
  });
  panel.addEventListener("keydown", (event) => {
    const items = options();
    const index = items.indexOf(document.activeElement);
    if (event.key === "ArrowDown") {
      event.preventDefault();
      (items[index + 1] || items[0])?.focus({ preventScroll: true });
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      (items[index - 1] || items[items.length - 1])?.focus({ preventScroll: true });
    } else if (event.key === "Home") {
      event.preventDefault();
      items[0]?.focus({ preventScroll: true });
    } else if (event.key === "End") {
      event.preventDefault();
      items[items.length - 1]?.focus({ preventScroll: true });
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (document.activeElement?.hasAttribute("data-value")) {
        choose(document.activeElement.getAttribute("data-value") || "");
      }
    }
  });
}

function initBrandSelects() {
  if (initBrandSelects.bound) return;
  initBrandSelects.bound = true;
  document.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (
      !target?.closest("[data-brand-select]") &&
      !target?.closest("[data-brand-select-panel]")
    ) {
      closeBrandSelects();
    }
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeBrandSelects();
  });
  window.addEventListener("resize", () => {
    document.querySelectorAll("[data-brand-select]").forEach((root) => {
      placeBrandSelectPanel(root);
    });
  });
}

function readBriefPaneWidth() {
  try {
    const parsed = Number.parseInt(localStorage.getItem(BRIEF_PANE_WIDTH_KEY) || "", 10);
    if (Number.isFinite(parsed)) return parsed;
  } catch {
    // ignore
  }
  return BRIEF_PANE_DEFAULT;
}

function clampBriefPaneWidth(width, container) {
  const maxFromContainer = container
    ? Math.max(BRIEF_PANE_MIN, Math.round(container.clientWidth - 12 - 320))
    : BRIEF_PANE_MAX;
  return Math.min(
    BRIEF_PANE_MAX,
    maxFromContainer,
    Math.max(BRIEF_PANE_MIN, Math.round(Number(width) || BRIEF_PANE_DEFAULT)),
  );
}

function applyBriefPaneWidth(width) {
  const main = document.querySelector(".app-main");
  const resizer = document.getElementById("paneResizer");
  if (!main) return BRIEF_PANE_DEFAULT;
  const clamped = clampBriefPaneWidth(width, main);
  main.style.setProperty("--brief-pane-width", `${clamped}px`);
  if (resizer) {
    resizer.setAttribute("aria-valuenow", String(clamped));
    resizer.setAttribute("aria-valuetext", `${clamped} pixels`);
  }
  return clamped;
}

function persistBriefPaneWidth(width) {
  try {
    localStorage.setItem(BRIEF_PANE_WIDTH_KEY, String(width));
  } catch {
    // ignore
  }
}

function desktopPanes() {
  return window.matchMedia("(min-width: 901px)").matches;
}

function initPaneResize() {
  const main = document.querySelector(".app-main");
  const resizer = document.getElementById("paneResizer");
  if (!main || !resizer || initPaneResize.bound) return;
  initPaneResize.bound = true;
  applyBriefPaneWidth(readBriefPaneWidth());

  let dragging = false;
  let startX = 0;
  let startWidth = BRIEF_PANE_DEFAULT;

  const stopDrag = () => {
    if (!dragging) return;
    dragging = false;
    document.body.classList.remove("is-resizing-panes");
    persistBriefPaneWidth(
      Number.parseInt(getComputedStyle(main).getPropertyValue("--brief-pane-width"), 10) ||
        BRIEF_PANE_DEFAULT,
    );
  };

  resizer.addEventListener("pointerdown", (event) => {
    if (!desktopPanes()) return;
    event.preventDefault();
    dragging = true;
    startX = event.clientX;
    startWidth =
      Number.parseInt(getComputedStyle(main).getPropertyValue("--brief-pane-width"), 10) ||
      BRIEF_PANE_DEFAULT;
    document.body.classList.add("is-resizing-panes");
    resizer.setPointerCapture(event.pointerId);
  });
  resizer.addEventListener("pointermove", (event) => {
    if (!dragging) return;
    applyBriefPaneWidth(startWidth + (event.clientX - startX));
  });
  resizer.addEventListener("pointerup", stopDrag);
  resizer.addEventListener("pointercancel", stopDrag);
  resizer.addEventListener("lostpointercapture", stopDrag);
  resizer.addEventListener("dblclick", () => {
    persistBriefPaneWidth(applyBriefPaneWidth(BRIEF_PANE_DEFAULT));
  });
  resizer.addEventListener("keydown", (event) => {
    if (!desktopPanes()) return;
    const current =
      Number.parseInt(getComputedStyle(main).getPropertyValue("--brief-pane-width"), 10) ||
      BRIEF_PANE_DEFAULT;
    const step = event.shiftKey ? 48 : 16;
    let next = null;
    if (event.key === "ArrowLeft") next = current - step;
    else if (event.key === "ArrowRight") next = current + step;
    else if (event.key === "Home") next = BRIEF_PANE_MIN;
    else if (event.key === "End") next = BRIEF_PANE_MAX;
    if (next == null) return;
    event.preventDefault();
    persistBriefPaneWidth(applyBriefPaneWidth(next));
  });
  window.addEventListener("resize", () => {
    if (!desktopPanes()) return;
    applyBriefPaneWidth(
      Number.parseInt(getComputedStyle(main).getPropertyValue("--brief-pane-width"), 10) ||
        readBriefPaneWidth(),
    );
  });
}

const els = {
  creditPill: document.getElementById("creditPill"),
  planLabel: document.getElementById("planLabel"),
  creditBalance: document.getElementById("creditBalance"),
  adminLink: document.getElementById("adminLink"),
  settingsBtn: document.getElementById("settingsBtn"),
  logoutBtn: document.getElementById("logoutBtn"),
  yourName: document.getElementById("yourName"),
  yourLanguage: document.getElementById("yourLanguage"),
  theirLanguage: document.getElementById("theirLanguage"),
  voiceSelect: document.getElementById("voiceSelect"),
  previewVoice: document.getElementById("previewVoice"),
  goal: document.getElementById("goal"),
  rules: document.getElementById("rules"),
  information: document.getElementById("information"),
  fillNotes: document.getElementById("fillNotes"),
  fillNotesWrap: document.getElementById("fillNotesWrap"),
  fillNotesWorking: document.getElementById("fillNotesWorking"),
  dictateBtn: document.getElementById("dictateBtn"),
  dictateIdle: document.getElementById("dictateIdle"),
  dictateLive: document.getElementById("dictateLive"),
  dictateWave: document.getElementById("dictateWave"),
  dictateTimer: document.getElementById("dictateTimer"),
  dictateWorking: document.getElementById("dictateWorking"),
  fillBriefBtn: document.getElementById("fillBriefBtn"),
  fillIdle: document.getElementById("fillIdle"),
  fillWorking: document.getElementById("fillWorking"),
  dictateStatus: document.getElementById("dictateStatus"),
  followUpModal: document.getElementById("followUpModal"),
  followUpKicker: document.getElementById("followUpKicker"),
  followUpTitle: document.getElementById("followUpTitle"),
  followUpCalling: document.getElementById("followUpCalling"),
  followUpLead: document.getElementById("followUpLead"),
  followUpQuestions: document.getElementById("followUpQuestions"),
  followUpSpoken: document.getElementById("followUpSpoken"),
  followUpSpokenWrap: document.getElementById("followUpSpokenWrap"),
  followUpSpokenWorking: document.getElementById("followUpSpokenWorking"),
  followUpDictateBtn: document.getElementById("followUpDictateBtn"),
  followUpDictateIdle: document.getElementById("followUpDictateIdle"),
  followUpDictateLive: document.getElementById("followUpDictateLive"),
  followUpDictateWave: document.getElementById("followUpDictateWave"),
  followUpDictateTimer: document.getElementById("followUpDictateTimer"),
  followUpDictateWorking: document.getElementById("followUpDictateWorking"),
  followUpSkipBtn: document.getElementById("followUpSkipBtn"),
  followUpApplyBtn: document.getElementById("followUpApplyBtn"),
  followUpApplyIdle: document.getElementById("followUpApplyIdle"),
  followUpApplyWorking: document.getElementById("followUpApplyWorking"),
  followUpStatus: document.getElementById("followUpStatus"),
  discloseAi: document.getElementById("discloseAi"),
  prompt: document.getElementById("prompt"),
  templateToolbar: document.getElementById("templateToolbar"),
  sessionToolbar: document.getElementById("sessionToolbar"),
  statusDot: document.getElementById("statusDot"),
  statusLabel: document.getElementById("statusLabel"),
  durationLabel: document.getElementById("durationLabel"),
  checkMicBtn: document.getElementById("checkMicBtn"),
  livePane: document.getElementById("livePane"),
  startBtn: document.getElementById("startBtn"),
  stopBtn: document.getElementById("stopBtn"),
  pauseBtn: document.getElementById("pauseBtn"),
  endCallModal: document.getElementById("endCallModal"),
  localeModal: document.getElementById("localeModal"),
  localeCopy: document.getElementById("localeCopy"),
  localeChangeBtn: document.getElementById("localeChangeBtn"),
  localeKeepBtn: document.getElementById("localeKeepBtn"),
  continueCallBtn: document.getElementById("continueCallBtn"),
  confirmEndCallBtn: document.getElementById("confirmEndCallBtn"),
  transcript: document.getElementById("transcript"),
  summarizeBtn: document.getElementById("summarizeBtn"),
  summaryBody: document.getElementById("summaryBody"),
  settingsModal: document.getElementById("settingsModal"),
  closeSettings: document.getElementById("closeSettings"),
  settingsBalance: document.getElementById("settingsBalance"),
  creditLots: document.getElementById("creditLots"),
  usageTableWrap: document.getElementById("usageTableWrap"),
  planCopy: document.getElementById("planCopy"),
  upgradeBtn: document.getElementById("upgradeBtn"),
  portalBtn: document.getElementById("portalBtn"),
  cancelBtn: document.getElementById("cancelBtn"),
  reactivateBtn: document.getElementById("reactivateBtn"),
  planStatus: document.getElementById("planStatus"),
  accountName: document.getElementById("accountName"),
  nameForm: document.getElementById("nameForm"),
  passwordForm: document.getElementById("passwordForm"),
  deleteAccountBtn: document.getElementById("deleteAccountBtn"),
};

let profile = null;
let billing = null;
let languages = [];
let templates = [];
let sessions = [];
let selectedTemplateId = "";
let selectedSessionId = "";
let durationTimer = null;
let fillInFlight = false;
let transcribeInFlight = false;
let followUpApplyInFlight = false;
let activeDictateSurface = "brief";
let followUpCalling = "";
let followUpLastFocus = null;
let dictateRecorder = null;
let dictateChunks = [];
let dictateStream = null;
let dictateStartedAt = 0;
let dictateBlob = null;
let dictateMimeType = "";
let dictateDurationSec = 0;
let dictateWave = null;
let dictateRecord = null;
let dictateTimerInterval = null;
let justFilledTimer = null;

const agent = new CallAgent({
  getToken: token,
  onChange: renderLive,
  onToast: toast,
});

function syncFieldsFromDom() {
  agent.state.goal = els.goal.value;
  agent.state.rules = els.rules.value;
  agent.state.information = els.information.value;
  agent.state.prompt = els.prompt.value || DEFAULT_PROMPT;
  agent.state.yourName = String(els.yourName?.value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  agent.state.yourLanguage = els.yourLanguage.value;
  agent.state.theirLanguage = els.theirLanguage.value;
  agent.state.discloseAi = els.discloseAi.checked;
  agent.state.selectedVoiceId = els.voiceSelect.value;
}

function fillLanguages() {
  const options = languages
    .map(
      (lang) =>
        `<option value="${escapeHtml(lang.code)}">${escapeHtml(lang.name)}</option>`,
    )
    .join("");
  els.yourLanguage.innerHTML = options;
  els.theirLanguage.innerHTML = options;
  els.yourLanguage.value = agent.state.yourLanguage;
  els.theirLanguage.value = agent.state.theirLanguage;
}

function fillVoices() {
  els.voiceSelect.innerHTML = agent.state.voices
    .map((voice) => {
      const id = voice.voice_id || voice.id;
      const label = voice.name || id;
      return `<option value="${escapeHtml(id)}">${escapeHtml(label)}</option>`;
    })
    .join("");
  els.voiceSelect.value = agent.selectedVoiceId();
}

function renderTemplates() {
  closeBrandSelects();
  const items = templates.map((row) => ({
    value: String(row.templateId || row._id),
    label: row.name || t("templates.untitled"),
  }));
  els.templateToolbar.innerHTML = `
    ${brandSelectMarkup({
      id: "templateSelect",
      label: t("templates.label"),
      value: selectedTemplateId,
      items,
      emptyText: t("templates.empty"),
    })}
    <button type="button" class="btn btn-small" data-tpl="load">${t("btn.load")}</button>
    <button type="button" class="btn btn-small" data-tpl="save">${t("btn.save")}</button>
    <button type="button" class="btn btn-small" data-tpl="saveas">${t("btn.saveAs")}</button>
    <button type="button" class="btn btn-small" data-tpl="delete">${t("btn.delete")}</button>
  `;
  const root = els.templateToolbar.querySelector("[data-brand-select]");
  if (root) {
    bindBrandSelect(root, {
      onChange: (value) => {
        selectedTemplateId = value;
      },
    });
  }
  els.templateToolbar.querySelectorAll("[data-tpl]").forEach((button) => {
    button.addEventListener("click", () => onTemplateAction(button.dataset.tpl));
  });
}

function renderSessions() {
  closeBrandSelects();
  const items = sessions.map((row) => ({
    value: String(row.sessionId || row._id),
    label: row.name || t("sessions.untitled"),
  }));
  els.sessionToolbar.innerHTML = `
    ${brandSelectMarkup({
      id: "sessionSelect",
      label: t("sessions.label"),
      value: selectedSessionId,
      items,
      emptyText: t("sessions.empty"),
    })}
    <button type="button" class="btn btn-small" data-sess="open">${t("btn.open")}</button>
    <button type="button" class="btn btn-small" data-sess="save">${t("btn.saveSession")}</button>
  `;
  const root = els.sessionToolbar.querySelector("[data-brand-select]");
  if (root) {
    bindBrandSelect(root, {
      onChange: (value) => {
        selectedSessionId = value;
      },
    });
  }
  els.sessionToolbar.querySelectorAll("[data-sess]").forEach((button) => {
    button.addEventListener("click", () => onSessionAction(button.dataset.sess));
  });
}

async function onTemplateAction(action) {
  syncFieldsFromDom();
  try {
    if (action === "load") {
      if (!selectedTemplateId) return;
      const data = await api(`/api/call-agent/templates/${selectedTemplateId}`);
      agent.applyFields(data.template.fields);
      writeFieldsToDom();
      toast(`Loaded ${data.template.name}`);
    } else if (action === "save" || action === "saveas") {
      let name = templates.find(
        (row) => String(row.templateId || row._id) === String(selectedTemplateId),
      )?.name;
      if (action === "saveas" || !selectedTemplateId) {
        name = window.prompt(t("prompt.templateName"), name || t("prompt.templateNameDefault"));
        if (!name) return;
      }
      const body = JSON.stringify({ name, fields: agent.fields() });
      const data =
        selectedTemplateId && action === "save"
          ? await api(`/api/call-agent/templates/${selectedTemplateId}`, {
              method: "PATCH",
              body,
            })
          : await api("/api/call-agent/templates", { method: "POST", body });
      selectedTemplateId = data.template.templateId;
      await loadTemplates();
      toast(`Saved ${data.template.name}`);
    } else if (action === "delete") {
      if (!selectedTemplateId) return;
      if (!window.confirm(t("confirm.deleteTemplate"))) return;
      await api(`/api/call-agent/templates/${selectedTemplateId}`, { method: "DELETE" });
      selectedTemplateId = "";
      await loadTemplates();
    }
  } catch (error) {
    toast(error.message, "error");
  }
}

async function onSessionAction(action) {
  const select = document.getElementById("sessionSelect");
  try {
    if (action === "open") {
      const id = select?.value || selectedSessionId;
      if (!id) return;
      selectedSessionId = id;
      const data = await api(`/api/call-agent/sessions/${id}`);
      agent.applyFields(data.session.fields);
      agent.state.transcript = data.session.transcript || [];
      agent.state.summaryReport = data.session.summaryReport;
      agent.state.currentSessionId = data.session.sessionId;
      agent.state.selectedVoiceId = data.session.selectedVoiceId || agent.state.selectedVoiceId;
      writeFieldsToDom();
      renderLive(agent.state);
      toast(`Opened ${data.session.name}`);
    } else if (action === "save") {
      syncFieldsFromDom();
      await agent.saveSession();
      await loadSessions();
      toast(t("toast.sessionSaved"));
    }
  } catch (error) {
    toast(error.message, "error");
  }
}

function writeFieldsToDom() {
  els.goal.value = agent.state.goal;
  els.rules.value = agent.state.rules;
  els.information.value = agent.state.information;
  els.prompt.value = agent.state.prompt || DEFAULT_PROMPT;
  if (els.yourName) els.yourName.value = agent.state.yourName || "";
  els.yourLanguage.value = agent.state.yourLanguage;
  els.theirLanguage.value = agent.state.theirLanguage;
  els.discloseAi.checked = agent.state.discloseAi !== false;
  els.voiceSelect.value = agent.selectedVoiceId();
}

function languageName(code) {
  const key = String(code || "").trim().toLowerCase();
  return languages.find((row) => row.code === key)?.name || key;
}

function isFollowUpOpen() {
  return Boolean(els.followUpModal && !els.followUpModal.hidden);
}

function setDictateStatus(text) {
  if (els.dictateStatus) els.dictateStatus.textContent = text || "";
}

function setFollowUpStatus(text) {
  if (els.followUpStatus) els.followUpStatus.textContent = text || "";
}

function getDictateSurface() {
  if (activeDictateSurface === "followup") {
    return {
      name: "followup",
      btn: els.followUpDictateBtn,
      idle: els.followUpDictateIdle,
      live: els.followUpDictateLive,
      wave: els.followUpDictateWave,
      timer: els.followUpDictateTimer,
      working: els.followUpDictateWorking,
      notes: els.followUpSpoken,
      notesWrap: els.followUpSpokenWrap,
      notesWorking: els.followUpSpokenWorking,
      applyTranscript: applyTranscriptToFollowUp,
      setStatus: setFollowUpStatus,
      transcribedStatus: (used) =>
        used
          ? t("dictate.followUpTranscribedWithUsed", { used })
          : "Review the text, then add it to the brief.",
      transcribeErrorStatus:
        t("dictate.followUpTranscribeError"),
      awaitingBtn: null,
    };
  }
  return {
    name: "brief",
    btn: els.dictateBtn,
    idle: els.dictateIdle,
    live: els.dictateLive,
    wave: els.dictateWave,
    timer: els.dictateTimer,
    working: els.dictateWorking,
    notes: els.fillNotes,
    notesWrap: els.fillNotesWrap,
    notesWorking: els.fillNotesWorking,
    applyTranscript: applyTranscriptToNotes,
    setStatus: setDictateStatus,
    transcribedStatus: (used) =>
      used
        ? t("dictate.transcribedWithUsed", { used })
        : "Review the text, then fill the brief.",
    transcribeErrorStatus:
      t("dictate.transcribeError"),
    awaitingBtn: els.fillBriefBtn,
  };
}

function pickRecorderMime() {
  const types = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/mp4",
    "audio/ogg;codecs=opus",
  ];
  if (!window.MediaRecorder?.isTypeSupported) return "";
  return types.find((type) => MediaRecorder.isTypeSupported(type)) || "";
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || "");
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(new Error(t("call.readRecordingFailed")));
    reader.readAsDataURL(blob);
  });
}

function nextFrame() {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  });
}

function isDictating() {
  return Boolean(
    dictateRecord?.isRecording?.() || dictateRecorder?.state === "recording",
  );
}

function stopDictateStream() {
  if (dictateStream) {
    for (const track of dictateStream.getTracks()) track.stop();
  }
  dictateStream = null;
}

function stopDictateTimer() {
  if (dictateTimerInterval) {
    window.clearInterval(dictateTimerInterval);
    dictateTimerInterval = null;
  }
}

function startDictateTimer() {
  const ui = getDictateSurface();
  stopDictateTimer();
  if (ui.timer) ui.timer.textContent = "0:00";
  dictateTimerInterval = window.setInterval(() => {
    const live = getDictateSurface();
    if (live.timer) {
      live.timer.textContent = formatDuration(Date.now() - dictateStartedAt);
    }
  }, 200);
}

function destroyDictateWave() {
  const ui = getDictateSurface();
  stopDictateTimer();
  try {
    if (dictateRecord?.isRecording?.()) dictateRecord.stopRecording();
  } catch {
    // already stopped
  }
  try {
    dictateRecord?.stopMic?.();
  } catch {
    // ignore
  }
  try {
    dictateWave?.destroy();
  } catch {
    // ignore
  }
  dictateWave = null;
  dictateRecord = null;
  if (ui.wave) ui.wave.innerHTML = "";
}

function briefFields() {
  return [els.goal, els.rules, els.information].filter(Boolean);
}

function markFields(className, on, elements) {
  for (const el of elements) {
    el.classList.toggle(className, on);
    el.closest(".field")?.classList.toggle(className, on);
  }
}

function syncBriefActionButtons() {
  const running = agent.isRunning();
  const recording = isDictating();
  const followUpOpen = isFollowUpOpen();
  const busy =
    fillInFlight || transcribeInFlight || followUpApplyInFlight || running;
  if (els.dictateBtn) {
    els.dictateBtn.disabled =
      (busy && !recording) || running || followUpOpen || followUpApplyInFlight;
  }
  if (els.fillBriefBtn) {
    els.fillBriefBtn.disabled = busy || recording || followUpOpen;
  }
  if (els.fillNotes) {
    els.fillNotes.readOnly = transcribeInFlight || fillInFlight || followUpOpen;
  }
  if (els.followUpDictateBtn) {
    els.followUpDictateBtn.disabled =
      (busy && !recording) || running || !followUpOpen;
  }
  if (els.followUpApplyBtn) {
    els.followUpApplyBtn.disabled = busy || recording;
  }
  if (els.followUpSkipBtn) {
    els.followUpSkipBtn.disabled = busy || recording;
  }
  if (els.followUpSpoken) {
    els.followUpSpoken.readOnly = transcribeInFlight || followUpApplyInFlight;
  }
  if (els.startBtn) {
    els.startBtn.disabled = running || followUpOpen;
  }
}

function setDictateUi(mode) {
  const ui = getDictateSurface();
  const recording = mode === "recording";
  const working = mode === "working";
  if (!ui.btn) return;
  ui.btn.classList.toggle("recording", recording);
  ui.btn.classList.toggle("working", working);
  ui.btn.setAttribute("aria-pressed", recording ? "true" : "false");
  ui.btn.setAttribute(
    "aria-label",
    recording ? t("aria.stopDictation") : working ? t("btn.transcribing") : t("aria.dictate"),
  );
  ui.btn.setAttribute("aria-busy", working ? "true" : "false");
  if (ui.idle) ui.idle.hidden = mode !== "idle";
  if (ui.live) ui.live.hidden = !recording;
  if (ui.working) ui.working.hidden = !working;
  if (ui.notesWorking) ui.notesWorking.hidden = !working;
  if (ui.notesWrap) {
    ui.notesWrap.classList.toggle("is-transcribing", working);
  }
  if (ui.notes) {
    ui.notes.setAttribute("aria-busy", working ? "true" : "false");
  }
  syncBriefActionButtons();
}

function setFillWorking(on) {
  els.fillBriefBtn.classList.toggle("working", on);
  els.fillBriefBtn.classList.remove("awaiting-click");
  if (els.fillIdle) els.fillIdle.hidden = on;
  if (els.fillWorking) els.fillWorking.hidden = !on;
  els.fillBriefBtn.setAttribute("aria-busy", on ? "true" : "false");
  markFields("is-awaiting", on, briefFields());
  if (els.fillNotes) els.fillNotes.readOnly = on || transcribeInFlight;
}

function flashJustFilled(elements) {
  window.clearTimeout(justFilledTimer);
  markFields("just-filled", false, [
    els.fillNotes,
    ...briefFields(),
  ].filter(Boolean));
  markFields("just-filled", true, elements);
  justFilledTimer = window.setTimeout(() => {
    markFields("just-filled", false, elements);
  }, 1400);
}

function applyTranscriptToNotes(transcript) {
  const spoken = String(transcript || "").trim();
  if (!spoken || !els.fillNotes) return;
  const current = String(els.fillNotes.value || "").trim();
  els.fillNotes.value = current ? `${current}\n\n${spoken}` : spoken;
  els.fillNotes.focus();
  const len = els.fillNotes.value.length;
  els.fillNotes.setSelectionRange(len, len);
  flashJustFilled([els.fillNotes]);
  els.fillBriefBtn?.classList.add("awaiting-click");
}

function applyTranscriptToFollowUp(transcript) {
  const spoken = String(transcript || "").trim();
  if (!spoken) return;
  const active = document.activeElement;
  const questionInput =
    active &&
    active.matches?.("[data-follow-up-answer]") &&
    els.followUpModal?.contains(active)
      ? active
      : followUpLastFocus && els.followUpModal?.contains(followUpLastFocus)
        ? followUpLastFocus
        : els.followUpSpoken;
  const target = questionInput || els.followUpSpoken;
  if (!target) return;
  const current = String(target.value || "").trim();
  target.value = current ? `${current} ${spoken}` : spoken;
  target.focus();
  const len = target.value.length;
  target.setSelectionRange?.(len, len);
  flashJustFilled([target]);
}

async function startWaveSurferDictation() {
  const ui = getDictateSurface();
  const container = ui.wave;
  if (!container || !WaveSurfer || !RecordPlugin) {
    throw new Error(t("call.waveformUnavailable"));
  }
  container.innerHTML = "";
  await nextFrame();
  dictateWave = WaveSurfer.create({
    container,
    height: 28,
    barWidth: 3,
    barGap: 2,
    barRadius: 3,
    barMinHeight: 2,
    cursorWidth: 0,
    interact: false,
    hideScrollbar: true,
    fillParent: true,
    normalize: true,
    waveColor: "#ffffff",
    progressColor: "#ffffff",
  });
  const recordOptions = {
    renderRecordedAudio: false,
    scrollingWaveform: true,
    scrollingWaveformWindow: 2.4,
  };
  if (dictateMimeType) recordOptions.mimeType = dictateMimeType;
  dictateRecord = dictateWave.registerPlugin(RecordPlugin.create(recordOptions));
  dictateRecord.on("record-progress", (time) => {
    const live = getDictateSurface();
    if (live.timer) live.timer.textContent = formatDuration(time);
  });
  await dictateRecord.startRecording();
}

function showFallbackWave() {
  const ui = getDictateSurface();
  if (!ui.wave) return;
  ui.wave.innerHTML = `<span class="dictate-fallback-wave" aria-hidden="true">${"<i></i>".repeat(22)}</span>`;
}

async function startMediaRecorderDictation() {
  showFallbackWave();
  dictateStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  dictateRecorder = dictateMimeType
    ? new MediaRecorder(dictateStream, { mimeType: dictateMimeType })
    : new MediaRecorder(dictateStream);
  dictateMimeType = dictateRecorder.mimeType || dictateMimeType || "audio/webm";
  dictateChunks = [];
  dictateRecorder.ondataavailable = (event) => {
    if (event.data && event.data.size) dictateChunks.push(event.data);
  };
  dictateRecorder.onerror = () => {
    stopDictateStream();
    dictateRecorder = null;
    setDictateUi("idle");
    getDictateSurface().setStatus("");
    toast(t("toast.dictationFailed"), "error");
  };
  dictateRecorder.start();
}

async function startDictation() {
  const ui = getDictateSurface();
  dictateChunks = [];
  dictateBlob = null;
  dictateMimeType = pickRecorderMime();
  dictateStartedAt = Date.now();
  ui.awaitingBtn?.classList.remove("awaiting-click");
  setDictateUi("recording");
  startDictateTimer();
  showFallbackWave();
  ui.setStatus(t("dictate.listening"));
  try {
    await startWaveSurferDictation();
  } catch {
    destroyDictateWave();
    startDictateTimer();
    await startMediaRecorderDictation();
  }
}

function waitForRecordEnd(record) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (blob) => {
      if (done) return;
      done = true;
      resolve(blob || null);
    };
    try {
      if (typeof record.once === "function") {
        record.once("record-end", finish);
      } else {
        record.on("record-end", finish);
      }
      record.stopRecording();
    } catch {
      finish(null);
      return;
    }
    window.setTimeout(() => finish(null), 4000);
  });
}

function stopMediaRecorder() {
  return new Promise((resolve) => {
    if (!dictateRecorder || dictateRecorder.state !== "recording") {
      resolve(dictateBlob);
      return;
    }
    const recorder = dictateRecorder;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      const blob =
        dictateChunks.length > 0
          ? new Blob(dictateChunks, { type: dictateMimeType })
          : null;
      stopDictateStream();
      dictateRecorder = null;
      resolve(blob);
    };
    recorder.addEventListener("stop", finish, { once: true });
    recorder.stop();
    window.setTimeout(() => finish(), 4000);
  });
}

async function stopDictation() {
  transcribeInFlight = true;
  setDictateUi("working");
  getDictateSurface().setStatus(t("dictate.transcribing"));
  let blob = null;
  try {
    if (dictateRecord?.isRecording?.()) {
      blob = await waitForRecordEnd(dictateRecord);
      dictateMimeType = blob?.type || dictateMimeType || "audio/webm";
    } else if (dictateRecorder?.state === "recording") {
      blob = await stopMediaRecorder();
    }
  } catch {
    blob = null;
  }
  dictateDurationSec = Math.max(0, (Date.now() - dictateStartedAt) / 1000);
  destroyDictateWave();
  stopDictateStream();
  await handleRecordedBlob(blob);
}

async function handleRecordedBlob(blob) {
  const ui = getDictateSurface();
  dictateBlob =
    blob && blob.size
      ? blob
      : null;
  if (!dictateBlob) {
    transcribeInFlight = false;
    setDictateUi("idle");
    ui.setStatus(t("dictate.noAudio"));
    toast(t("toast.nothingRecorded"), "error");
    return;
  }
  try {
    const data = await api("/api/call-agent/transcribe-dictation", {
      method: "POST",
      body: JSON.stringify({
        audioBase64: await blobToBase64(dictateBlob),
        mimeType: dictateMimeType || dictateBlob.type || "audio/webm",
        audioDurationSec: dictateDurationSec,
        language: els.yourLanguage?.value || agent.state.yourLanguage,
        yourLanguage: els.yourLanguage?.value || agent.state.yourLanguage,
      }),
    });
    if (!(ui.name === "followup" && !isFollowUpOpen())) {
      ui.applyTranscript(data.transcript);
    }
    dictateBlob = null;
    dictateChunks = [];
    await refreshBilling().catch(() => {});
    const used = data.creditsDeductedLabel || "";
    ui.setStatus(ui.transcribedStatus(used));
  } catch (error) {
    toast(error.message || t("toast.transcribeFailed"), "error");
    ui.setStatus(ui.transcribeErrorStatus);
    await refreshBilling().catch(() => {});
  } finally {
    transcribeInFlight = false;
    setDictateUi("idle");
    syncBriefActionButtons();
  }
}

async function toggleDictation(surface = "brief") {
  if (fillInFlight || followUpApplyInFlight || agent.isRunning()) return;
  if (transcribeInFlight && !isDictating()) return;
  if (isDictating()) {
    await stopDictation();
    return;
  }
  if (surface === "followup" && !isFollowUpOpen()) return;
  if (surface === "brief" && isFollowUpOpen()) return;
  activeDictateSurface = surface;
  if (!window.MediaRecorder && !navigator.mediaDevices?.getUserMedia) {
    toast(t("toast.noRecorder"), "error");
    return;
  }
  try {
    await startDictation();
  } catch (error) {
    destroyDictateWave();
    stopDictateStream();
    transcribeInFlight = false;
    setDictateUi("idle");
    getDictateSurface().setStatus("");
    toast(agent.formatStartError(error), "error");
  }
}

function applyFilledFields(data, { transcriptFallback = false } = {}) {
  const fields = data.fields || {};
  if (fields.goal) agent.state.goal = fields.goal;
  if (fields.rules !== undefined) agent.state.rules = fields.rules;
  if (fields.information !== undefined) {
    agent.state.information = fields.information;
  }
  writeFieldsToDom();
  if (transcriptFallback && data.transcript && els.fillNotes && !String(els.fillNotes.value || "").trim()) {
    els.fillNotes.value = data.transcript;
  }
  flashJustFilled(briefFields());
}

function collectFollowUpAnswers() {
  const cards = els.followUpQuestions
    ? Array.from(els.followUpQuestions.querySelectorAll("[data-follow-up-card]"))
    : [];
  return cards.map((card) => ({
    id: card.getAttribute("data-follow-up-id") || "",
    question: card.getAttribute("data-follow-up-question") || "",
    reason: card.getAttribute("data-follow-up-reason") || "",
    answer: String(card.querySelector("[data-follow-up-answer]")?.value || "").trim(),
  }));
}

function followUpHasAnswers() {
  const spoken = String(els.followUpSpoken?.value || "").trim();
  return spoken.length > 0 || collectFollowUpAnswers().some((row) => row.answer);
}

function renderFollowUpQuestions(followUps) {
  if (!els.followUpQuestions) return;
  els.followUpQuestions.innerHTML = followUps
    .map((row, index) => {
      const id = escapeHtml(row.id || `fu-${index + 1}`);
      const question = escapeHtml(row.question);
      const reason = escapeHtml(row.reason || "");
      return `<article class="follow-up-card" data-follow-up-card data-follow-up-id="${id}" data-follow-up-question="${question}" data-follow-up-reason="${reason}">
        <header>
          <span class="follow-up-index">${index + 1}</span>
          <div>
            <p class="follow-up-question">${question}</p>
            ${reason ? `<p class="follow-up-reason">${reason}</p>` : ""}
          </div>
        </header>
        <div class="field">
          <label for="followUpAnswer-${index}">${t("label.yourAnswer")}</label>
          <textarea id="followUpAnswer-${index}" data-follow-up-answer rows="2" placeholder="${t("ph.followUpAnswer")}"></textarea>
        </div>
      </article>`;
    })
    .join("");
  els.followUpQuestions.querySelectorAll("[data-follow-up-answer]").forEach((input) => {
    input.addEventListener("focus", () => {
      followUpLastFocus = input;
    });
  });
}

function closeFollowUpModal() {
  if (!els.followUpModal) return;
  if (isDictating() && activeDictateSurface === "followup") {
    destroyDictateWave();
    stopDictateStream();
    transcribeInFlight = false;
    setDictateUi("idle");
  }
  els.followUpModal.hidden = true;
  if (els.followUpSpoken) els.followUpSpoken.value = "";
  if (els.followUpQuestions) els.followUpQuestions.innerHTML = "";
  setFollowUpStatus("");
  followUpCalling = "";
  followUpLastFocus = null;
  activeDictateSurface = "brief";
  followUpApplyInFlight = false;
  if (els.followUpApplyBtn) {
    els.followUpApplyBtn.classList.remove("working");
    els.followUpApplyBtn.setAttribute("aria-busy", "false");
  }
  if (els.followUpApplyIdle) els.followUpApplyIdle.hidden = false;
  if (els.followUpApplyWorking) els.followUpApplyWorking.hidden = true;
  syncBriefActionButtons();
  els.fillBriefBtn?.focus();
}

function openFollowUpModal({ calling = "", followUps = [] } = {}) {
  if (!els.followUpModal || !followUps.length) return false;
  followUpCalling = String(calling || "").trim();
  followUpLastFocus = null;
  if (els.followUpSpoken) els.followUpSpoken.value = "";
  setFollowUpStatus("");
  if (els.followUpKicker) {
    els.followUpKicker.textContent =
      followUps.length === 1
        ? t("followUp.kickerOne")
        : t("followUp.kickerMany", { count: followUps.length });
  }
  if (els.followUpCalling) {
    els.followUpCalling.hidden = !followUpCalling;
    els.followUpCalling.textContent = followUpCalling
      ? t("followUp.calling", { name: followUpCalling })
      : "";
  }
  renderFollowUpQuestions(followUps);
  els.followUpModal.hidden = false;
  activeDictateSurface = "followup";
  syncBriefActionButtons();
  const first = els.followUpQuestions?.querySelector("[data-follow-up-answer]");
  (first || els.followUpSkipBtn)?.focus();
  return true;
}

function skipFollowUps({ confirmIfDirty = true } = {}) {
  if (followUpApplyInFlight) return;
  if (confirmIfDirty && followUpHasAnswers()) {
    const ok = window.confirm(
      "Skip without adding these answers? The agent can still check with you on the call.",
    );
    if (!ok) return;
  }
  closeFollowUpModal();
  setDictateStatus(
    t("status.briefFilledAfterSkip"),
  );
  toast(t("toast.skippedFollowUps"));
}

async function applyFollowUps() {
  if (followUpApplyInFlight || fillInFlight || agent.isRunning()) return;
  if (isDictating()) {
    toast(t("toast.stopDictationFirst"), "error");
    return;
  }
  const answers = collectFollowUpAnswers();
  const notes = String(els.followUpSpoken?.value || "").trim();
  if (!notes && !answers.some((row) => row.answer)) {
    skipFollowUps({ confirmIfDirty: false });
    return;
  }
  followUpApplyInFlight = true;
  if (els.followUpApplyBtn) {
    els.followUpApplyBtn.classList.toggle("working", true);
    els.followUpApplyBtn.setAttribute("aria-busy", "true");
  }
  if (els.followUpApplyIdle) els.followUpApplyIdle.hidden = true;
  if (els.followUpApplyWorking) els.followUpApplyWorking.hidden = false;
  syncBriefActionButtons();
  setFollowUpStatus(t("status.addingFollowUps"));
  try {
    syncFieldsFromDom();
    const data = await api("/api/call-agent/apply-follow-ups", {
      method: "POST",
      body: JSON.stringify({
        notes,
        language: agent.state.yourLanguage,
        yourLanguage: agent.state.yourLanguage,
        existingGoal: agent.state.goal,
        existingRules: agent.state.rules,
        existingInformation: agent.state.information,
        calling: followUpCalling,
        answers,
      }),
    });
    applyFilledFields(data);
    await refreshBilling().catch(() => {});
    const used = data.creditsDeductedLabel || "";
    closeFollowUpModal();
    toast(
      used
        ? t("toast.detailsAddedWithUsed", { used })
        : t("toast.detailsAdded"),
    );
    setDictateStatus(
      used
        ? t("status.detailsAddedWithUsed", { used })
        : t("status.detailsAdded"),
    );
  } catch (error) {
    toast(error.message || t("toast.addDetailsFailed"), "error");
    setFollowUpStatus(t("status.addDetailsFailed"));
  } finally {
    followUpApplyInFlight = false;
    if (els.followUpApplyBtn) {
      els.followUpApplyBtn.classList.remove("working");
      els.followUpApplyBtn.setAttribute("aria-busy", "false");
    }
    if (els.followUpApplyIdle) els.followUpApplyIdle.hidden = false;
    if (els.followUpApplyWorking) els.followUpApplyWorking.hidden = true;
    syncBriefActionButtons();
    renderLive(agent.state);
  }
}

async function fillBriefFromNotes() {
  if (fillInFlight || transcribeInFlight || followUpApplyInFlight || agent.isRunning()) return;
  if (isFollowUpOpen()) return;
  if (isDictating()) {
    toast(t("toast.stopDictationFirst"), "error");
    return;
  }
  syncFieldsFromDom();
  const notes = String(els.fillNotes?.value || "").trim();
  if (!notes && !dictateBlob) {
    toast(t("toast.typeOrDictate"), "error");
    return;
  }
  fillInFlight = true;
  setFillWorking(true);
  syncBriefActionButtons();
  setDictateStatus(t("status.fillingBrief"));
  try {
    const payload = {
      notes,
      language: agent.state.yourLanguage,
      yourLanguage: agent.state.yourLanguage,
      existingGoal: agent.state.goal,
      existingRules: agent.state.rules,
      existingInformation: agent.state.information,
    };
    if (dictateBlob && !notes) {
      payload.audioBase64 = await blobToBase64(dictateBlob);
      payload.mimeType = dictateMimeType || dictateBlob.type || "audio/webm";
      payload.audioDurationSec = dictateDurationSec;
    }
    const data = await api("/api/call-agent/fill-brief", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    applyFilledFields(data, { transcriptFallback: !notes });
    dictateBlob = null;
    dictateChunks = [];
    await refreshBilling().catch(() => {});
    const used = data.creditsDeductedLabel || "";
    const followUps = Array.isArray(data.followUps) ? data.followUps : [];
    toast(
      used
        ? t("toast.briefFilledWithUsed", { used })
        : t("toast.briefFilled"),
    );
    if (followUps.length) {
      setDictateStatus(
        used
          ? t("status.briefFilledFollowUpWithUsed", { used })
          : t("status.briefFilledFollowUp"),
      );
      openFollowUpModal({
        calling: data.calling,
        followUps,
      });
    } else {
      setDictateStatus(
        used
          ? t("status.briefFilledWithUsed", { used })
          : t("status.briefFilledReady"),
      );
    }
  } catch (error) {
    toast(error.message || t("toast.fillFailed"), "error");
    setDictateStatus(t("status.fillFailed"));
  } finally {
    fillInFlight = false;
    setFillWorking(false);
    renderLive(agent.state);
  }
}

function renderTranscriptTurn(turn, state) {
  const kind = turnVisualKind(turn.speaker);
  const speaker = displaySpeakerLabel(turn.speaker);
  const yourLang = languageName(state.yourLanguage);
  const theirLang = languageName(state.theirLanguage);
  const sameLanguage = state.yourLanguage === state.theirLanguage;
  const originalLang = kind === "you" ? yourLang : theirLang;
  const showTranslation =
    !sameLanguage &&
    turn.translation &&
    turn.translation !== turn.text;
  const originalLabel =
    !sameLanguage && turn.text
      ? `<span class="turn-lang">${escapeHtml(originalLang)}</span>`
      : "";
  return `<article class="turn ${kind}${turn.status === "interim" ? " interim" : ""}">
    <header>
      <span class="turn-speaker">${escapeHtml(speaker)}</span>
      ${turn.status === "interim" ? `<span class="turn-live">Live</span>` : ""}
    </header>
    <p class="original">${originalLabel}${escapeHtml(turn.text)}</p>
    ${
      showTranslation
        ? `<p class="translated"><span class="turn-lang">${escapeHtml(
            yourLang,
          )}</span>${escapeHtml(turn.translation)}</p>`
        : ""
    }
  </article>`;
}

function closeEndCallConfirm() {
  if (!els.endCallModal || els.endCallModal.hidden) return;
  els.endCallModal.hidden = true;
}

function openEndCallConfirm() {
  if (!agent.isRunning() || !els.endCallModal) return;
  els.endCallModal.hidden = false;
  els.continueCallBtn?.focus();
}

function renderLive(state) {
  const running = agent.isRunning();
  const paused = Boolean(state.paused);
  els.statusLabel.textContent = t(state.statusMessage || "status.idle");
  els.statusDot.className = `status-dot${
    state.status === "paused" || paused
      ? " paused"
      : state.status === "speaking"
        ? " speak"
        : state.status === "listening"
          ? " listen"
          : running
            ? " on"
            : ""
  }`;
  els.livePane?.classList.toggle("is-paused", paused);
  els.startBtn.disabled = running;
  els.stopBtn.disabled = !running;
  els.pauseBtn.disabled = !agent.canTogglePause();
  els.pauseBtn.textContent = paused ? t("btn.resume") : t("btn.pause");
  els.pauseBtn.setAttribute("aria-pressed", paused ? "true" : "false");
  els.pauseBtn.title = paused
    ? t("title.resume")
    : t("title.pause");
  els.pauseBtn.classList.toggle("is-paused", paused);
  els.checkMicBtn.disabled = running;
  if (!running) closeEndCallConfirm();
  syncBriefActionButtons();
  els.summarizeBtn.disabled = running || !state.transcript.length;
  els.transcript.innerHTML = state.transcript.length
    ? collapseAdjacentDuplicateTurns(state.transcript)
        .map((turn) => renderTranscriptTurn(turn, state))
        .join("")
    : `<p class="notice">${t("live.emptyTranscript")}</p>`;
  els.transcript.scrollTop = els.transcript.scrollHeight;
  const markdown = state.summaryReport?.markdown || "";
  els.summaryBody.textContent = markdown || t("report.empty");
  if (running && state.startedAt) {
    const writeDuration = () => {
      els.durationLabel.textContent = formatDuration(agent.durationSec() * 1000);
    };
    writeDuration();
    if (!durationTimer) {
      durationTimer = window.setInterval(writeDuration, 250);
    }
  } else {
    window.clearInterval(durationTimer);
    durationTimer = null;
    els.durationLabel.textContent = formatDuration((state.lastDurationSec || 0) * 1000);
  }
}

function renderBilling() {
  const planName = billing?.planName || t("plan.free");
  const remaining = billing?.remainingSeconds ?? billing?.credits ?? 0;
  els.planLabel.textContent = planName;
  els.creditBalance.textContent = formatCallTime(remaining);
  els.settingsBalance.textContent = formatCallTime(remaining);
  const paid = billing?.plan === "pro";
  els.planCopy.textContent = paid
    ? (
        billing.cancelAtPeriodEnd
          ? t("billing.paidCanceling", {
              date: billing.currentPeriodEnd
                ? ` (${new Date(billing.currentPeriodEnd).toLocaleDateString()})`
                : "",
            })
          : t("billing.paidActive")
      )
    : t("billing.free");
  els.upgradeBtn.hidden = paid;
  els.cancelBtn.hidden = !paid || billing.cancelAtPeriodEnd;
  els.reactivateBtn.hidden = !paid || !billing.cancelAtPeriodEnd;
  els.portalBtn.hidden = !billing?.hasStripeCustomer;
}

async function refreshBilling() {
  billing = await api("/api/billing/me");
  renderBilling();
}

async function loadTemplates() {
  const data = await api("/api/call-agent/templates");
  templates = data.templates || [];
  renderTemplates();
}

async function loadSessions() {
  const data = await api("/api/call-agent/sessions");
  sessions = data.sessions || [];
  renderSessions();
}

async function loadCreditsDetails() {
  try {
    const [credits, usage] = await Promise.all([
      api("/api/user-credits/me/details").catch(() => null),
      api("/api/usage/me").catch(() => null),
    ]);
    const lots = credits?.lots || credits?.ledger?.lots || [];
    els.creditLots.innerHTML = lots.length
      ? `<table class="usage-table"><thead><tr><th>Added</th><th>Remaining</th><th>Expires</th></tr></thead><tbody>${lots
          .map(
            (lot) =>
              `<tr><td>${escapeHtml(
                lot.purchasedAt ? new Date(lot.purchasedAt).toLocaleDateString() : "",
              )}</td><td>${formatCallTime(
                lot.remaining,
              )}</td><td>${escapeHtml(
                lot.expiresAt ? new Date(lot.expiresAt).toLocaleDateString() : "",
              )}</td></tr>`,
          )
          .join("")}</tbody></table>`
      : `<p class="notice">${t("credits.lotsEmpty")}</p>`;
    const records = usage?.records || usage?.usage || [];
    els.usageTableWrap.innerHTML = records.length
      ? `<table class="usage-table"><thead><tr><th>When</th><th>Type</th><th>Used</th></tr></thead><tbody>${records
          .slice(0, 20)
          .map(
            (row) =>
              `<tr><td>${escapeHtml(
                row.createdAt ? new Date(row.createdAt).toLocaleString() : "",
              )}</td><td>${escapeHtml(row.callType || "")}</td><td>${formatCallTime(
                row.creditsDeducted || row.durationSec || 0,
              )}</td></tr>`,
          )
          .join("")}</tbody></table>`
      : `<p class="notice">${t("credits.usageEmpty")}</p>`;
  } catch {
    els.creditLots.innerHTML = "";
  }
}


let pendingLocaleCode = null;

function refreshLocalizedChrome() {
  applyTranslations(document);
  try { renderTemplates(); } catch {}
  try { renderSessions(); } catch {}
  try { renderLive(agent.state); } catch {}
  try { renderBilling(); } catch {}
}

async function applyUiLocale(code, { persist = true } = {}) {
  const next = normalizeLanguageCode(code || "en");
  await setLocale(next, { persist });
  refreshLocalizedChrome();
}

function closeLocaleModal() {
  pendingLocaleCode = null;
  if (els.localeModal) els.localeModal.hidden = true;
}

function openLocaleChangePrompt(code) {
  const next = normalizeLanguageCode(code || "en");
  if (next === getLocale()) return;
  pendingLocaleCode = next;
  const langLabel = languageName(next);
  if (els.localeCopy) {
    els.localeCopy.textContent = t("locale.dialogCopy", { language: langLabel });
  }
  if (els.localeModal) els.localeModal.hidden = false;
}

async function acceptLocaleChange() {
  const next = pendingLocaleCode;
  closeLocaleModal();
  if (!next) return;
  await applyUiLocale(next);
  toast(t("locale.changed", { language: languageName(next) }));
}

function declineLocaleChange() {
  // Keep UI locale preference as-is; yourLanguage already updated for the call.
  closeLocaleModal();
}

async function boot() {
  const ok = await ensureValidSession();
  if (!ok && !token()) {
    window.location.href = "/index.html";
    return;
  }
  try {
    profile = await api("/api/users/me");
  } catch {
    window.location.href = "/index.html";
    return;
  }
  const savedTheme = profile.userPreferences?.theme;
  if (savedTheme === "light" || savedTheme === "dark" || savedTheme === "system") {
    applyTheme({ mode: savedTheme });
  }
  if (profile.isAdmin || profile.isDev || profile.role === "admin") {
    els.adminLink.hidden = false;
  }
  els.accountName.value = profile.name || "";
  if (!agent.state.yourName && profile.name) {
    agent.state.yourName = String(profile.name).trim().slice(0, 80);
  }
  const [langData, defaults] = await Promise.all([
    api("/api/call-agent/languages"),
    api("/api/call-agent/defaults"),
  ]);
  languages = langData.languages || [];
  agent.state.prompt = defaults.prompt || DEFAULT_PROMPT;
  fillLanguages();
  // UI locale is independent of "You speak". First visit: adopt yourLanguage once and persist.
  if (hasStoredLocale()) {
    await applyUiLocale(readStoredLocale());
  } else {
    const initial = normalizeLanguageCode(els.yourLanguage?.value || agent.state.yourLanguage || "en");
    await applyUiLocale(initial, { persist: true });
  }
  writeFieldsToDom();
  await Promise.all([
    agent.loadVoices(),
    loadTemplates(),
    loadSessions(),
    refreshBilling(),
  ]);
  fillVoices();
  renderLive(agent.state);
}


els.yourLanguage?.addEventListener("change", () => {
  syncFieldsFromDom();
  const next = normalizeLanguageCode(els.yourLanguage.value);
  if (next !== getLocale()) openLocaleChangePrompt(next);
});

els.localeChangeBtn?.addEventListener("click", () => {
  acceptLocaleChange();
});
els.localeKeepBtn?.addEventListener("click", () => {
  declineLocaleChange();
});
els.localeModal?.addEventListener("click", (event) => {
  if (event.target === els.localeModal) declineLocaleChange();
});
els.theirLanguage?.addEventListener("change", () => {
  syncFieldsFromDom();
});
els.startBtn.addEventListener("click", async () => {
  syncFieldsFromDom();
  await agent.start();
  await refreshBilling();
});
els.stopBtn.addEventListener("click", () => {
  openEndCallConfirm();
});
els.continueCallBtn?.addEventListener("click", () => {
  closeEndCallConfirm();
});
els.confirmEndCallBtn?.addEventListener("click", async () => {
  closeEndCallConfirm();
  await agent.stop();
  await Promise.all([loadSessions(), refreshBilling()]);
});
els.endCallModal?.addEventListener("click", (event) => {
  if (event.target === els.endCallModal) closeEndCallConfirm();
});
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  if (isFollowUpOpen()) {
    event.preventDefault();
    skipFollowUps();
    return;
  }
  if (els.endCallModal && !els.endCallModal.hidden) {
    event.preventDefault();
    closeEndCallConfirm();
  }
});
els.pauseBtn.addEventListener("click", () => {
  closeEndCallConfirm();
  agent.togglePause();
});
els.checkMicBtn.addEventListener("click", () => agent.checkMic());
els.previewVoice.addEventListener("click", () => agent.previewVoice());
els.dictateBtn.addEventListener("click", () => toggleDictation("brief"));
els.fillBriefBtn.addEventListener("click", () => fillBriefFromNotes());
els.followUpDictateBtn?.addEventListener("click", () => toggleDictation("followup"));
els.followUpSkipBtn?.addEventListener("click", () => skipFollowUps());
els.followUpApplyBtn?.addEventListener("click", () => applyFollowUps());
els.followUpModal?.addEventListener("click", (event) => {
  if (event.target === els.followUpModal) skipFollowUps();
});
els.followUpModal?.addEventListener("keydown", (event) => {
  if (!isFollowUpOpen() || event.key !== "Tab") return;
  const focusable = Array.from(
    els.followUpModal.querySelectorAll(
      'button:not([disabled]), textarea:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
    ),
  ).filter((el) => !el.hidden && el.offsetParent !== null);
  if (!focusable.length) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
});
els.summarizeBtn.addEventListener("click", () => agent.summarize());
els.logoutBtn.addEventListener("click", async () => {
  try {
    await fetch(`${apiBase()}/api/auth/logout`, { method: "POST", credentials: "include" });
  } catch {
    // ignore
  }
  clearAuthState();
  window.location.href = "/index.html";
});
els.settingsBtn.addEventListener("click", async () => {
  els.settingsModal.hidden = false;
  await Promise.all([refreshBilling(), loadCreditsDetails()]);
});
els.closeSettings.addEventListener("click", () => {
  els.settingsModal.hidden = true;
});
els.creditPill.addEventListener("click", async () => {
  els.settingsModal.hidden = false;
  await Promise.all([refreshBilling(), loadCreditsDetails()]);
});
document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((row) => row.classList.remove("active"));
    tab.classList.add("active");
    document.querySelectorAll("[data-pane]").forEach((pane) => {
      pane.hidden = pane.getAttribute("data-pane") !== tab.dataset.tab;
    });
  });
});
els.upgradeBtn.addEventListener("click", async () => {
  try {
    const session = await startProCheckout();
    if (session.url) window.location.href = session.url;
  } catch (error) {
    els.planStatus.hidden = false;
    els.planStatus.textContent = error.message;
  }
});
els.portalBtn.addEventListener("click", async () => {
  try {
    const session = await openBillingPortal();
    if (session.url) window.location.href = session.url;
  } catch (error) {
    els.planStatus.hidden = false;
    els.planStatus.textContent = error.message;
  }
});
els.cancelBtn.addEventListener("click", async () => {
  try {
    await cancelSubscription();
    await refreshBilling();
    toast(t("toast.paidWillEnd"));
  } catch (error) {
    toast(error.message, "error");
  }
});
els.reactivateBtn.addEventListener("click", async () => {
  try {
    await reactivateSubscription();
    await refreshBilling();
    toast(t("toast.paidWillContinue"));
  } catch (error) {
    toast(error.message, "error");
  }
});
els.nameForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const nextName = String(els.accountName.value || "").trim();
    await api("/api/users/me/name", {
      method: "PUT",
      body: JSON.stringify({ name: nextName }),
    });
    const previous = String(profile?.name || "").trim();
    const currentCallName = String(els.yourName?.value || "").trim();
    if (els.yourName && (!currentCallName || currentCallName === previous)) {
      els.yourName.value = nextName;
      agent.state.yourName = nextName;
    }
    if (profile) profile.name = nextName;
    toast(t("toast.nameSaved"));
  } catch (error) {
    toast(error.message, "error");
  }
});
els.passwordForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await api("/api/users/me/password", {
      method: "PUT",
      body: JSON.stringify({
        currentPassword: document.getElementById("currentPassword").value,
        password: document.getElementById("newPassword").value,
      }),
    });
    toast(t("toast.passwordUpdated"));
    event.target.reset();
  } catch (error) {
    toast(error.message, "error");
  }
});
els.deleteAccountBtn.addEventListener("click", async () => {
  if (!window.confirm(t("confirm.deleteAccount"))) return;
  try {
    await api("/api/users/me/deletion", {
      method: "POST",
      body: JSON.stringify({ confirm: true }),
    });
    toast(t("toast.deletionScheduled"));
  } catch (error) {
    toast(error.message, "error");
  }
});

initBrandSelects();
initPaneResize();
initI18n(readStoredLocale()).then(() => boot()).catch((error) => {
  console.error(error);
  toast(error.message || t("toast.appLoadFailed"), "error");
});


onLocaleChange(() => {
  refreshLocalizedChrome();
});
