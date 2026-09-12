const KEY = "showdoclive_invite";

export function captureInviteToken(token) {
  const value = String(token || "").trim();
  if (!value) return "";
  try {
    sessionStorage.setItem(KEY, value);
  } catch {
    // ignore
  }
  return value;
}

export function readInviteToken() {
  const params = new URLSearchParams(location.search);
  const fromQuery = String(params.get("invite") || "").trim();
  if (fromQuery) return captureInviteToken(fromQuery);
  try {
    return String(sessionStorage.getItem(KEY) || "").trim();
  } catch {
    return "";
  }
}

export function clearInviteToken() {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    // ignore
  }
}

export function withInviteParam(url) {
  const token = readInviteToken();
  if (!token) return url;
  const next = new URL(url, location.origin);
  next.searchParams.set("invite", token);
  return `${next.pathname}${next.search}${next.hash}`;
}

export function postAuthRedirect() {
  const token = readInviteToken();
  if (token) return `/c/${encodeURIComponent(token)}`;
  return "/app.html";
}
