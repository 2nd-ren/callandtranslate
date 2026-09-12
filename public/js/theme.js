import { hasConsent } from "./cookie-consent.js";

const THEME_KEY = "lpd-theme";
const PALETTE_KEY = "lpd-palette";
const THEME_MODES = ["light", "dark", "system"];

const ICONS = {
  light: `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/></svg>`,
  dark: `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 14.5A8.5 8.5 0 1 1 9.5 3 7 7 0 0 0 21 14.5z"/></svg>`,
  system: `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/></svg>`,
};

let currentMode = null;
let currentPalette = null;
let chosen = false;
let accountLoadStarted = false;

function readStored(key) {
  try {
    return localStorage.getItem(key) || "";
  } catch {
    return "";
  }
}

function storedMode() {
  const value = readStored(THEME_KEY);
  return THEME_MODES.includes(value) ? value : "";
}

function systemPrefersDark() {
  return (
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-color-scheme: dark)").matches
  );
}

function getCookie(name) {
  try {
    const value = `; ${document.cookie}`;
    const parts = value.split(`; ${name}=`);
    if (parts.length === 2) {
      return decodeURIComponent(parts.pop().split(";").shift() || "");
    }
  } catch {
    // ignore
  }
  return "";
}

function apiBase() {
  try {
    if (typeof AppConfig !== "undefined" && AppConfig?.apiBaseUrl) {
      return String(AppConfig.apiBaseUrl).replace(/\/+$/, "");
    }
  } catch {
    // ignore
  }
  return "";
}

function authToken() {
  return getCookie("authToken");
}

export function resolveTheme(mode) {
  const stored = mode || currentMode || storedMode() || "system";
  if (stored === "light" || stored === "dark") return stored;
  return systemPrefersDark() ? "dark" : "light";
}

export function getThemeMode() {
  return currentMode || storedMode() || "system";
}

export function getPalette() {
  return currentPalette || readStored(PALETTE_KEY) || "night";
}

function persistLocal(mode, palette) {
  try {
    localStorage.setItem(THEME_KEY, mode);
    if (palette && hasConsent("functional")) {
      localStorage.setItem(PALETTE_KEY, palette);
    }
  } catch {
    // ignore
  }
}

function persistAccount(mode) {
  const token = authToken();
  if (!token || !THEME_MODES.includes(mode)) return;
  const url = `${apiBase()}/api/users/me/preferences`;
  fetch(url, {
    method: "PUT",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "x-auth-token": token,
    },
    body: JSON.stringify({ userPreferences: { theme: mode } }),
  }).catch(() => {});
}

export function applyTheme({ mode, palette, persist = false } = {}) {
  const explicit = THEME_MODES.includes(mode);
  const nextMode = explicit ? mode : getThemeMode();
  const nextPalette = palette || getPalette();
  currentMode = nextMode;
  currentPalette = nextPalette;
  if (explicit) {
    chosen = true;
    persistLocal(nextMode, nextPalette);
  }
  const resolved = resolveTheme(nextMode);
  document.documentElement.setAttribute("data-theme", resolved);
  document.documentElement.setAttribute("data-palette", nextPalette);
  document.documentElement.style.colorScheme = resolved;
  if (persist) persistAccount(nextMode);
  syncThemeControls();
  return { mode: nextMode, palette: nextPalette, resolved };
}

export function toggleLightDark() {
  const next = resolveTheme() === "dark" ? "light" : "dark";
  return applyTheme({ mode: next, persist: true });
}

export function setThemeMode(mode) {
  if (!THEME_MODES.includes(mode)) return getThemeMode();
  return applyTheme({ mode, persist: true });
}

export function cycleTheme() {
  return toggleLightDark();
}

function fillToggleButton(btn) {
  const resolved = resolveTheme();
  const next = resolved === "dark" ? "light" : "dark";
  btn.innerHTML = ICONS[resolved];
  btn.setAttribute(
    "aria-label",
    next === "light" ? "Switch to light theme" : "Switch to dark theme",
  );
  btn.title = next === "light" ? "Use light theme" : "Use dark theme";
}

