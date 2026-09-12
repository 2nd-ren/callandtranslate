/**
 * GDPR cookie consent: store a dated, versioned choice, default optional
 * categories off, and never load non-essential tags until the user opts in.
 */

export const CONSENT_VERSION = 1;
export const CONSENT_COOKIE = "cat_cookie_consent";
export const CONSENT_STORAGE_KEY = "cat_cookie_consent";
export const CONSENT_MAX_AGE_SECONDS = 365 * 24 * 60 * 60;
export const CONSENT_EVENT = "cookie-consent-change";

const CATEGORIES = ["necessary", "functional", "analytics", "marketing"];

/** Optional third-party tags, injected only after the matching category is granted. */
const OPTIONAL_TAGS = {
  analytics: [],
  marketing: [],
};

let bannerEl = null;
let prefsEl = null;
let lastFocus = null;
let injectedTags = new Set();

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

function setCookie(name, value, maxAgeSeconds) {
  const maxAge =
    Number.isFinite(maxAgeSeconds) && maxAgeSeconds > 0
      ? Math.floor(maxAgeSeconds)
      : 0;
  const secure =
    typeof location !== "undefined" && location.protocol === "https:"
      ? "; secure"
      : "";
  document.cookie = `${name}=${encodeURIComponent(
    value || "",
  )}; path=/; max-age=${maxAge}; samesite=lax${secure}`;
}

function parseConsent(raw) {
  if (!raw) return null;
  try {
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!parsed || typeof parsed !== "object") return null;
    const version = Number(parsed.v);
    if (!Number.isFinite(version) || version !== CONSENT_VERSION) return null;
    return {
      v: CONSENT_VERSION,
      ts: String(parsed.ts || ""),
      necessary: true,
      functional: parsed.functional === true,
      analytics: parsed.analytics === true,
      marketing: parsed.marketing === true,
    };
  } catch {
    return null;
  }
}

export function getConsent() {
  try {
    const fromStorage = parseConsent(localStorage.getItem(CONSENT_STORAGE_KEY));
    if (fromStorage) return fromStorage;
  } catch {
    // ignore
  }
  return parseConsent(getCookie(CONSENT_COOKIE));
}

export function hasConsent(category) {
  if (category === "necessary") return true;
  const consent = getConsent();
  return Boolean(consent && consent[category] === true);
}

function applyOptionalTags(consent) {
  for (const category of ["analytics", "marketing"]) {
    if (!consent?.[category]) continue;
    for (const tag of OPTIONAL_TAGS[category] || []) {
      const src = String(tag.src || "");
      if (!src || injectedTags.has(src)) continue;
      injectedTags.add(src);
      const script = document.createElement("script");
      script.src = src;
      script.async = tag.async !== false;
      if (tag.id) script.id = tag.id;
      document.head.appendChild(script);
    }
  }
}

function clearFunctionalStorage() {
  try {
    localStorage.removeItem("lpd-theme");
    localStorage.removeItem("lpd-palette");
    localStorage.removeItem("cat-brief-pane-width");
  } catch {
    // ignore
  }
}

function persistConsentRecord(record) {
  const raw = JSON.stringify(record);
  try {
    localStorage.setItem(CONSENT_STORAGE_KEY, raw);
  } catch {
    // ignore
  }
  setCookie(CONSENT_COOKIE, raw, CONSENT_MAX_AGE_SECONDS);
}

function persistConsentToAccount(record) {
  const token = getCookie("authToken");
  if (!token) return;
  const url = `${apiBase()}/api/users/me/preferences`;
  fetch(url, {
    method: "PUT",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "x-auth-token": token,
    },
    body: JSON.stringify({ userPreferences: { cookieConsent: record } }),
  }).catch(() => {});
}

