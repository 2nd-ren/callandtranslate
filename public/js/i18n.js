/**
 * Lightweight client i18n for Call & Translate.
 * Fallback: requested locale → language short code → en
 */
const STORAGE_KEY = "callandtranslate.uiLocale";
const RTL_LOCALES = new Set(["ar", "he", "ur", "fa"]);
const SUPPORTED = new Set([
  "en", "es", "fr", "de", "it", "pt", "nl", "pl", "ru", "uk", "ar", "zh", "ja",
  "ko", "hi", "bn", "tr", "vi", "th", "id", "ms", "fil", "sv", "da", "no", "fi",
  "el", "he", "cs", "ro", "hu", "bg", "hr", "sk", "sl", "sr", "ca", "ta", "ur",
  "fa", "sw",
]);

let locale = "en";
const catalogs = Object.create(null);
const listeners = new Set();
let enLoaded = false;

function normalizeLocale(code, fallback = "en") {
  const key = String(code || "").trim().toLowerCase().replace(/_/g, "-");
  if (!key) return fallback;
  if (SUPPORTED.has(key)) return key;
  const short = key.split("-")[0];
  if (SUPPORTED.has(short)) return short;
  return fallback;
}

function interpolate(template, vars = {}) {
  return String(template ?? "").replace(/\{(\w+)\}/g, (_, name) => {
    if (vars[name] == null) return `{${name}}`;
    return String(vars[name]);
  });
}

function lookup(key) {
  if (!key) return null;
  const short = locale.split("-")[0];
  const fromLocale = catalogs[locale]?.[key];
  if (fromLocale != null && fromLocale !== "") return fromLocale;
  if (short !== locale) {
    const fromShort = catalogs[short]?.[key];
    if (fromShort != null && fromShort !== "") return fromShort;
  }
  const fromEn = catalogs.en?.[key];
  if (fromEn != null && fromEn !== "") return fromEn;
  return null;
}

export function t(key, vars) {
  const raw = lookup(key);
  if (raw == null) return key;
  return interpolate(raw, vars);
}

export function hasKey(key) {
  return lookup(key) != null;
}

export function getLocale() {
  return locale;
}

export function isRtl(code = locale) {
  return RTL_LOCALES.has(normalizeLocale(code));
}

export function onLocaleChange(fn) {
  if (typeof fn !== "function") return () => {};
  listeners.add(fn);
  return () => listeners.delete(fn);
}

async function fetchCatalog(code) {
  const normalized = normalizeLocale(code);
  if (catalogs[normalized]) return catalogs[normalized];
  try {
    const response = await fetch(`/i18n/${normalized}.json`, {
      credentials: "same-origin",
      cache: "no-cache",
    });
    if (!response.ok) {
      catalogs[normalized] = Object.create(null);
      return catalogs[normalized];
    }
    const data = await response.json();
    catalogs[normalized] =
      data && typeof data === "object" && !Array.isArray(data)
        ? data
        : Object.create(null);
  } catch {
    catalogs[normalized] = Object.create(null);
  }
  return catalogs[normalized];
}

function applyAttr(el, attr, key) {
  if (!key) return;
  el.setAttribute(attr, t(key));
}

export function applyTranslations(root = document) {
  const scope = root || document;
  scope.querySelectorAll("[data-i18n]").forEach((el) => {
    const key = el.getAttribute("data-i18n");
    if (!key) return;
    if (el.childElementCount > 0) {
      // Prefer explicit text node / keep structure: only replace if single text
      const textNodes = [...el.childNodes].filter((n) => n.nodeType === Node.TEXT_NODE);
      if (textNodes.length === 1 && el.childElementCount === 0) {
        textNodes[0].textContent = t(key);
      } else if (el.hasAttribute("data-i18n-html")) {
        el.innerHTML = t(key);
      } else {
        el.textContent = t(key);
      }
    } else {
      el.textContent = t(key);
    }
  });
  scope.querySelectorAll("[data-i18n-html]").forEach((el) => {
    const key = el.getAttribute("data-i18n-html");
    if (key) el.innerHTML = t(key);
  });
  scope.querySelectorAll("[data-i18n-placeholder]").forEach((el) => {
    applyAttr(el, "placeholder", el.getAttribute("data-i18n-placeholder"));
  });
  scope.querySelectorAll("[data-i18n-title]").forEach((el) => {
    applyAttr(el, "title", el.getAttribute("data-i18n-title"));
  });
  scope.querySelectorAll("[data-i18n-aria-label]").forEach((el) => {
    applyAttr(el, "aria-label", el.getAttribute("data-i18n-aria-label"));
  });
  scope.querySelectorAll("[data-i18n-label]").forEach((el) => {
    // used when we store the translation key separately from visible text
    const key = el.getAttribute("data-i18n-label");
    if (key) el.setAttribute("data-i18n-label-value", t(key));
  });
}

function applyDocumentMeta() {
  document.documentElement.lang = locale;
  document.documentElement.dir = isRtl(locale) ? "rtl" : "ltr";
  const titleKey = document.documentElement.getAttribute("data-i18n-title-key");
  if (titleKey) document.title = t(titleKey);
}

export async function setLocale(code, { persist = true, announce = true } = {}) {
  const next = normalizeLocale(code);
  if (!enLoaded) {
    await fetchCatalog("en");
    enLoaded = true;
  }
  if (next !== "en") await fetchCatalog(next);
  const changed = next !== locale;
  locale = next;
  if (persist) {
    try {
      localStorage.setItem(STORAGE_KEY, locale);
    } catch {
      // ignore quota / private mode
    }
  }
  applyDocumentMeta();
  applyTranslations(document);
  if (announce && changed) {
    listeners.forEach((fn) => {
      try {
        fn(locale);
      } catch (err) {
        console.error(err);
      }
    });
  } else if (announce && !changed) {
    // still notify so dynamic UI can re-render with same locale after catalogs load
    listeners.forEach((fn) => {
      try {
        fn(locale);
      } catch (err) {
        console.error(err);
      }
    });
  }
  return locale;
}

export function readStoredLocale() {
  try {
    return normalizeLocale(localStorage.getItem(STORAGE_KEY) || "");
  } catch {
    return "en";
  }
}

/** True when the user (or a prior boot) has explicitly saved a UI locale. */
export function hasStoredLocale() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return Boolean(raw && String(raw).trim());
  } catch {
    return false;
  }
}

export async function initI18n(preferred) {
  await fetchCatalog("en");
  enLoaded = true;
  const stored = readStoredLocale();
  const initial = normalizeLocale(preferred || stored || "en");
  if (initial !== "en") await fetchCatalog(initial);
  locale = initial;
  applyDocumentMeta();
  applyTranslations(document);
  return locale;
}

export function normalizeLanguageCode(code, fallback = "en") {
  return normalizeLocale(code, fallback);
}

export const I18N_SUPPORTED = [...SUPPORTED];
