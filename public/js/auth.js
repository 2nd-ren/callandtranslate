/**
 * Session manager: short-lived access tokens, silent refresh, soft re-login,
 * proactive expiry warnings, and fetch retry — without destroying open work.
 */

const LOGIN_PATH = "/index.html";
const DEFAULT_EXPIRY_MESSAGE = "Your session has expired. Please log in again.";
const ACCESS_COOKIE = "authToken";
const PROFILE_COOKIES = ["_id", "email", "name", "emailValidated", "numberOfCredits"];
const EXPIRY_STORAGE_KEY = "authAccessExpiresAt";
const PROACTIVE_WARN_MS = 5 * 60 * 1000; // warn 5 min before access expiry
const REFRESH_SKEW_MS = 90 * 1000; // refresh when < 90s remain
const ACTIVITY_IDLE_MS = 30 * 60 * 1000; // only auto-refresh if user active in last 30m

let tokenExpiryHandled = false;
let reauthModalOpen = false;
let refreshInFlight = null;
let lastUserActivityAt = Date.now();
let sessionMaintenanceStarted = false;
let proactiveBannerEl = null;
let reauthResolvers = [];
/** Avoid double re-login modals when interceptor and call sites both see 401. */
let lastReauthAttemptAt = 0;
const REAUTH_COOLDOWN_MS = 2500;

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
  // SameSite=Lax is safe for same-site SPA; avoid Strict so top-level nav still works
  document.cookie = `${name}=${encodeURIComponent(
    value || "",
  )}; path=/; max-age=${maxAge}; samesite=lax${secure}`;
}

function clearCookie(name) {
  document.cookie = `${name}=; path=/; max-age=0; expires=Thu, 01 Jan 1970 00:00:00 GMT`;
}

function getAuthToken() {
  return getCookie(ACCESS_COOKIE) || "";
}

function getAccessExpiresAtMs() {
  try {
    const fromStorage = Date.parse(sessionStorage.getItem(EXPIRY_STORAGE_KEY) || "");
    if (Number.isFinite(fromStorage)) return fromStorage;
  } catch {
    // ignore
  }
  // Decode JWT exp if present
  const token = getAuthToken();
  if (!token) return 0;
  try {
    const parts = token.split(".");
    if (parts.length < 2) return 0;
    const payload = JSON.parse(
      atob(parts[1].replace(/-/g, "+").replace(/_/g, "/")),
    );
    if (payload?.exp) return payload.exp * 1000;
  } catch {
    // ignore
  }
  return 0;
}

function setAccessExpiresAt(expiresAtIsoOrMs, expiresInSeconds) {
  let ms = 0;
  if (typeof expiresAtIsoOrMs === "number" && Number.isFinite(expiresAtIsoOrMs)) {
    ms = expiresAtIsoOrMs;
  } else if (expiresAtIsoOrMs) {
    ms = Date.parse(expiresAtIsoOrMs);
  }
  if (!Number.isFinite(ms) || ms <= 0) {
    const ttl =
      Number.isFinite(expiresInSeconds) && expiresInSeconds > 0
        ? expiresInSeconds
        : 30 * 60;
    ms = Date.now() + ttl * 1000;
  }
  try {
    sessionStorage.setItem(EXPIRY_STORAGE_KEY, new Date(ms).toISOString());
  } catch {
    // ignore
  }
  return ms;
}

/**
 * Persist access token from login/refresh/password-change responses.
 */
function setAccessToken(token, { expiresIn, expiresAt } = {}) {
  if (!token) return;
  let ttl = Number(expiresIn);
  if (!Number.isFinite(ttl) || ttl <= 0) {
    const expMs = expiresAt ? Date.parse(expiresAt) : 0;
    if (Number.isFinite(expMs) && expMs > Date.now()) {
      ttl = Math.floor((expMs - Date.now()) / 1000);
    } else {
      // Decode JWT
      try {
        const parts = token.split(".");
        const payload = JSON.parse(
          atob(parts[1].replace(/-/g, "+").replace(/_/g, "/")),
        );
        if (payload?.exp) {
          ttl = Math.max(60, payload.exp - Math.floor(Date.now() / 1000));
        }
      } catch {
        ttl = 30 * 60;
      }
    }
  }
  // Cookie slightly longer than JWT so client can still send token for
  // server to return TOKEN_EXPIRED (triggers refresh) rather than missing token
  setCookie(ACCESS_COOKIE, token, ttl + 120);
  setAccessExpiresAt(expiresAt, ttl);
}

