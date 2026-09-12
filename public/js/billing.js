import { getAuthToken } from "./auth.js";

function apiBase() {
  return String(AppConfig?.apiBaseUrl || "").replace(/\/+$/, "");
}

export function requestedPlan() {
  try {
    return String(new URLSearchParams(window.location.search).get("plan") || "")
      .trim()
      .toLowerCase();
  } catch {
    return "";
  }
}

export async function startCreditTopUpCheckout(packs = 1, token) {
  const auth = token || getAuthToken();
  const response = await fetch(`${apiBase()}/api/subscriptions/create-credit-topup-session`, {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...(auth ? { "x-auth-token": auth } : {}),
    },
    body: JSON.stringify({ packs }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const err = new Error(data.message || data.error || "Could not start checkout.");
    err.status = response.status;
    err.code = data.code;
    err.data = data;
    throw err;
  }
  return data;
}

export async function startProCheckout(token) {
  const auth = token || getAuthToken();
  const response = await fetch(`${apiBase()}/api/subscriptions/create-checkout-session`, {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...(auth ? { "x-auth-token": auth } : {}),
    },
    body: JSON.stringify({ plan: "pro" }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const err = new Error(data.message || data.error || "Could not start checkout.");
    err.status = response.status;
    err.code = data.code;
    err.data = data;
    throw err;
  }
  return data;
}

export async function subscribeToPro(token) {
  return startProCheckout(token);
}

export async function subscribeIfRequested(token) {
  if (requestedPlan() !== "pro") return null;
  return startProCheckout(token);
}

export async function cancelSubscription(token) {
  const auth = token || getAuthToken();
  const response = await fetch(`${apiBase()}/api/subscriptions/cancel`, {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...(auth ? { "x-auth-token": auth } : {}),
    },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.message || data.error || "Could not cancel.");
  }
  return data;
}

export async function reactivateSubscription(token) {
  const auth = token || getAuthToken();
  const response = await fetch(`${apiBase()}/api/subscriptions/reactivate`, {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...(auth ? { "x-auth-token": auth } : {}),
    },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.message || data.error || "Could not reactivate.");
  }
  return data;
}

export async function openBillingPortal(token) {
  const auth = token || getAuthToken();
  const response = await fetch(`${apiBase()}/api/subscriptions/create-portal-session`, {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...(auth ? { "x-auth-token": auth } : {}),
    },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.message || data.error || "Could not open billing portal.");
  }
  return data;
}