function ensureMenu(root) {
  if (root.querySelector("[data-theme-menu-button]")) return;
  root.classList.add("theme-menu");
  root.innerHTML = `
    <button type="button" class="btn btn-ghost btn-icon theme-toggle" data-theme-menu-button aria-label="Colour theme" aria-haspopup="menu" aria-expanded="false"></button>
    <div class="theme-menu-panel" role="menu" hidden>
      <button type="button" role="menuitemradio" data-theme-option="light" aria-checked="false">${ICONS.light}<span>Light</span></button>
      <button type="button" role="menuitemradio" data-theme-option="dark" aria-checked="false">${ICONS.dark}<span>Dark</span></button>
      <button type="button" role="menuitemradio" data-theme-option="system" aria-checked="false">${ICONS.system}<span>System</span></button>
    </div>
  `;
}

function closeMenus() {
  document.querySelectorAll("[data-theme-menu]").forEach((root) => {
    const btn = root.querySelector("[data-theme-menu-button]");
    const panel = root.querySelector(".theme-menu-panel");
    if (btn) btn.setAttribute("aria-expanded", "false");
    if (panel) panel.hidden = true;
  });
}

function fillMenu(root) {
  ensureMenu(root);
  const mode = getThemeMode();
  const resolved = resolveTheme(mode);
  const iconName = mode === "system" ? "system" : resolved;
  const btn = root.querySelector("[data-theme-menu-button]");
  const panel = root.querySelector(".theme-menu-panel");
  if (btn) {
    btn.innerHTML = ICONS[iconName] || ICONS.system;
    const label =
      mode === "system"
        ? "Colour theme: system"
        : mode === "light"
          ? "Colour theme: light"
          : "Colour theme: dark";
    btn.setAttribute("aria-label", label);
    btn.title = "Colour theme";
  }
  panel?.querySelectorAll("[data-theme-option]").forEach((option) => {
    const selected = option.getAttribute("data-theme-option") === mode;
    option.setAttribute("aria-checked", selected ? "true" : "false");
  });
}

export function syncThemeControls() {
  document.querySelectorAll("[data-theme-toggle]").forEach(fillToggleButton);
  document.querySelectorAll("[data-theme-menu]").forEach(fillMenu);
}

function loadAccountTheme() {
  const token = authToken();
  if (!token || accountLoadStarted) return;
  accountLoadStarted = true;
  const url = `${apiBase()}/api/users/me/preferences`;
  fetch(url, {
    credentials: "include",
    headers: { "x-auth-token": token },
  })
    .then((res) => (res.ok ? res.json() : null))
    .then((data) => {
      const mode = data?.userPreferences?.theme;
      if (THEME_MODES.includes(mode)) {
        applyTheme({ mode, persist: false });
        return;
      }
      if (chosen) persistAccount(getThemeMode());
    })
    .catch(() => {});
}

export function initTheme() {
  chosen = Boolean(storedMode());
  applyTheme();
  loadAccountTheme();
  if (typeof window.matchMedia === "function") {
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
      if (getThemeMode() === "system") applyTheme();
    });
  }
  document.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;

    const toggle = target.closest("[data-theme-toggle]");
    if (toggle) {
      toggleLightDark();
      return;
    }

    const option = target.closest("[data-theme-option]");
    if (option) {
      const mode = option.getAttribute("data-theme-option");
      setThemeMode(mode);
      closeMenus();
      return;
    }

    const menuBtn = target.closest("[data-theme-menu-button]");
    if (menuBtn) {
      const root = menuBtn.closest("[data-theme-menu]");
      const panel = root?.querySelector(".theme-menu-panel");
      const open = panel && panel.hidden;
      closeMenus();
      if (open && panel) {
        panel.hidden = false;
        menuBtn.setAttribute("aria-expanded", "true");
      }
      return;
    }

    if (!target.closest("[data-theme-menu]")) closeMenus();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeMenus();
  });
  window.addEventListener("cookie-consent-change", (event) => {
    if (event.detail?.functional && chosen) persistLocal(getThemeMode(), getPalette());
  });
}

initTheme();
