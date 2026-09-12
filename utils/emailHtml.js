export const PRODUCT_NAME = "Call & Translate";
export const SUPPORT_EMAIL = "info@callandtranslate.com";

export function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => {
    switch (char) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      case "'":
        return "&#39;";
      default:
        return char;
    }
  });
}

function nlToBr(text) {
  return escapeHtml(text).replace(/\n/g, "<br>");
}

export function htmlToText(html) {
  return String(html || "")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<\/tr>/gi, "\n")
    .replace(/<\/(div|h1|h2|h3|h4|li)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

export function buildEmailCardHtml({
  eyebrow = PRODUCT_NAME,
  title = "",
  lead = "",
  rows = [],
  ctaUrl = "",
  ctaLabel = "",
  footer = `If you have any questions, reply to this email or write to ${SUPPORT_EMAIL}.`,
  preheader = "",
} = {}) {
  const safeRows = Array.isArray(rows) ? rows : [];
  const tableRows = safeRows
    .filter((row) => row && row.label && row.value !== undefined)
    .map(
      (row) => `
        <tr>
          <td style="padding:10px 0;color:#9aa3b5;font-size:13px;white-space:nowrap;border-bottom:1px solid rgba(244,241,234,0.08);">${escapeHtml(row.label)}</td>
          <td style="padding:10px 0 10px 16px;color:#f4f1ea;font-size:13px;font-weight:700;text-align:right;border-bottom:1px solid rgba(244,241,234,0.08);">${escapeHtml(row.value)}</td>
        </tr>`,
    )
    .join("");

  const ctaBlock =
    ctaUrl && ctaLabel
      ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:28px 0 0;">
           <tr>
             <td style="border-radius:10px;background:#ff7a18;">
               <a href="${escapeHtml(ctaUrl)}" style="display:inline-block;padding:12px 18px;border-radius:10px;background:#ff7a18;color:#1c0b00;text-decoration:none;font-weight:800;font-size:14px;letter-spacing:0.01em;">${escapeHtml(ctaLabel)}</a>
             </td>
           </tr>
         </table>`
      : "";

  const preview = String(preheader || lead || title || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 140);

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(title || PRODUCT_NAME)}</title>
  </head>
  <body style="margin:0;padding:0;background:#07051a;font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Arial,sans-serif;">
    <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${escapeHtml(preview)}</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#07051a;padding:32px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;border-collapse:separate;">
            <tr>
              <td style="padding:0 0 18px;text-align:center;">
                <span style="display:inline-block;font-family:Arial,Helvetica,sans-serif;font-weight:800;font-size:20px;letter-spacing:-0.04em;color:#f6f3ff;">Call <span style="color:#ff7a18;">&amp;</span> Translate</span>
              </td>
            </tr>
            <tr>
              <td style="background:#17123a;border:1px solid rgba(246,243,255,0.12);border-radius:16px;overflow:hidden;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                  <tr>
                    <td style="height:6px;line-height:6px;font-size:0;background:#ff7a18;">&nbsp;</td>
                  </tr>
                  <tr>
                    <td style="padding:28px 28px 8px;color:#ff7a18;font-size:11px;font-weight:800;letter-spacing:0.14em;text-transform:uppercase;">${escapeHtml(eyebrow)}</td>
                  </tr>
                  <tr>
                    <td style="padding:0 28px;color:#f6f3ff;font-size:26px;font-weight:800;line-height:1.2;letter-spacing:-0.03em;">${escapeHtml(title)}</td>
                  </tr>
                  <tr>
                    <td style="padding:14px 28px 0;color:#9aa3b5;font-size:15px;line-height:1.65;">${nlToBr(lead)}</td>
                  </tr>
                  <tr>
                    <td style="padding:8px 28px 0;">
                      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                        ${tableRows}
                      </table>
                    </td>
                  </tr>
                  <tr>
                    <td style="padding:0 28px 8px;">${ctaBlock}</td>
                  </tr>
                  <tr>
                    <td style="padding:18px 28px 28px;color:#6b7386;font-size:12px;line-height:1.55;">${nlToBr(footer)}</td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td style="padding:16px 8px 0;text-align:center;color:#6b7386;font-size:11px;line-height:1.5;">
                Get things done in a language you don’t speak.<br>
                ${escapeHtml(SUPPORT_EMAIL)}
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}
