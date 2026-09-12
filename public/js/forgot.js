const form = document.getElementById("forgotForm");
const msg = document.getElementById("formMsg");

form?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const email = document.getElementById("email").value.trim();
  const response = await fetch(`${AppConfig.apiBaseUrl}/api/users/send-reset-link`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email }),
  });
  const data = await response.json().catch(() => ({}));
  msg.textContent = data.message || "If an account exists, a link is on its way.";
  msg.hidden = false;
});