function persistProfileCookies(data, maxAgeSeconds = 14 * 24 * 60 * 60) {
  if (!data || typeof data !== "object") return;
  if (data._id) setCookie("_id", String(data._id), maxAgeSeconds);
  if (data.email) setCookie("email", String(data.email), maxAgeSeconds);
  if (data.name) setCookie("name", String(data.name), maxAgeSeconds);
  if (Object.prototype.hasOwnProperty.call(data, "emailValidated")) {
    setCookie("emailValidated", String(data.emailValidated), maxAgeSeconds);
  }
}

/**
 * Apply login / refresh / verify response to client storage.
 */
function applySessionResponse(data, { response } = {}) {
  if (!data || typeof data !== "object") return false;
  const token =
    data.token ||
    data.authToken ||
    response?.headers?.get?.("x-auth-token") ||
    "";
  if (!token) return false;

  const expiresInHeader = response?.headers?.get?.("x-access-token-expires-in");
  const expiresInCandidate =
    data.expiresIn != null ? data.expiresIn : expiresInHeader;
  const expiresInNumber = Number(expiresInCandidate);
  const expiresIn = Number.isFinite(expiresInNumber) ? expiresInNumber : undefined;
  const expiresAt =
    data.expiresAt ||
    response?.headers?.get?.("x-access-token-expires-at") ||
    undefined;

  setAccessToken(token, { expiresIn, expiresAt });
  persistProfileCookies(data.user || data);
  tokenExpiryHandled = false;
  hideProactiveBanner();
  markUserActivity();
  try {
    window.dispatchEvent(
      new CustomEvent("auth:session-restored", { detail: { data } }),
    );
  } catch {
    // ignore
  }
  return true;
}

function clearAuthState({ hard = false } = {}) {
  try {
    localStorage.removeItem("token");
  } catch {
    // ignore
  }

  try {
    sessionStorage.removeItem(EXPIRY_STORAGE_KEY);
    if (hard) sessionStorage.removeItem("pendingVerificationMessage");
  } catch {
    // ignore
  }

  clearCookie(ACCESS_COOKIE);
  PROFILE_COOKIES.forEach((name) => clearCookie(name));
}

function isLoginLikePage() {
  const path = window.location?.pathname || "";
  return (
    path === "/" ||
    path.endsWith("/index.html") ||
    path.endsWith("/register.html") ||
    path.endsWith("/forgot.html") ||
    path.endsWith("/reset.html") ||
    path.endsWith("/verify.html")
  );
}

function markUserActivity() {
  lastUserActivityAt = Date.now();
}

function userIsRecentlyActive() {
  return Date.now() - lastUserActivityAt < ACTIVITY_IDLE_MS;
}

function isRefreshUrl(url) {
  try {
    const u = typeof url === "string" ? url : url?.url || String(url);
    return /\/api\/auth\/refresh\b/.test(u) || /\/api\/auth\/?$/.test(u);
  } catch {
    return false;
  }
}

function isLogoutUrl(url) {
  try {
    const u = typeof url === "string" ? url : url?.url || String(url);
    return /\/api\/auth\/logout/.test(u) || /\/logout\b/.test(u);
  } catch {
    return false;
  }
}

async function readResponseMessage(response) {
  try {
    const cloned = response.clone();
    const contentType = cloned.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      const data = await cloned.json();
      if (data && typeof data === "object") {
        return {
          message: data.message || data.error || "",
          code: data.code || "",
        };
      }
    }
    const text = await cloned.text();
    return { message: text || "", code: "" };
  } catch {
    return { message: "", code: "" };
  }
}

/**
 * Only treat explicit auth failures as session death.
 * Avoid mapping every 400 on /api/projects to logout.
 */
