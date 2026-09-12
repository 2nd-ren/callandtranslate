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

export async function resendVerificationEmail(email) {
  const response = await fetch(`${apiBase()}/api/users/resend-verification`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: String(email || "").trim() }),
  });
  const data = await response.json().catch(() => ({}));
  return { ok: response.ok, status: response.status, data };
}

export function armResendCooldown(button, ms = 60_000) {
  if (!button) return;
  const original = button.dataset.label || button.textContent || "Resend verification email";
  button.dataset.label = original;
  const until = Date.now() + Math.max(0, Number(ms) || 0);
  if (until <= Date.now()) {
    button.disabled = false;
    button.textContent = original;
    return;
  }
  button.disabled = true;
  const tick = () => {
    const left = Math.ceil((until - Date.now()) / 1000);
    if (left <= 0) {
      button.disabled = false;
      button.textContent = original;
      return;
    }
    button.textContent = `Resend available in ${left}s`;
    window.setTimeout(tick, 250);
  };
  tick();
}

export function verifyPageUrl({ email, plan, sent, existing, invite } = {}) {
  const params = new URLSearchParams();
  if (email) params.set("email", email);
  if (plan === "pro") params.set("plan", "pro");
  if (sent === false || sent === "0") params.set("sent", "0");
  if (existing) params.set("existing", "1");
  let inviteToken = invite;
  if (!inviteToken) {
    try {
      inviteToken = new URLSearchParams(location.search).get("invite") || "";
      if (!inviteToken) inviteToken = sessionStorage.getItem("showdoclive_invite") || "";
    } catch {
      inviteToken = "";
    }
  }
  if (inviteToken) params.set("invite", inviteToken);
  const query = params.toString();
  return query ? `/verify.html?${query}` : "/verify.html";
}