export function saveConsent(partial = {}) {
  const record = {
    v: CONSENT_VERSION,
    ts: new Date().toISOString(),
    necessary: true,
    functional: partial.functional === true,
    analytics: partial.analytics === true,
    marketing: partial.marketing === true,
  };
  persistConsentRecord(record);
  if (!record.functional) clearFunctionalStorage();
  applyOptionalTags(record);
  persistConsentToAccount(record);
  try {
    window.dispatchEvent(new CustomEvent(CONSENT_EVENT, { detail: record }));
  } catch {
    // ignore
  }
  hideBanner();
  closePreferences();
  return record;
}

function hideBanner() {
  bannerEl?.remove();
  bannerEl = null;
  document.body?.classList.remove("cookie-banner-open");
}

function closePreferences() {
  prefsEl?.remove();
  prefsEl = null;
  if (lastFocus && typeof lastFocus.focus === "function") {
    try {
      lastFocus.focus();
    } catch {
      // ignore
    }
  }
  lastFocus = null;
}

function categoryTogglesFromDom() {
  const read = (name) =>
    Boolean(prefsEl?.querySelector(`[data-cookie-cat="${name}"]`)?.checked);
  return {
    functional: read("functional"),
    analytics: read("analytics"),
    marketing: read("marketing"),
  };
}

function renderBanner() {
  if (bannerEl || getConsent()) return;
  bannerEl = document.createElement("div");
  bannerEl.className = "cookie-banner";
  bannerEl.setAttribute("role", "region");
  bannerEl.setAttribute("aria-label", "Cookie consent");
  bannerEl.innerHTML = `
    <div class="cookie-banner-copy">
      <h2>Cookies</h2>
      <p>
        We use strictly necessary cookies to run this site and keep you signed in.
        Optional cookies remember your theme. We do not use analytics or marketing
        cookies today. You can accept, reject, or choose categories.
        <a href="/cookies">Cookie policy</a>
        · <a href="/privacy">Privacy</a>
      </p>
    </div>
    <div class="cookie-banner-actions">
      <button type="button" class="btn" data-cookie-reject>Reject optional</button>
      <button type="button" class="btn btn-ghost" data-cookie-customize>Customise</button>
      <button type="button" class="btn" data-cookie-accept>Accept all</button>
    </div>
  `;
  document.body.appendChild(bannerEl);
  document.body.classList.add("cookie-banner-open");
}

function renderPreferences() {
  if (prefsEl) {
    prefsEl.querySelector(".cookie-prefs")?.focus();
    return;
  }
  lastFocus = document.activeElement;
  const current = getConsent() || {
    functional: false,
    analytics: false,
    marketing: false,
  };
  prefsEl = document.createElement("div");
  prefsEl.className = "cookie-prefs-backdrop";
  prefsEl.innerHTML = `
    <div class="cookie-prefs modal" role="dialog" aria-modal="true" aria-labelledby="cookiePrefsTitle" tabindex="-1">
      <div class="cookie-prefs-head">
        <h2 id="cookiePrefsTitle">Cookie settings</h2>
        <button type="button" class="btn btn-ghost" data-cookie-prefs-close>Close</button>
      </div>
      <p class="cookie-prefs-lead">
        Strictly necessary cookies are always on. Everything else stays off unless you switch it on.
        You can change this later from Cookie settings in the footer.
        Read the <a href="/cookies">cookie policy</a>.
      </p>
      <div class="cookie-cat">
        <div>
          <strong>Strictly necessary</strong>
          <span>Sign-in, security, and storing this choice. The site cannot run without these.</span>
        </div>
        <label class="cookie-switch">
          <input type="checkbox" checked disabled data-cookie-cat="necessary" />
          <span>On</span>
        </label>
      </div>
      <div class="cookie-cat">
        <div>
          <strong>Functional</strong>
          <span>Remember theme and display preferences on this device.</span>
        </div>
        <label class="cookie-switch">
          <input type="checkbox" data-cookie-cat="functional" ${current.functional ? "checked" : ""} />
          <span>Allow</span>
        </label>
      </div>
      <div class="cookie-cat">
        <div>
          <strong>Analytics</strong>
          <span>We do not set analytics cookies today. If we add them later, they stay off until you opt in and we ask again.</span>
        </div>
        <label class="cookie-switch">
          <input type="checkbox" data-cookie-cat="analytics" ${current.analytics ? "checked" : ""} />
          <span>Allow</span>
        </label>
      </div>
      <div class="cookie-cat">
        <div>
          <strong>Marketing</strong>
          <span>We do not set marketing or advertising cookies today.</span>
        </div>
        <label class="cookie-switch">
          <input type="checkbox" data-cookie-cat="marketing" ${current.marketing ? "checked" : ""} />
          <span>Allow</span>
        </label>
      </div>
      <div class="cookie-prefs-actions">
        <button type="button" class="btn" data-cookie-reject>Reject optional</button>
        <button type="button" class="btn btn-primary" data-cookie-save>Save choices</button>
      </div>
    </div>
  `;
  document.body.appendChild(prefsEl);
  prefsEl.querySelector(".cookie-prefs")?.focus();
}

