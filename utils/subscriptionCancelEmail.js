import { User } from "../models/user.js";
import { sendAppMail, SUPPORT_MAIL_ADDRESS } from "./sendMail.js";
import { buildEmailCardHtml, PRODUCT_NAME, SUPPORT_EMAIL } from "./emailHtml.js";
import { getAppBaseUrl } from "./appBaseUrl.js";
import { getPlanById } from "./plans.js";

export const CANCEL_REQUESTED_SUBJECT =
  "If something wasn't working, we'd rather fix it";
export const CANCEL_ENDED_SUBJECT =
  "Your subscription has ended — we'd still like to help";

function cancelClaimFilter(userId) {
  return {
    _id: userId,
    $or: [
      { subscriptionCancelFeedbackEmailSentAt: { $exists: false } },
      { subscriptionCancelFeedbackEmailSentAt: null },
    ],
  };
}

function defaultMailer({ to, subject, html, text }) {
  return sendAppMail({ to, subject, html, text });
}

export function formatPeriodEnd(value) {
  if (!value) return "";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

export function buildSubscriptionCancelEmail({
  userName = "there",
  planName = "Pro",
  periodEnd = null,
  stage = "requested",
  supportEmail = SUPPORT_MAIL_ADDRESS || SUPPORT_EMAIL,
  appUrl = getAppBaseUrl(),
  preview = false,
} = {}) {
  const greetingName = String(userName || "there").trim() || "there";
  const displayPlan = String(planName || "Pro").trim() || "Pro";
  const contactEmail = supportEmail || SUPPORT_EMAIL;
  const origin = String(appUrl || "").replace(/\/+$/, "");
  const ended = stage === "ended";
  const periodEndText = formatPeriodEnd(periodEnd);
  const keepUrl = `${origin}/app.html`;
  const subscribeUrl = `${origin}/pricing.html`;
  const ctaUrl = ended ? subscribeUrl : keepUrl;
  const ctaLabel = ended ? "Resubscribe" : "Keep my subscription";
  const baseSubject = ended ? CANCEL_ENDED_SUBJECT : CANCEL_REQUESTED_SUBJECT;
  const subject = preview ? `[Preview] ${baseSubject}` : baseSubject;

  const paragraphs = ended
    ? [
        `Hi ${greetingName},`,
        `Your ${displayPlan} subscription has ended, and your account is now on the free plan.`,
        "If you cancelled because something wasn't what you expected, felt awkward, or just isn't working, please tell us. We'd much rather hear from you than lose you over something we can change.",
        "We're a small, responsive team. We read every message, and we make improvements quickly.",
        "Just reply to this email. If you'd like to come back, we can help you get set up again.",
      ]
    : [
        `Hi ${greetingName},`,
        `We've received your cancellation for the ${displayPlan} plan.`,
        "If you cancelled because something wasn't what you expected, felt awkward, or just isn't working, please tell us. We'd much rather hear from you than lose you over something we can change.",
        "We're a small, responsive team. We read every message, and we make improvements quickly.",
        periodEndText
          ? `Just reply to this email. Your plan stays active until ${periodEndText}, so there's still time to sort this out if you want to stay.`
          : "Just reply to this email. If you want to stay, you can turn cancellation off from your account.",
      ];

  if (preview) {
    paragraphs.unshift(
      ended
        ? "PREVIEW — this is the email a customer receives when their paid subscription has ended."
        : "PREVIEW — this is the email a customer receives when they cancel a paid subscription.",
    );
  }

  const lead = paragraphs.join("\n\n");
  const rows = [{ label: "Plan", value: displayPlan }];
  if (!ended && periodEndText) {
    rows.push({ label: "Active until", value: periodEndText });
  }
  const footer = `You can also email ${contactEmail} anytime. If a feature should work differently, we want to know.`;

  const htmlBody = buildEmailCardHtml({
    eyebrow: ended ? "Subscription ended" : "Before you go",
    title: ended ? "Your subscription has ended" : "Sorry to see you go",
    lead,
    rows,
    ctaUrl,
    ctaLabel,
    footer,
    preheader: ended
      ? `Your ${PRODUCT_NAME} subscription has ended. We'd still like to help.`
      : `We've received your ${PRODUCT_NAME} cancellation. If something wasn't working, tell us.`,
  });

  const textParts = [lead];
  rows.forEach((row) => textParts.push(`${row.label}: ${row.value}`));
  textParts.push(`${ctaLabel}: ${ctaUrl}`, footer);

  return {
    subject,
    textBody: textParts.join("\n\n"),
    htmlBody,
  };
}

export async function sendCancellationFeedbackIfNeeded({
  user,
  tier = "pro",
  periodEnd = null,
  stage = "requested",
  mailer = defaultMailer,
  UserModel = User,
  now = () => new Date(),
  appUrl,
} = {}) {
  if (!user || !user._id) return { sent: false, reason: "missing_user" };
  if (!user.email) return { sent: false, reason: "missing_email" };
  if (user.subscriptionCancelFeedbackEmailSentAt) {
    return { sent: false, reason: "already_sent" };
  }

  const sentAt = now();
  const claimed = await UserModel.findOneAndUpdate(
    cancelClaimFilter(user._id),
    { $set: { subscriptionCancelFeedbackEmailSentAt: sentAt } },
    { new: false },
  );
  if (!claimed) return { sent: false, reason: "already_sent" };
  user.subscriptionCancelFeedbackEmailSentAt = sentAt;

  const email = buildSubscriptionCancelEmail({
    userName: user.name || "there",
    planName: getPlanById(tier).name || tier || "Pro",
    periodEnd,
    stage,
    appUrl,
  });

  try {
    await mailer({
      to: user.email,
      subject: email.subject,
      html: email.htmlBody,
      text: email.textBody,
    });
    return { sent: true, reason: "sent", stage };
  } catch (error) {
    await UserModel.updateOne(
      { _id: user._id },
      { $unset: { subscriptionCancelFeedbackEmailSentAt: 1 } },
    );
    user.subscriptionCancelFeedbackEmailSentAt = null;
    return { sent: false, reason: "send_failed", error };
  }
}

export async function clearCancellationFeedbackFlag(user, UserModel = User) {
  if (!user || !user._id) return;
  await UserModel.updateOne(
    { _id: user._id },
    { $unset: { subscriptionCancelFeedbackEmailSentAt: 1 } },
  );
  user.subscriptionCancelFeedbackEmailSentAt = null;
}
