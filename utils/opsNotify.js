import { sendAppMail, INFO_MAIL_ADDRESS } from "./sendMail.js";
import { PRODUCT_NAME, escapeHtml } from "./emailHtml.js";

/**
 * Quiet ops alert to the app info@ inbox. Never throws to callers.
 */
export async function notifyInfoOps({
  event,
  subject,
  lines = [],
  user,
} = {}) {
  if (process.env.NODE_ENV === "test") {
    return { sent: false, reason: "test" };
  }
  if (!INFO_MAIL_ADDRESS) {
    return { sent: false, reason: "no_info_address" };
  }

  const stamp = new Date().toISOString();
  const details = [
    `App: ${PRODUCT_NAME}`,
    `Event: ${event || "update"}`,
    `Time (UTC): ${stamp}`,
    user?.email ? `User email: ${user.email}` : null,
    user?.name ? `User name: ${user.name}` : null,
    user?._id ? `User id: ${String(user._id)}` : null,
    ...((lines || []).filter(Boolean)),
  ].filter(Boolean);

  const text = details.join("\n");
  const html = `<pre style="font-family:system-ui,sans-serif;font-size:14px;line-height:1.45;white-space:pre-wrap">${escapeHtml(text)}</pre>`;
  const finalSubject =
    subject || `[${PRODUCT_NAME}] ${event || "Ops alert"}`;

  try {
    await sendAppMail({
      to: INFO_MAIL_ADDRESS,
      from: INFO_MAIL_ADDRESS,
      subject: finalSubject,
      text,
      html,
    });
    return { sent: true };
  } catch (error) {
    console.error(
      `[OpsNotify] Failed (${event || "unknown"}): ${error?.message || error}`,
    );
    return { sent: false, reason: "send_failed", error };
  }
}

export default { notifyInfoOps };
