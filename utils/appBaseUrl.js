import config from "config";

export function getAppBaseUrl(req) {
  const fromEnv = String(
    process.env.PUBLIC_APP_URL || process.env.BASE_URL || "",
  ).replace(/\/+$/, "");
  if (fromEnv) return fromEnv;
  if (config.has("baseUrl")) {
    const fromConfig = String(config.get("baseUrl") || "").replace(/\/+$/, "");
    if (fromConfig) return fromConfig;
  }
  if (req) {
    const protoHeader =
      req.get?.("x-forwarded-proto") || req.headers?.["x-forwarded-proto"] || "";
    const proto = String(protoHeader || req.protocol || "https")
      .split(",")[0]
      .trim();
    const hostHeader =
      req.get?.("x-forwarded-host") ||
      req.headers?.["x-forwarded-host"] ||
      req.get?.("host") ||
      req.headers?.host ||
      "";
    const host = String(hostHeader).split(",")[0].trim();
    if (host) return `${proto || "https"}://${host}`;
  }
  return "https://callandtranslate.com";
}

export function publicShareUrl(baseUrl, kind, tokenOrSlug) {
  const origin = String(baseUrl || "").replace(/\/+$/, "");
  if (kind === "short") return `${origin}/s/${encodeURIComponent(tokenOrSlug)}`;
  return `${origin}/v/${encodeURIComponent(tokenOrSlug)}`;
}
