import { User } from "../models/user.js";
import { sendAppMail, SUPPORT_MAIL_ADDRESS } from "./sendMail.js";
import { buildEmailCardHtml, PRODUCT_NAME, SUPPORT_EMAIL } from "./emailHtml.js";
import { getAppBaseUrl } from "./appBaseUrl.js";
import {
  CREDIT_EXPIRY_DAYS,
  CREDIT_TOPUP_CREDITS,
  CREDIT_TOPUP_PRICE_GBP,
} from "./creditCalculator.js";

export const CREDIT_PURCHASE_SUBJECT = `Your ${PRODUCT_NAME} call time has been added`;

function defaultMailer({ to, subject, html, text }) {
  return sendAppMail({ to, subject, html, text });
}

function formatDateTime(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString("en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  });
}

export function formatGbpFromPence(amountPence, currency = "gbp") {
  const pence = Number(amountPence);
  const code = String(currency || "gbp").toUpperCase();
  if (!Number.isFinite(pence)) return "—";
  try {
    return new Intl.NumberFormat("en-GB", {
      style: "currency",
      currency: code,
    }).format(pence / 100);
  } catch {
    return `£${(pence / 100).toFixed(2)}`;
  }
}

export function buildCreditPurchaseEmail({
  userName = "there",
  credits = CREDIT_TOPUP_CREDITS,
  packs = 1,
  amountPence = CREDIT_TOPUP_PRICE_GBP * 100 * (Number(packs) || 1),
  currency = "gbp",
  purchasedAt = new Date(),
  expiresAt,
  newBalance = 0,
  supportEmail = SUPPORT_MAIL_ADDRESS || SUPPORT_EMAIL,
  appUrl = getAppBaseUrl(),
} = {}) {
  const greetingName = String(userName || "there").trim() || "there";
  const contactEmail = supportEmail || SUPPORT_EMAIL;
  const manageUrl = `${String(appUrl || "").replace(/\/+$/, "")}/app.html`;
  const creditsLabel = Number(credits || 0).toLocaleString();
  const amountLabel = formatGbpFromPence(amountPence, currency);
  const boughtAt = formatDateTime(purchasedAt);
  const expiry = formatDateTime(expiresAt);
  const balanceLabel = Number(newBalance || 0).toLocaleString();
  const packCount = Math.max(1, Number(packs) || 1);

  const lead = [
    `Hi ${greetingName},`,
    `Your purchase is confirmed. ${creditsLabel} seconds of call time have been added to your ${PRODUCT_NAME} account.`,
    `These credits expire ${CREDIT_EXPIRY_DAYS} days after purchase (${expiry} UTC). Unused credits do not last past that date.`,
  ].join("\n\n");

  const rows = [
    { label: "Credits purchased", value: creditsLabel },
    packCount > 1 ? { label: "Packs", value: String(packCount) } : null,
    { label: "Amount paid", value: amountLabel },
    { label: "Purchase date", value: `${boughtAt} UTC` },
    { label: "Expires", value: `${expiry} UTC` },
    { label: "New balance", value: balanceLabel },
  ].filter(Boolean);

  const footer = `If you have any questions, reply to this email or write to ${contactEmail}.`;
  const htmlBody = buildEmailCardHtml({
    eyebrow: "Call time",
    title: "Your call time has been added",
    lead,
    rows,
    ctaUrl: manageUrl,
    ctaLabel: `Open ${PRODUCT_NAME}`,
    footer,
    preheader: `${creditsLabel} seconds of call time added. They expire on ${expiry} UTC.`,
  });

  const textBody = [
    lead,
    `Credits purchased: ${creditsLabel}`,
    packCount > 1 ? `Packs: ${packCount}` : null,
    `Amount paid: ${amountLabel}`,
    `Purchase date: ${boughtAt} UTC`,
    `Expires: ${expiry} UTC`,
    `New balance: ${balanceLabel}`,
    `Open ${PRODUCT_NAME}: ${manageUrl}`,
    footer,
  ]
    .filter(Boolean)
    .join("\n\n");

  return {
    subject: CREDIT_PURCHASE_SUBJECT,
    textBody,
    htmlBody,
  };
}

export async function sendCreditPurchaseEmail({
  user,
  credits,
  packs,
  amountPence,
  currency,
  purchasedAt,
  expiresAt,
  newBalance,
  mailer = defaultMailer,
  appUrl,
} = {}) {
  if (!user?.email) return { sent: false, reason: "missing_email" };
  const email = buildCreditPurchaseEmail({
    userName: user.name,
    credits,
    packs,
    amountPence,
    currency,
    purchasedAt,
    expiresAt,
    newBalance,
    appUrl,
  });
  try {
    await mailer({
      to: user.email,
      subject: email.subject,
      html: email.htmlBody,
      text: email.textBody,
    });
    return { sent: true };
  } catch (error) {
    console.error(
      `[Credits] Purchase email failed for ${user._id}: ${error.message}`,
    );
    return { sent: false, reason: "send_failed", error };
  }
}

export async function loadMailUser(userId) {
  if (!userId) return null;
  return User.findById(userId).select("name email");
}

export default {
  CREDIT_PURCHASE_SUBJECT,
  buildCreditPurchaseEmail,
  sendCreditPurchaseEmail,
};
