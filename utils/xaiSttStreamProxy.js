import config from "config";
import jwt from "jsonwebtoken";
import { WebSocket, WebSocketServer } from "ws";

const STT_PROXY_PATH = "/api/voice/stt/stream";
const XAI_STT_STREAM_URL = "wss://api.x.ai/v1/stt";

const ALLOWED_STT_PARAMS = new Set([
  "sample_rate",
  "encoding",
  "interim_results",
  "endpointing",
  "language",
  "multichannel",
  "channels",
  "diarize",
  "keyterm",
  "filler_words",
  "smart_turn",
  "smart_turn_timeout",
]);

function parseCookieHeader(cookieHeader = "") {
  const cookies = new Map();
  cookieHeader.split(";").forEach((entry) => {
    const separatorIndex = entry.indexOf("=");
    if (separatorIndex === -1) return;
    const name = entry.slice(0, separatorIndex).trim();
    const value = entry.slice(separatorIndex + 1).trim();
    if (!name) return;
    cookies.set(name, decodeURIComponent(value));
  });
  return cookies;
}

function getAuthToken(req, requestUrl) {
  const cookies = parseCookieHeader(req.headers.cookie || "");
  return (
    cookies.get("authToken") ||
    requestUrl.searchParams.get("token") ||
    req.headers["x-auth-token"] ||
    null
  );
}

function verifyRequest(req, requestUrl) {
  const token = getAuthToken(req, requestUrl);
  if (!token) return null;
  try {
    return jwt.verify(token, config.get("jwtPrivateKey"));
  } catch {
    return null;
  }
}

function writeUpgradeError(socket, statusCode, message) {
  socket.write(
    [
      `HTTP/1.1 ${statusCode} ${message}`,
      "Connection: close",
      "Content-Type: text/plain",
      "",
      message,
    ].join("\r\n"),
  );
  socket.destroy();
}

function buildXaiSttUrl(requestUrl) {
  const xaiUrl = new URL(XAI_STT_STREAM_URL);
  const defaults = {
    sample_rate: "24000",
    encoding: "pcm",
    interim_results: "true",
    endpointing: "250",
    diarize: "true",
  };
  Object.entries(defaults).forEach(([key, value]) => {
    xaiUrl.searchParams.set(key, value);
  });
  requestUrl.searchParams.forEach((value, key) => {
    if (ALLOWED_STT_PARAMS.has(key)) {
      if (key === "keyterm") {
        xaiUrl.searchParams.append(key, value);
      } else {
        xaiUrl.searchParams.set(key, value);
      }
    }
  });
  return xaiUrl;
}

function closeWebSocket(ws, code = 1000, reason = "closing") {
  if (!ws) return;
  if (ws.readyState === WebSocket.CLOSING || ws.readyState === WebSocket.CLOSED) {
    return;
  }
  try {
    ws.close(code, reason);
  } catch {
    ws.terminate();
  }
}

function sendJson(ws, payload) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify(payload));
}

function attachConnectionHandlers(clientWs, req, requestUrl, user) {
  const apiKey = process.env.XAI_API_KEY;
  const xaiUrl = buildXaiSttUrl(requestUrl);
  const pendingClientFrames = [];
  let clientClosed = false;
  let upstreamClosed = false;

  const xaiWs = new WebSocket(xaiUrl, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
  });

  const flushPendingFrames = () => {
    while (pendingClientFrames.length > 0 && xaiWs.readyState === WebSocket.OPEN) {
      xaiWs.send(pendingClientFrames.shift());
    }
  };

  xaiWs.on("open", () => {
    console.log(
      `[STT-STREAM] Opened xAI STT stream for user ${user?._id || "unknown"}`,
    );
    flushPendingFrames();
  });

  xaiWs.on("message", (data, isBinary) => {
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.send(data, { binary: isBinary });
    }
  });

  xaiWs.on("error", (error) => {
    console.error("[STT-STREAM] xAI WebSocket error:", error.message);
    sendJson(clientWs, {
      type: "error",
      message: "Streaming transcription connection failed.",
    });
  });

  xaiWs.on("close", (code, reason) => {
    upstreamClosed = true;
    console.log(
      `[STT-STREAM] xAI STT stream closed (${code}) ${reason?.toString() || ""}`,
    );
    if (!clientClosed) {
      closeWebSocket(clientWs, 1000, "stt upstream closed");
    }
  });

  clientWs.on("message", (data, isBinary) => {
    if (upstreamClosed) return;
    const frame = isBinary ? data : data.toString();
    if (xaiWs.readyState === WebSocket.OPEN) {
      xaiWs.send(frame, { binary: isBinary });
    } else if (xaiWs.readyState === WebSocket.CONNECTING) {
      pendingClientFrames.push(frame);
    }
  });

  clientWs.on("error", (error) => {
    console.error("[STT-STREAM] Client WebSocket error:", error.message);
  });

  clientWs.on("close", () => {
    clientClosed = true;
    if (xaiWs.readyState === WebSocket.OPEN) {
      try {
        xaiWs.send(JSON.stringify({ type: "audio.done" }));
      } catch {
        // Ignore flush failures during teardown.
      }
    }
    closeWebSocket(xaiWs, 1000, "client closed");
  });
}

export function attachXaiSttStreamProxy(server) {
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    const requestUrl = new URL(
      req.url || "/",
      `http://${req.headers.host || "localhost"}`,
    );

    if (requestUrl.pathname !== STT_PROXY_PATH) {
      return;
    }

    const user = verifyRequest(req, requestUrl);
    if (!user) {
      writeUpgradeError(socket, 401, "Unauthorized");
      return;
    }

    if (!process.env.XAI_API_KEY) {
      writeUpgradeError(socket, 500, "Streaming transcription is not configured");
      return;
    }

    wss.handleUpgrade(req, socket, head, (clientWs) => {
      attachConnectionHandlers(clientWs, req, requestUrl, user);
    });
  });
}
