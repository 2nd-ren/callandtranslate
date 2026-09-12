import { applySessionResponse } from "./auth.js";
import { requestedPlan, subscribeIfRequested } from "./billing.js";
import { armResendCooldown, resendVerificationEmail } from "./verification.js";
import { captureInviteToken, postAuthRedirect, readInviteToken } from "./invite.js";

const titleEl = document.getElementById("verifyTitle");
const msgEl = document.getElementById("verifyMsg");
const spamEl = document.getElementById("spamCallout");
const stepsEl = document.getElementById("verifySteps");
const formEl = document.getElementById("resendForm");
const emailField = document.getElementById("emailField");
const emailInput = document.getElementById("resendEmail");
const resendMsg = document.getElementById("resendMsg");
const resendBtn = document.getElementById("resendBtn");
const continueEl = document.getElementById("verifyContinue");

readInviteToken();
captureInviteToken(new URLSearchParams(location.search).get("invite") || "");

const params = new URLSearchParams(location.search);
const token = params.get("token") || "";
const emailParam = (params.get("email") || "").trim();
const sentFlag = params.get("sent");
const existing = params.get("existing") === "1";

function setNotice(el, text, kind = "") {
  if (!el) return;
  const value = String(text || "").trim();
  el.hidden = !value;
  el.textContent = value;
  el.className = kind ? `notice ${kind}` : "notice";
}

function showPending({ email, sent = true, existingAccount = false } = {}) {
  const address = email || "your email";
  if (titleEl) titleEl.textContent = existingAccount ? "Verify to finish signing in" : "Check your email";
  if (msgEl) {
    msgEl.innerHTML = existingAccount
      ? `An account for <span class="auth-email">${escapeHtml(address)}</span> is waiting to be verified. Open the link we sent — that signs you in.`
      : `We sent a verification link to <span class="auth-email">${escapeHtml(address)}</span>. Open it to finish creating your account and sign in.`;
  }
  if (spamEl) {
    spamEl.hidden = false;
    spamEl.innerHTML = sent
      ? `Check your <strong>spam or junk folder</strong> if you don’t see it in your inbox. The link expires in 15 minutes.`
      : `We couldn’t send the email just now. Use the button below, then check your inbox and <strong>spam or junk folder</strong>.`;
  }
  if (stepsEl) stepsEl.hidden = false;
  if (formEl) formEl.hidden = false;
  if (continueEl) continueEl.hidden = true;
  if (emailInput && email) emailInput.value = email;
  if (emailField) emailField.hidden = Boolean(email);
  if (sent && email) armResendCooldown(resendBtn);
}

function showWorking() {
  if (titleEl) titleEl.textContent = "Verifying your email";
  if (msgEl) msgEl.textContent = "Checking your link…";
  if (spamEl) spamEl.hidden = true;
  if (stepsEl) stepsEl.hidden = true;
  if (formEl) formEl.hidden = true;
  if (continueEl) continueEl.hidden = true;
}

function showSuccess(message) {
  if (titleEl) titleEl.textContent = "You're verified";
  if (msgEl) msgEl.textContent = message || "Email verified. Signing you in…";
  if (spamEl) spamEl.hidden = true;
  if (stepsEl) stepsEl.hidden = true;
  if (formEl) formEl.hidden = true;
  if (continueEl) continueEl.hidden = false;
}

function showFailed(message) {
  if (titleEl) titleEl.textContent = "This link didn’t work";
  if (msgEl) msgEl.textContent = message || "Request a new verification email below.";
  if (spamEl) {
    spamEl.hidden = false;
    spamEl.innerHTML =
      `Check your <strong>spam or junk folder</strong> for a newer email, or resend a link. The new link expires in 15 minutes.`;
  }
  if (stepsEl) stepsEl.hidden = true;
  if (formEl) formEl.hidden = false;
  if (continueEl) continueEl.hidden = true;
  if (emailField) emailField.hidden = false;
  if (emailInput && emailParam) emailInput.value = emailParam;
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function finishSignIn(data, response) {
  applySessionResponse(data, { response });
  showSuccess(data.message || "Email verified. Signing you in…");
  try {
    const checkout = await subscribeIfRequested(data.token || data.authToken);
    if (checkout?.url) {
      if (msgEl) msgEl.textContent = "Email verified. Continuing to checkout…";
      window.location.href = checkout.url;
      return;
    }
  } catch {
    // stay on Free; they can retry from pricing
  }
  window.setTimeout(() => {
    window.location.href = postAuthRedirect();
  }, 700);
}

formEl?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const email = emailInput?.value?.trim();
  if (!email) {
    setNotice(resendMsg, "Enter the email you registered with.", "error");
    return;
  }
  resendBtn.disabled = true;
  setNotice(resendMsg, "Sending…");
  try {
    const { ok, status, data } = await resendVerificationEmail(email);
    setNotice(
      resendMsg,
      data.message ||
        (ok
          ? "Verification email sent. Check your inbox and spam folder."
          : "Could not send the email just now."),
      ok ? "ok" : "error",
    );
    if (ok || status === 429) {
      armResendCooldown(resendBtn, data.retryAfterMs || 60_000);
    } else {
      resendBtn.disabled = false;
    }
  } catch {
    setNotice(resendMsg, "Network error. Try again.", "error");
    resendBtn.disabled = false;
  }
});

(async () => {
  if (requestedPlan() === "pro") {
    const signIn = document.querySelector('.auth-links a[href="/"]');
    const other = document.querySelector('.auth-links a[href="/register.html"]');
    if (signIn) signIn.setAttribute("href", "/index.html?plan=pro#login");
    if (other) other.setAttribute("href", "/register.html?plan=pro");
  }

  if (token) {
    showWorking();
    try {
      const response = await fetch(
        `${AppConfig.apiBaseUrl}/api/users/verify-email?token=${encodeURIComponent(token)}`,
        { credentials: "include" },
      );
      const data = await response.json().catch(() => ({}));
      if (response.ok) {
        await finishSignIn(data, response);
        return;
      }
      showFailed(data.message || "Could not verify this link.");
    } catch {
      showFailed("Network error. Request a new verification email below.");
    }
    return;
  }

  if (emailParam || existing) {
    showPending({
      email: emailParam,
      sent: sentFlag !== "0",
      existingAccount: existing,
    });
    return;
  }

  if (titleEl) titleEl.textContent = "Verify your email";
  if (msgEl) {
    msgEl.textContent =
      "New accounts sign in from the verification email. Enter your address to send a new link, then check your inbox and spam folder.";
  }
  if (stepsEl) stepsEl.hidden = true;
})();