async function isAuthFailureResponse(response) {
  if (!response) return false;
  if (response.status === 401) {
    const { code, message } = await readResponseMessage(response);
    // Password wrong on change-password is 401 with different meaning
    if (
      code === "INVALID_CREDENTIALS" ||
      /current password is incorrect/i.test(message || "")
    ) {
      return false;
    }
    return true;
  }
  // Legacy servers returned 400 "Invalid token." — only trust that exact shape
  if (response.status === 400) {
    const { code, message } = await readResponseMessage(response);
    if (code === "INVALID_TOKEN" || code === "TOKEN_EXPIRED") return true;
    const msg = String(message || "").trim().toLowerCase();
    if (msg === "invalid token." || msg === "invalid token") return true;
    if (msg === "token expired") return true;
    return false;
  }
  return false;
}

async function trySilentRefresh() {
  if (refreshInFlight) return refreshInFlight;

  refreshInFlight = (async () => {
    try {
      const response = await fetch(`${apiBase()}/api/auth/refresh`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });

      if (!response.ok) return false;

      let data = {};
      try {
        data = await response.json();
      } catch {
        return false;
      }

      return applySessionResponse(data, { response });
    } catch (error) {
      console.warn("[auth] Silent refresh failed:", error);
      return false;
    } finally {
      refreshInFlight = null;
    }
  })();

  return refreshInFlight;
}

function injectAuthHeader(init = {}) {
  const token = getAuthToken();
  const headers = new Headers(init.headers || {});
  if (token) {
    headers.set("x-auth-token", token);
  }
  return {
    ...init,
    headers,
    credentials: init.credentials || "include",
  };
}

function ensureStyles() {
  if (document.getElementById("auth-session-styles")) return;
  const style = document.createElement("style");
  style.id = "auth-session-styles";
  style.textContent = `
    #token-expired-banner, #session-reauth-modal, #session-proactive-banner {
      font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
    }
    #session-proactive-banner {
      position: fixed;
      top: 16px;
      left: 50%;
      transform: translateX(-50%);
      z-index: 99990;
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 12px 16px;
      border-radius: 12px;
      background: rgba(30, 30, 40, 0.95);
      color: #fff;
      box-shadow: 0 12px 32px rgba(0,0,0,0.35);
      max-width: min(520px, 92vw);
    }
    #session-proactive-banner button {
      border: 0;
      border-radius: 8px;
      padding: 8px 12px;
      cursor: pointer;
      font-weight: 600;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: #fff;
    }
    #session-proactive-banner .session-proactive-dismiss {
      background: transparent;
      color: rgba(255,255,255,0.7);
      font-weight: 500;
    }
    #session-reauth-modal {
      position: fixed;
      inset: 0;
      z-index: 100000;
      display: flex;
      align-items: center;
      justify-content: center;
      background: rgba(10, 10, 16, 0.55);
      backdrop-filter: blur(6px);
      -webkit-backdrop-filter: blur(6px);
      padding: 16px;
    }
    #session-reauth-modal .session-reauth-panel {
      width: min(420px, 100%);
      background: rgba(28, 28, 36, 0.98);
      color: #fff;
      border-radius: 16px;
      padding: 24px;
      box-shadow: 0 24px 48px rgba(0,0,0,0.45);
      border: 1px solid rgba(255,255,255,0.08);
    }
    #session-reauth-modal h2 {
      margin: 0 0 8px;
      font-size: 1.15rem;
      font-weight: 600;
    }
    #session-reauth-modal p {
      margin: 0 0 16px;
      color: rgba(255,255,255,0.75);
      font-size: 0.92rem;
      line-height: 1.4;
    }
    #session-reauth-modal label {
      display: block;
      font-size: 0.8rem;
      color: rgba(255,255,255,0.65);
      margin-bottom: 4px;
    }
    #session-reauth-modal input {
      width: 100%;
      box-sizing: border-box;
      margin-bottom: 12px;
      padding: 10px 12px;
      border-radius: 8px;
      border: 1px solid rgba(255,255,255,0.15);
      background: rgba(0,0,0,0.25);
      color: #fff;
      font-size: 0.95rem;
    }
    #session-reauth-modal .session-reauth-error {
      color: #ff8e8e;
      font-size: 0.85rem;
      min-height: 1.2em;
      margin: 0 0 10px;
    }
    #session-reauth-modal .session-reauth-actions {
      display: flex;
      gap: 8px;
      justify-content: flex-end;
      margin-top: 8px;
    }
    #session-reauth-modal button {
      border: 0;
      border-radius: 8px;
      padding: 10px 14px;
      cursor: pointer;
      font-weight: 600;
    }
    #session-reauth-modal .session-reauth-primary {
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: #fff;
    }
    #session-reauth-modal .session-reauth-secondary {
      background: transparent;
      color: rgba(255,255,255,0.7);
    }
    #session-reauth-modal button:disabled {
      opacity: 0.6;
      cursor: not-allowed;
    }
  `;
  document.head.appendChild(style);
}

