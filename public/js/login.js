import { applySessionResponse } from "./auth.js";
import { requestedPlan, subscribeIfRequested } from "./billing.js";
import {
  armResendCooldown,
  resendVerificationEmail,
  verifyPageUrl,
} from "./verification.js";
import { postAuthRedirect, readInviteToken, withInviteParam } from "./invite.js";

readInviteToken();
const registerLink = document.querySelector('.auth-links a[href="/register.html"]');
if (registerLink) registerLink.setAttribute("href", withInviteParam("/register.html"));

const form = document.getElementById("loginForm");
const errorEl = document.getElementById("loginError");
const unverifiedEl = document.getElementById("unverifiedNotice");
const unverifiedText = document.getElementById("unverifiedText");
const unverifiedLink = document.getElementById("unverifiedHelpLink");
const loginResendBtn = document.getElementById("loginResendBtn");
const verifyHint = document.querySelector(".auth-verify-hint a");
const emailInput = document.getElementById("email");

function syncVerifyLinks() {
  const email = emailInput?.value?.trim() || "";
  const href = verifyPageUrl({ email, plan: requestedPlan() });
  if (verifyHint) verifyHint.href = href;
  if (unverifiedLink) unverifiedLink.href = href;
}

emailInput?.addEventListener("input", syncVerifyLinks);
syncVerifyLinks();

function hideUnverified() {
  if (unverifiedEl) unverifiedEl.hidden = true;
}

function showUnverified(email, message, { cooldownMs } = {}) {
  if (errorEl) errorEl.hidden = true;
  if (unverifiedText) {
    unverifiedText.textContent =
      message || "Please verify your email before signing in.";
  }
  if (unverifiedLink) {
    unverifiedLink.href = verifyPageUrl({ email, plan: requestedPlan() });
  }
  if (unverifiedEl) unverifiedEl.hidden = false;
  if (loginResendBtn) {
    loginResendBtn.dataset.email = email || "";
    const wait = Number.isFinite(Number(cooldownMs)) ? Number(cooldownMs) : 60_000;
    armResendCooldown(loginResendBtn, wait);
  }
}

loginResendBtn?.addEventListener("click", async () => {
  const email =
    loginResendBtn.dataset.email ||
    document.getElementById("email")?.value?.trim() ||
    "";
  if (!email) return;
  loginResendBtn.disabled = true;
  try {
    const { ok, status, data } = await resendVerificationEmail(email);
    if (unverifiedText) {
      unverifiedText.textContent =
        data.message ||
        (ok
          ? "Verification email sent. Check your inbox and spam folder."
          : "Could not send the email just now.");
    }
    if (ok || status === 429) {
      armResendCooldown(loginResendBtn, data.retryAfterMs || 60_000);
    } else {
      loginResendBtn.disabled = false;
    }
  } catch {
    if (unverifiedText) unverifiedText.textContent = "Network error. Try again.";
    loginResendBtn.disabled = false;
  }
});

async function enterApp(data, response) {
  applySessionResponse(data, { response });
  try {
    const checkout = await subscribeIfRequested(data.token);
    if (checkout?.url) {
      window.location.href = checkout.url;
      return;
    }
  } catch {
    // stay on current plan
  }
  window.location.href = postAuthRedirect();
}

document.getElementById("passkeyLoginBtn")?.addEventListener("click", async () => {
  errorEl.hidden = true;
  hideUnverified();
  try {
    const email = document.getElementById("email")?.value?.trim() || "";
    const optionsRes = await fetch(`${AppConfig.apiBaseUrl}/api/passkeys/login-options`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    });
    if (!optionsRes.ok) {
      errorEl.textContent = "Unable to start passkey sign-in.";
      errorEl.hidden = false;
      return;
    }
    const options = await optionsRes.json();
    const challengeEmail = options._challengeEmail;
    delete options._challengeEmail;
    const startAuthentication = window.SimpleWebAuthnBrowser?.startAuthentication;
    if (!startAuthentication) {
      errorEl.textContent = "Passkeys are not available in this browser.";
      errorEl.hidden = false;
      return;
    }
    const credential = await startAuthentication({ optionsJSON: options });
    const verifyRes = await fetch(`${AppConfig.apiBaseUrl}/api/passkeys/login-verify`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ credential, email: challengeEmail }),
    });
    const data = await verifyRes.json().catch(() => ({}));
    if (data.code === "EMAIL_NOT_VERIFIED") {
      showUnverified(data.email || email || challengeEmail, data.message, {
        cooldownMs: data.emailSent ? 60_000 : Number(data.retryAfterMs) || 0,
      });
      return;
    }
    if (!verifyRes.ok || !data.token) {
      errorEl.textContent = data.message || "Passkey sign-in failed.";
      errorEl.hidden = false;
      return;
    }
    await enterApp(data, verifyRes);
  } catch (err) {
    if (err.name === "NotAllowedError" || err.name === "AbortError") return;
    errorEl.textContent = err.message || "Passkey sign-in failed.";
    errorEl.hidden = false;
  }
});

form?.addEventListener("submit", async (event) => {
  event.preventDefault();
  errorEl.hidden = true;
  hideUnverified();
  const email = document.getElementById("email").value.trim();
  const password = document.getElementById("password").value;
  try {
    const response = await fetch(`${AppConfig.apiBaseUrl}/api/auth`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    const data = await response.json().catch(() => ({}));
    if (data.code === "EMAIL_NOT_VERIFIED") {
      showUnverified(data.email || email, data.message, {
        cooldownMs: data.emailSent ? 60_000 : Number(data.retryAfterMs) || 0,
      });
      return;
    }
    if (!response.ok) {
      errorEl.textContent = data.message || data.error || "Could not sign in.";
      errorEl.hidden = false;
      return;
    }
    await enterApp(data, response);
  } catch {
    errorEl.textContent = "Network error. Try again.";
    errorEl.hidden = false;
  }
});
