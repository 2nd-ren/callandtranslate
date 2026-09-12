import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import cors from "cors";
import helmet from "helmet";
import error from "../middleware/error.js";
import users from "../routes/users.js";
import auth from "../routes/auth.js";
import menu from "../routes/menu.js";
import userCredits from "../routes/userCredits.js";
import billing from "../routes/billing.js";
import subscriptions from "../routes/subscriptions.js";
import stripeWebhook from "../routes/stripeWebhook.js";
import usage from "../routes/usage.js";
import mailer from "../routes/mailer.js";
import passkeys from "../routes/passkeys.js";
import adminRoutes from "../routes/admin.js";
import callAgent from "../routes/callAgent.js";
import voice from "../routes/voice.js";
import { htmlAuth, htmlAdmin } from "../middleware/admin.js";
import {
  clearRefreshCookie,
  getRefreshTokenFromRequest,
  revokeRefreshToken,
} from "../utils/authSessionService.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const APP_WEB_ORIGINS = [
  "http://localhost:3005",
  "http://127.0.0.1:3005",
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  "https://callandtranslate.com",
  "https://www.callandtranslate.com",
];

const CORS_ORIGINS = [...APP_WEB_ORIGINS];

export default function (app) {
  if (!app.get("trust proxy")) app.set("trust proxy", 1);

  app.use(
    cors({
      origin: CORS_ORIGINS,
      methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      credentials: true,
      allowedHeaders: [
        "Content-Type",
        "Authorization",
        "x-auth-token",
      ],
    }),
  );

  app.use(
    "/api/stripe/webhook",
    express.raw({ type: "application/json" }),
    stripeWebhook,
  );
  app.use("/api/call-agent", express.json({ limit: "15mb" }));
  app.use(express.json({ limit: "2mb" }));
  app.use(express.urlencoded({ extended: true, limit: "2mb" }));

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'", ...APP_WEB_ORIGINS],
          connectSrc: [
            "'self'",
            "https://api.x.ai",
            "wss://api.x.ai",
            "https://api.stripe.com",
            ...APP_WEB_ORIGINS,
          ],
          styleSrc: [
            "'self'",
            "'unsafe-inline'",
            "https://fonts.googleapis.com",
          ],
          fontSrc: ["'self'", "https://fonts.gstatic.com", "data:"],
          scriptSrc: ["'self'", "'unsafe-inline'", "https://js.stripe.com"],
          workerSrc: ["'self'", "blob:"],
          mediaSrc: ["'self'", "blob:"],
          imgSrc: ["'self'", "data:", "blob:", "https:"],
          frameSrc: ["'self'", "https://js.stripe.com", "https://hooks.stripe.com"],
        },
      },
      crossOriginEmbedderPolicy: false,
      crossOriginResourcePolicy: false,
    }),
  );

  app.use((req, res, next) => {
    const pathName = req.path || "";
    const noindex =
      pathName === "/api" ||
      pathName.startsWith("/api/") ||
      pathName === "/app.html" ||
      pathName === "/subscription-success.html" ||
      pathName === "/admin" ||
      pathName === "/pages/admin.html";
    if (noindex) {
      res.setHeader("X-Robots-Tag", "noindex, nofollow, noarchive");
    }
    next();
  });

  app.use(
    express.static(path.join(__dirname, "../public"), { extensions: ["html"] }),
  );

  const sendAdminHtml = (_req, res) => {
    res.setHeader("X-Robots-Tag", "noindex, nofollow, noarchive");
    res.sendFile(path.join(__dirname, "../pages/admin.html"));
  };
  app.get("/admin", htmlAuth, htmlAdmin, sendAdminHtml);
  app.get("/pages/admin.html", htmlAuth, htmlAdmin, sendAdminHtml);

  app.use("/pages", express.static(path.join(__dirname, "../pages")));

  app.get("/pricing", (_req, res) => {
    res.sendFile(path.join(__dirname, "../public/pricing.html"));
  });
  app.get("/about", (_req, res) => {
    res.sendFile(path.join(__dirname, "../public/about.html"));
  });
  const sendPublic = (name) => (_req, res) => {
    res.sendFile(path.join(__dirname, "../public", name));
  };
  app.get("/privacy", sendPublic("privacy.html"));
  app.get("/privacy-policy", sendPublic("privacy.html"));
  app.get("/cookies", sendPublic("cookies.html"));
  app.get("/cookie-policy", sendPublic("cookies.html"));
  app.get("/terms", sendPublic("terms.html"));
  app.get("/terms-of-service", sendPublic("terms.html"));
  app.get("/acceptable-use", sendPublic("acceptable-use.html"));
  app.get("/acceptable-use-policy", sendPublic("acceptable-use.html"));

  app.use("/api/auth", auth);
  app.use("/api/users", users);
  app.use("/api/menu", menu);
  app.use("/api/user-credits", userCredits);
  app.use("/api/billing", billing);
  app.use("/api/subscriptions", subscriptions);
  app.use("/api/usage", usage);
  app.use("/api/mailer", mailer);
  app.use("/api/passkeys", passkeys);
  app.use("/api/admin", adminRoutes);
  app.use("/api/call-agent", callAgent);
  app.use("/api/voice", voice);

  app.get("/health", (_req, res) => {
    res.json({ ok: true, app: "Call & Translate" });
  });

  app.post("/logout", async (req, res) => {
    try {
      const raw = getRefreshTokenFromRequest(req);
      if (raw) await revokeRefreshToken(raw);
      clearRefreshCookie(res, req);
    } catch {
      // best-effort
    }
    res.clearCookie("authToken", { path: "/" });
    res.status(200).json({ message: "Logged out", redirect: "/index.html" });
  });

  app.use(error);
}