function hideProactiveBanner() {
  proactiveBannerEl?.remove();
  proactiveBannerEl = null;
}

function showProactiveBanner() {
  if (isLoginLikePage() || reauthModalOpen) return;
  ensureStyles();
  if (proactiveBannerEl) return;

  const banner = document.createElement("div");
  banner.id = "session-proactive-banner";
  banner.setAttribute("role", "status");
  banner.innerHTML = `
    <span>Your session will expire soon. Stay signed in to keep working.</span>
    <button type="button" data-session-stay>Stay signed in</button>
    <button type="button" class="session-proactive-dismiss" data-session-dismiss aria-label="Dismiss">Dismiss</button>
  `;
  banner.querySelector("[data-session-stay]")?.addEventListener("click", async () => {
    const ok = await trySilentRefresh();
    if (ok) {
      hideProactiveBanner();
    } else {
      hideProactiveBanner();
      await promptReLogin({ message: "Please sign in again to continue." });
    }
  });
  banner.querySelector("[data-session-dismiss]")?.addEventListener("click", () => {
    hideProactiveBanner();
  });
  document.body.appendChild(banner);
  proactiveBannerEl = banner;
}

function resolveReauthWaiters(success) {
  const waiters = reauthResolvers.slice();
  reauthResolvers = [];
  waiters.forEach((resolve) => resolve(success));
}

/**
 * Soft re-login modal — does not navigate away or wipe the SPA.
 * Open work (email compose, etc.) stays in the DOM.
 */
function promptReLogin({ message } = {}) {
  if (isLoginLikePage()) {
    return Promise.resolve(false);
  }

  if (reauthModalOpen) {
    return new Promise((resolve) => {
      reauthResolvers.push(resolve);
    });
  }

  reauthModalOpen = true;
  ensureStyles();
  hideProactiveBanner();

  return new Promise((resolve) => {
    reauthResolvers.push(resolve);

    const existing = document.getElementById("session-reauth-modal");
    existing?.remove();

    const emailPrefill = getCookie("email") || "";
    const modal = document.createElement("div");
    modal.id = "session-reauth-modal";
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-modal", "true");
    modal.setAttribute("aria-label", "Sign in again");
    modal.innerHTML = `
      <div class="session-reauth-panel">
        <h2>Session expired</h2>
        <p>${escapeHtml(
          message ||
            "Sign in again to continue. Your unsaved work on this page is still here.",
        )}</p>
        <form id="session-reauth-form" autocomplete="on">
          <label for="session-reauth-email">Email</label>
          <input id="session-reauth-email" name="email" type="email" required value="${escapeAttr(
            emailPrefill,
          )}" autocomplete="username" />
          <label for="session-reauth-password">Password</label>
          <input id="session-reauth-password" name="password" type="password" required autocomplete="current-password" />
          <div class="session-reauth-error" id="session-reauth-error" aria-live="polite"></div>
          <div class="session-reauth-actions">
            <button type="button" class="session-reauth-secondary" data-reauth-login-page>Full login page</button>
            <button type="submit" class="session-reauth-primary" data-reauth-submit>Sign in</button>
          </div>
        </form>
      </div>
    `;

    const form = modal.querySelector("#session-reauth-form");
    const errorEl = modal.querySelector("#session-reauth-error");
    const submitBtn = modal.querySelector("[data-reauth-submit]");
    const passwordInput = modal.querySelector("#session-reauth-password");

    modal.querySelector("[data-reauth-login-page]")?.addEventListener("click", () => {
      // Preserve work in local drafts; navigate only if user chooses
      try {
        sessionStorage.setItem(
          "postLoginReturn",
          window.location.pathname + window.location.search + window.location.hash,
        );
      } catch {
        // ignore
      }
      cleanup(false);
      window.location.href = LOGIN_PATH;
    });

    form?.addEventListener("submit", async (event) => {
      event.preventDefault();
      const email = modal.querySelector("#session-reauth-email")?.value?.trim();
      const password = passwordInput?.value || "";
      if (!email || !password) return;

      submitBtn.disabled = true;
      if (errorEl) errorEl.textContent = "";

      try {
        const response = await fetch(`${apiBase()}/api/auth`, {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email, password }),
        });

        let data = {};
        try {
          data = await response.json();
        } catch {
          // ignore
        }

        if (!response.ok) {
          if (errorEl) {
            if (data.code === "EMAIL_NOT_VERIFIED") {
              const help = email
                ? `/verify.html?email=${encodeURIComponent(email)}`
                : "/verify.html";
              errorEl.innerHTML = `${escapeHtml(
                data.message ||
                  "Please verify your email before signing in. Check your inbox and spam folder.",
              )} <a href="${escapeAttr(help)}" style="color:inherit">Resend the link</a>`;
            } else {
              errorEl.textContent =
                data.message ||
                data.error ||
                "Could not sign in. Check your email and password.";
            }
          }
          submitBtn.disabled = false;
          return;
        }

        applySessionResponse(data, { response });
        cleanup(true);
      } catch (error) {
        if (errorEl) {
          errorEl.textContent = "Network error. Please try again.";
        }
        submitBtn.disabled = false;
      }
    });

    function cleanup(success) {
      reauthModalOpen = false;
      modal.remove();
      resolveReauthWaiters(Boolean(success));
    }

    const mount = () => {
      document.body.appendChild(modal);
      passwordInput?.focus();
    };
    if (document.body) mount();
    else document.addEventListener("DOMContentLoaded", mount, { once: true });
  });
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/'/g, "&#39;");
}

