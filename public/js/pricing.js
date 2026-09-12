import { getAuthToken } from "./auth.js";
import { startProCheckout, startCreditTopUpCheckout } from "./billing.js";
import {
  creditExplainerHtml,
  creditCalculatorHtml,
  creditTopUpHtml,
  mountCreditCalculator,
  mergeCreditRates,
} from "./creditCalculator.js";

const freeCta = document.querySelector("[data-free-cta]");
const proCta = document.querySelector("[data-pro-cta]");
const freeStatus = document.querySelector("[data-free-status]");
const proStatus = document.querySelector("[data-pro-status]");
const creditsStatus = document.querySelector("[data-credits-status]");

function showStatus(el, text) {
  if (!el) return;
  el.hidden = false;
  el.textContent = text;
}

async function loadPlans() {
  const response = await fetch(
    `${String(AppConfig?.apiBaseUrl || "").replace(/\/+$/, "")}/api/subscriptions/plans`,
    { credentials: "include" },
  );
  if (!response.ok) return null;
  return response.json().catch(() => null);
}

async function loadBilling() {
  const token = getAuthToken();
  if (!token) return null;
  const response = await fetch(
    `${String(AppConfig?.apiBaseUrl || "").replace(/\/+$/, "")}/api/billing/me`,
    {
      credentials: "include",
      headers: { "x-auth-token": token },
    },
  );
  if (!response.ok) return null;
  return response.json().catch(() => null);
}

function mountCreditsExplainer(rates, { loggedIn = false, topUpEnabled = false } = {}) {
  const explainer = document.getElementById("pricingExplainer");
  const calculator = document.getElementById("pricingCalculator");
  const topUp = document.getElementById("pricingTopUp");
  const merged = mergeCreditRates(rates);
  if (explainer) explainer.innerHTML = creditExplainerHtml(merged, { heading: false });
  if (calculator) {
    calculator.innerHTML = creditCalculatorHtml("pricing");
    mountCreditCalculator(calculator, merged);
  }
  if (topUp) {
    topUp.innerHTML = creditTopUpHtml(merged.topUp, { id: "pricingTopUpPacks" });
    const buy = topUp.querySelector("[data-buy-credits]");
    buy?.addEventListener("click", async () => {
      if (!loggedIn) {
        window.location.href = "/register.html?plan=pro";
        return;
      }
      const packs = Number(topUp.querySelector("[data-credit-packs]")?.value || 1);
      try {
        if (!topUpEnabled) {
          showStatus(creditsStatus, "Extra hours are not configured yet.");
          return;
        }
        showStatus(creditsStatus, "Opening checkout…");
        const session = await startCreditTopUpCheckout(packs);
        if (session.url) window.location.href = session.url;
      } catch (err) {
        showStatus(creditsStatus, err.message || "Could not start checkout.");
      }
    });
  }
}

const [plans, billing] = await Promise.all([loadPlans(), loadBilling()]);
const loggedIn = Boolean(getAuthToken());
mountCreditsExplainer(plans?.creditCalculator || billing?.creditCalculator, {
  loggedIn,
  topUpEnabled: Boolean(plans?.creditTopUpEnabled || billing?.creditTopUpEnabled),
});

if (loggedIn && billing?.plan === "pro") {
  if (proCta) {
    proCta.textContent = "You're on Paid";
    proCta.setAttribute("href", "/app.html");
  }
  showStatus(proStatus, "Manage billing from Settings in the app.");
}

proCta?.addEventListener("click", async (event) => {
  if (!loggedIn) return;
  event.preventDefault();
  try {
    if (plans && plans.checkoutEnabled === false) {
      showStatus(proStatus, "Checkout is not configured yet.");
      return;
    }
    showStatus(proStatus, "Opening checkout…");
    const session = await startProCheckout();
    if (session.url) window.location.href = session.url;
  } catch (err) {
    showStatus(proStatus, err.message || "Could not start checkout.");
  }
});

if (loggedIn && freeCta) {
  freeCta.setAttribute("href", "/app.html");
  freeCta.textContent = "Open the app";
}