export function openCookieSettings() {
  renderPreferences();
}

function enhanceFooters() {
  const links = [
    { href: "/privacy", label: "Privacy" },
    { href: "/cookies", label: "Cookies" },
    { href: "/terms", label: "Terms" },
    { href: "/acceptable-use", label: "Acceptable use" },
  ];
  document.querySelectorAll(".site-footer-links").forEach((nav) => {
    for (const item of links) {
      if (!nav.querySelector(`a[href="${item.href}"]`)) {
        const a = document.createElement("a");
        a.href = item.href;
        a.textContent = item.label;
        nav.appendChild(a);
      }
    }
    if (!nav.querySelector("[data-cookie-settings]")) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.setAttribute("data-cookie-settings", "");
      btn.textContent = "Cookie settings";
      nav.appendChild(btn);
    }
  });
  if (document.querySelector("[data-cookie-settings]")) return;
  const footer = document.createElement("footer");
  footer.className = "site-footer";
  footer.innerHTML = `
    <div></div>
    <nav class="site-footer-links" aria-label="Legal">
      <a href="/privacy">Privacy</a>
      <a href="/cookies">Cookies</a>
      <a href="/terms">Terms</a>
      <a href="/acceptable-use">Acceptable use</a>
      <button type="button" data-cookie-settings>Cookie settings</button>
    </nav>
  `;
  const host = document.querySelector(".wrap, .wrap-narrow, .admin-page-container") || document.body;
  host.appendChild(footer);
}

function onReady(fn) {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", fn, { once: true });
  } else {
    fn();
  }
}

function initCookieConsent() {
  const existing = getConsent();
  if (existing) applyOptionalTags(existing);
  else renderBanner();
  enhanceFooters();

  document.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    if (target.closest("[data-cookie-accept]")) {
      saveConsent({
        functional: true,
        analytics: OPTIONAL_TAGS.analytics.length > 0,
        marketing: OPTIONAL_TAGS.marketing.length > 0,
      });
      return;
    }
    if (target.closest("[data-cookie-reject]")) {
      saveConsent({ functional: false, analytics: false, marketing: false });
      return;
    }
    if (target.closest("[data-cookie-save]")) {
      saveConsent(categoryTogglesFromDom());
      return;
    }
    if (target.closest("[data-cookie-customize], [data-cookie-settings]")) {
      event.preventDefault();
      openCookieSettings();
      return;
    }
    if (target.closest("[data-cookie-prefs-close]")) {
      closePreferences();
      return;
    }
    if (prefsEl && target === prefsEl) {
      closePreferences();
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && prefsEl) {
      closePreferences();
    }
  });

  window.addEventListener("auth:session-restored", () => {
    const consent = getConsent();
    if (consent) persistConsentToAccount(consent);
  });
}

onReady(initCookieConsent);

if (typeof window !== "undefined") {
  window.CookieConsent = {
    get: getConsent,
    has: hasConsent,
    save: saveConsent,
    open: openCookieSettings,
    categories: CATEGORIES,
  };
}