/**
 * Recover session: silent refresh, then soft re-login.
 * @returns {Promise<boolean>}
 */
async function recoverSession({ message } = {}) {
  const refreshed = await trySilentRefresh();
  if (refreshed) return true;
  return promptReLogin({ message });
}

/**
 * Ensure we have a non-expired access token when possible.
 */
async function ensureValidSession() {
  const token = getAuthToken();
  const expMs = getAccessExpiresAtMs();
  if (token && expMs && expMs - Date.now() > REFRESH_SKEW_MS) {
    return true;
  }
  // Try refresh even if cookie missing (httpOnly refresh may still be valid)
  return trySilentRefresh();
}

/**
 * Called by feature code after a response. Prefer the fetch interceptor for recovery.
 * Returns true when the caller should abort (auth failure for this response).
 * The interceptor already attempts silent refresh + re-login + retry, so this is
 * mostly a signal for call sites to stop processing a still-failed response.
 */
async function handleExpiredToken(response) {
  if (!response) return false;
  if (!(await isAuthFailureResponse(response))) return false;

  // Interceptor may already be recovering; wait if so
  if (refreshInFlight) {
    await refreshInFlight;
    return true;
  }

  if (reauthModalOpen) {
    await new Promise((resolve) => {
      reauthResolvers.push(resolve);
    });
    return true;
  }

  // Cooldown: interceptor just finished a re-auth attempt for this response
  if (Date.now() - lastReauthAttemptAt < REAUTH_COOLDOWN_MS) {
    return true;
  }

  if (tokenExpiryHandled) return true;

  lastReauthAttemptAt = Date.now();
  const recovered = await recoverSession();
  if (recovered) {
    tokenExpiryHandled = false;
    return true;
  }
  tokenExpiryHandled = true;
  return true;
}

/**
 * Soft notice used only when we must leave the app (login pages).
 * Does not hard-redirect mid-work when re-login is available.
 */
function showExpiryNoticeAndRedirect(message = DEFAULT_EXPIRY_MESSAGE) {
  if (typeof window === "undefined") return;

  if (isLoginLikePage()) {
    clearAuthState({ hard: true });
    return;
  }

  // Prefer in-place re-login over redirect so work is not lost
  promptReLogin({ message });
}

