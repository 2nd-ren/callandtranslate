import { sendAppMail, AUTH_MAIL_ADDRESS } from "./sendMail.js";
import { buildEmailCardHtml, PRODUCT_NAME } from "./emailHtml.js";

const fromAddress =
  process.env.AUTH_EMAIL_ADDRESS ||
  process.env.INFO_EMAIL_ADDRESS ||
  AUTH_MAIL_ADDRESS;

const sendResetEmail = async (userName, userEmail, resetLink) => {
  const name = String(userName || "there").trim() || "there";
  const html = buildEmailCardHtml({
    eyebrow: "Account",
    title: "Reset your password",
    lead: `Hi ${name},\n\nWe received a request to reset your ${PRODUCT_NAME} password. Click the button below to choose a new one.`,
    ctaUrl: resetLink,
    ctaLabel: "Reset password",
    footer: `This link expires in 15 minutes and can only be used once.\n\nIf you did not request a reset, you can ignore this email.`,
    preheader: `Reset your ${PRODUCT_NAME} password.`,
  });
  return sendAppMail({
    to: userEmail,
    subject: "Reset your password",
    html,
    from: fromAddress,
  });
};

export default sendResetEmail;
