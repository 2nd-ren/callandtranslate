import nodemailer from "nodemailer";
import { htmlToText } from "./emailHtml.js";

const EMAIL_DOMAIN = process.env.EMAIL_DOMAIN || "callandtranslate.com";
const INFO_MAIL_ADDRESS =
  process.env.INFO_MAIL_ADDRESS || `info@${EMAIL_DOMAIN}`;
const AUTH_MAIL_ADDRESS =
  process.env.AUTH_EMAIL_ADDRESS ||
  process.env.VERIFICATION_EMAIL_ADDRESS ||
  INFO_MAIL_ADDRESS;
const SUPPORT_MAIL_ADDRESS =
  process.env.SUPPORT_EMAIL || INFO_MAIL_ADDRESS;
const SMTP_HOST = process.env.SMTP_HOST || "heracles.mxrouting.net";
const SMTP_PORT = parseInt(process.env.SMTP_PORT || "587", 10);
const SMTP_SECURE =
  process.env.SMTP_SECURE === "true" ||
  process.env.SMTP_SECURE === "1" ||
  SMTP_PORT === 465;
const SMTP_USER = process.env.SMTP_USER || INFO_MAIL_ADDRESS;

function smtpPassword() {
  return (
    process.env.SMTP_PASS ||
    process.env.INFO_MAIL_PASSWORD ||
    process.env.AUTH_MAIL_PASSWORD ||
    ""
  );
}

function allowedFrom(from) {
  const allowed = new Set(
    [INFO_MAIL_ADDRESS, AUTH_MAIL_ADDRESS, SMTP_USER]
      .filter(Boolean)
      .map((v) => String(v).toLowerCase()),
  );
  return allowed.has(String(from || "").toLowerCase());
}

export function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function createTransport() {
  const password = smtpPassword();
  if (!password) {
    const err = new Error("Mail sender is not configured");
    err.status = 400;
    throw err;
  }
  return nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_SECURE,
    requireTLS: !SMTP_SECURE,
    connectionTimeout: 15000,
    auth: {
      user: SMTP_USER,
      pass: password,
    },
  });
}

export async function sendAppMail({ to, subject, html, text, from } = {}) {
  if (process.env.NODE_ENV === "test") {
    return { success: true, messageId: "test-skip" };
  }
  const sender = from || AUTH_MAIL_ADDRESS;
  if (!allowedFrom(sender)) {
    const err = new Error("Invalid sender email");
    err.status = 400;
    throw err;
  }
  const transporter = createTransport();
  const info = await transporter.sendMail({
    from: sender,
    to,
    subject,
    text: text || htmlToText(html),
    html,
  });
  return { success: true, messageId: info.messageId };
}

export async function verifyMailTransport() {
  const transporter = createTransport();
  await transporter.verify();
  return {
    ok: true,
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_SECURE,
    user: SMTP_USER,
  };
}

export { AUTH_MAIL_ADDRESS, INFO_MAIL_ADDRESS, SUPPORT_MAIL_ADDRESS };
