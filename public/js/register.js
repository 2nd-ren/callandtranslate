import { requestedPlan } from "./billing.js";
import { verifyPageUrl } from "./verification.js";
import { readInviteToken, withInviteParam } from "./invite.js";

readInviteToken();
if (requestedPlan() === "pro") {
  const signIn = document.querySelector(".auth-links a");
  if (signIn) signIn.setAttribute("href", withInviteParam("/index.html?plan=pro#login"));
  const sub = document.querySelector(".auth-card .sub");
  if (sub && !readInviteToken()) {
    sub.innerHTML =
      "You’ll start on Free until checkout completes. Paid is £12 a month and adds one hour of call time that expires 30 days after it is added. <a href=\"/pricing.html#how-credits-work\">How call time works</a>.";
  }
}

const inviteToken = readInviteToken();
if (inviteToken) {
  const sub = document.querySelector(".auth-card .sub");
  if (sub) {
    sub.textContent =
      "Create a free account to continue — check spam if you don’t see the verification email.";
  }
  const signIn = document.querySelector('.auth-links a[href="/"]');
  if (signIn) signIn.setAttribute("href", withInviteParam("/"));
}

const form = document.getElementById("registerForm");
const errorEl = document.getElementById("formError");

form?.addEventListener("submit", async (event) => {
  event.preventDefault();
  errorEl.hidden = true;
  if (!document.getElementById("termsAccepted")?.checked) {
    errorEl.textContent = "You must accept the Terms of Service and Privacy Policy.";
    errorEl.hidden = false;
    return;
  }
  const body = {
    name: document.getElementById("name").value.trim(),
    email: document.getElementById("email").value.trim(),
    password: document.getElementById("password").value,
    termsAccepted: true,
    legalVersion: document.getElementById("termsAccepted")?.dataset.legalVersion || "",
  };
  if (requestedPlan() === "pro") body.plan = "pro";
  try {
    const response = await fetch(`${AppConfig.apiBaseUrl}/api/users`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (data.code === "EMAIL_TAKEN_UNVERIFIED") {
        window.location.href = verifyPageUrl({
          email: body.email,
          plan: requestedPlan(),
          sent: Boolean(data.emailSent) || Number(data.retryAfterMs) > 0,
          existing: true,
        });
        return;
      }
      errorEl.textContent = data.message || data.error || "Could not create account.";
      errorEl.hidden = false;
      return;
    }
    window.location.href = verifyPageUrl({
      email: body.email,
      plan: requestedPlan(),
      sent: data.emailSent !== false,
    });
  } catch {
    errorEl.textContent = "Network error. Try again.";
    errorEl.hidden = false;
  }
});
