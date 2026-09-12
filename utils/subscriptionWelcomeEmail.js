import { User } from "../models/user.js";
import { sendAppMail, SUPPORT_MAIL_ADDRESS } from "./sendMail.js";
import { buildEmailCardHtml, PRODUCT_NAME, SUPPORT_EMAIL } from "./emailHtml.js";
import { getAppBaseUrl } from "./appBaseUrl.js";
import { getPlanById } from "./plans.js";

export const WELCOME_SUBJECT =
  "Thanks for subscribing — we're here if you need us";

function welcomeClaimFilter(userId) {
  return {
    _id: userId,
    $or: [
      { subscriptionWelcomeEmailSentAt: { $exists: false } },
      { subscriptionWelcomeEmailSentAt: null },
    ],
  };
}

function defaultMailer({ to, subject, html, text }) {
  return sendAppMail({ to, subject, html, text });
}

export function buildSubscriptionWelcomeEmail({
  userName = "there",
  planName = "Pro",
  supportEmail = SUPPORT_MAIL_ADDRESS || SUPPORT_EMAIL,
  appUrl = getAppBaseUrl(),
  preview = false,
} = {}) {
  const greetingName = String(userName || "there").trim() || "there";
  const displayPlan = String(planName || "Pro").trim() || "Pro";
  const contactEmail = supportEmail || SUPPORT_EMAIL;
  const manageUrl = `${String(appUrl || "").replace(/\/+$/, "")}/app.html`;
  const subject = preview ? `[Preview] ${WELCOME_SUBJECT}` : WELCOME_SUBJECT;

  const paragraphs = [
    `Hi ${greetingName},`,
    `Thank you for subscribing to ${PRODUCT_NAME}.`,
    "If something isn't quite what you expected — a language that isn't translating cleanly, a call that feels awkward, or anything that just isn't working — please tell us. We'd much rather hear from you than have you struggle with it or cancel.",
    "We're a small, responsive team. We read every message, and we make changes quickly when something can be better.",
    "Just reply to this email and we'll get back to you.",
  ];
  if (preview) {
    paragraphs.unshift(
      "PREVIEW — this is the email a new Pro subscriber receives after purchase.",
    );
  }

  const lead = paragraphs.join("\n\n");
  const rows = [
    { label: "Plan", value: displayPlan },
    { label: "Call time", value: "1 hour added each month" },
    { label: "Credit expiry", value: "30 days after they are added" },
  ];
  const footer = `You can also email ${contactEmail} anytime. If a feature should work differently, we want to know.`;

  const htmlBody = buildEmailCardHtml({
    eyebrow: "Welcome",
    title: "Thanks for subscribing",
    lead,
    rows,
    ctaUrl: manageUrl,
    ctaLabel: `Open ${PRODUCT_NAME}`,
    footer,
    preheader: `Thank you for subscribing to ${PRODUCT_NAME}. We're here if you need us.`,
  });

  const textParts = [lead, `Plan: ${displayPlan}`, `Open ${PRODUCT_NAME}: ${manageUrl}`, footer];

  return {
    subject,
    textBody: textParts.join("\n\n"),
    htmlBody,
  };
}

export async function sendSubscriptionWelcomeIfNeeded({
  user,
  tier = "pro",
  planName,
  mailer = defaultMailer,
  UserModel = User,
  now = () => new Date(),
  appUrl,
} = {}) {
  if (!user || !user._id) return { sent: false, reason: "missing_user" };
  if (!user.email) return { sent: false, reason: "missing_email" };
  if (String(tier || "").toLowerCase() !== "pro") {
    return { sent: false, reason: "unpaid_tier" };
  }
  if (user.subscriptionWelcomeEmailSentAt) {
    return { sent: false, reason: "already_sent" };
  }

  const sentAt = now();
  const claimed = await UserModel.findOneAndUpdate(
    welcomeClaimFilter(user._id),
    { $set: { subscriptionWelcomeEmailSentAt: sentAt } },
    { new: false },
  );
  if (!claimed) return { sent: false, reason: "already_sent" };
  user.subscriptionWelcomeEmailSentAt = sentAt;

  const email = buildSubscriptionWelcomeEmail({
    userName: user.name || "there",
    planName: planName || getPlanById("pro").name,
    appUrl,
  });

  try {
    await mailer({
      to: user.email,
      subject: email.subject,
      html: email.htmlBody,
      text: email.textBody,
    });
    return { sent: true, reason: "sent" };
  } catch (error) {
    await UserModel.updateOne(
      { _id: user._id },
      { $unset: { subscriptionWelcomeEmailSentAt: 1 } },
    );
    user.subscriptionWelcomeEmailSentAt = null;
    return { sent: false, reason: "send_failed", error };
  }
}
