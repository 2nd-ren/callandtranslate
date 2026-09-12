import { sendAppMail, AUTH_MAIL_ADDRESS } from "./sendMail.js";
import { buildEmailCardHtml, PRODUCT_NAME } from "./emailHtml.js";

const fromAddress = process.env.VERIFICATION_EMAIL_ADDRESS || AUTH_MAIL_ADDRESS;

const verifyEmail = async (userName, userEmail, verificationLink) => {
  const name = String(userName || "there").trim() || "there";
  const html = buildEmailCardHtml({
    eyebrow: "Welcome",
    title: "Verify your email",
    lead: `Hi ${name},\n\nThanks for creating a ${PRODUCT_NAME} account. Click the button below to verify your email and sign in.`,
    ctaUrl: verificationLink,
    ctaLabel: "Verify email and sign in",
    footer: `This link expires in 15 minutes and can only be used once.\n\nIf the button doesn't work, paste this link into your browser:\n${verificationLink}\n\nIf you did not create an account, you can ignore this email.`,
    preheader: `Verify your ${PRODUCT_NAME} email to sign in.`,
  });
  return sendAppMail({
    to: userEmail,
    subject: "Verify your email to sign in",
    html,
    from: fromAddress,
  });
};

export default verifyEmail;