function installFetchInterceptor() {
  if (typeof window === "undefined" || typeof window.fetch !== "function") {
    return;
  }
  if (window.fetch.__tokenExpiryWrapped) return;

  const originalFetch = window.fetch.bind(window);

  const wrappedFetch = async (input, init = {}) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof Request
          ? input.url
          : String(input);

    // Always send cookies for API so refresh httpOnly cookie is included
    const isApi = /\/api\//.test(url) || url.startsWith(apiBase());
    let requestInit = { ...init };
    if (isApi && !requestInit.credentials) {
      requestInit.credentials = "include";
    }

    // Attach current access token if caller omitted it
    if (isApi && !isRefreshUrl(url) && !isLogoutUrl(url)) {
      const headers = new Headers(requestInit.headers || {});
      if (!headers.has("x-auth-token")) {
        const token = getAuthToken();
        if (token) headers.set("x-auth-token", token);
      }
      requestInit.headers = headers;
    }

    let response = await originalFetch(input, requestInit);

    if (isRefreshUrl(url) || isLogoutUrl(url) || isLoginLikePage()) {
      return response;
    }

    if (!(await isAuthFailureResponse(response))) {
      return response;
    }

    lastReauthAttemptAt = Date.now();

    // Attempt silent refresh + single retry
    const refreshed = await trySilentRefresh();
    if (refreshed) {
      response = await originalFetch(input, injectAuthHeader(requestInit));
      if (!(await isAuthFailureResponse(response))) {
        tokenExpiryHandled = false;
        return response;
      }
    }

    // Soft re-login then retry once more
    const restored = await promptReLogin({
      message:
        "Your session expired while you were working. Sign in again — your open work is still on this page.",
    });
    lastReauthAttemptAt = Date.now();
    if (restored) {
      tokenExpiryHandled = false;
      response = await originalFetch(input, injectAuthHeader(requestInit));
    } else {
      tokenExpiryHandled = true;
    }

    return response;
  };

  wrappedFetch.__tokenExpiryWrapped = true;
  window.fetch = wrappedFetch;
}

function startSessionMaintenance() {
  if (sessionMaintenanceStarted || typeof window === "undefined") return;
  sessionMaintenanceStarted = true;

  const activityEvents = [
    "pointerdown",
    "keydown",
    "scroll",
    "touchstart",
    "mousemove",
  ];
  let activityThrottle = null;
  const onActivity = () => {
    if (activityThrottle) return;
    activityThrottle = setTimeout(() => {
      activityThrottle = null;
      markUserActivity();
    }, 5000);
    markUserActivity();
  };
  activityEvents.forEach((evt) => {
    window.addEventListener(evt, onActivity, { passive: true, capture: true });
  });

  // Periodic check: proactive refresh / warning
  setInterval(async () => {
    if (isLoginLikePage() || reauthModalOpen) return;
    const expMs = getAccessExpiresAtMs();
    if (!expMs) {
      // No known expiry — try refresh if we might still have refresh cookie
      if (userIsRecentlyActive() && !getAuthToken()) {
        await trySilentRefresh();
      }
      return;
    }
    const remaining = expMs - Date.now();
    if (remaining <= REFRESH_SKEW_MS && userIsRecentlyActive()) {
      await trySilentRefresh();
      return;
    }
    if (remaining > 0 && remaining <= PROACTIVE_WARN_MS && !userIsRecentlyActive()) {
      showProactiveBanner();
    } else if (remaining > PROACTIVE_WARN_MS) {
      hideProactiveBanner();
    }
  }, 30_000);

  // On tab focus, ensure session is still valid
  document.addEventListener("visibilitychange", async () => {
    if (document.visibilityState !== "visible") return;
    if (isLoginLikePage()) return;
    markUserActivity();
    const expMs = getAccessExpiresAtMs();
    if (!expMs || expMs - Date.now() < REFRESH_SKEW_MS * 2) {
      await trySilentRefresh();
    }
  });
}

if (typeof window !== "undefined") {
  installFetchInterceptor();
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", startSessionMaintenance, {
      once: true,
    });
  } else {
    startSessionMaintenance();
  }
}

export {
  handleExpiredToken,
  showExpiryNoticeAndRedirect,
  getAuthToken,
  setAccessToken,
  applySessionResponse,
  clearAuthState,
  ensureValidSession,
  trySilentRefresh,
  recoverSession,
  promptReLogin,
  persistProfileCookies,
  getAccessExpiresAtMs,
  markUserActivity,
};
