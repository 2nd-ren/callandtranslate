import { applySessionResponse } from "./auth.js";

const form = document.getElementById("resetForm");
const msg = document.getElementById("formMsg");
const token = new URLSearchParams(location.search).get("token") || "";

form?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const password = document.getElementById("password").value;
  const response = await fetch(`${AppConfig.apiBaseUrl}/api/users/reset`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token, password }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    msg.className = "notice error";
    msg.textContent = data.message || "Reset failed.";
    msg.hidden = false;
    return;
  }
  applySessionResponse(data, { response });
  window.location.href = "/app.html";
});
