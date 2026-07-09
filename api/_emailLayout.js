// api/_emailLayout.js
//
// Branded, email-safe HTML layout (light card, teal #86C6CF accent) used for
// Tabarnam notification emails. Table-based + inline styles for Outlook/Gmail
// compatibility. See the approved mockup: accent bar, header label + timestamp,
// stacked label/value fields, teal-bordered review blockquote, action buttons,
// footer strip.

const ACCENT = "#86C6CF";
const ACCENT_TEXT = "#2C7F89"; // darker teal — accessible on white
const CARD_BG = "#FFFFFF";
const PAGE_BG = "#F2F4F5";
const BORDER = "#E6E9EA";
const LABEL = "#7A858B";
const VALUE = "#1B2124";
const MUTED = "#8A949A";
const FONT =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

// Email-optimized Tabarnam wordmark (360×163, ~8KB), served from the SWA static
// site. A hosted URL (not an inline CID) matches how these emails already
// reference the review-photo image URLs, and keeps the message body small.
const SITE = (process.env.SITE_BASE_URL || "https://tabarnam.com").replace(/\/+$/, "");
const LOGO_URL = `${SITE}/email-logo.png`;

// Public link to a company's profile — the same `/results?q=<name>` deep link the
// site's Share button uses (there's no standalone /company/:id route; companies
// live on the results page).
function companyProfileUrl(companyName) {
  return `${SITE}/results?q=${encodeURIComponent(String(companyName || "").trim())}`;
}

const BTN_COLORS = {
  approve: { bg: "#2E9E4F", fg: "#FFFFFF" },
  reject: { bg: "#E0433E", fg: "#FFFFFF" },
  edit: { bg: "#333B41", fg: "#FFFFFF" },
  neutral: { bg: "#EEF1F2", fg: "#333B41" },
};

function esc(v) {
  return String(v == null ? "" : v)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// A stacked "label over value" field row. valueHtml is pre-escaped/HTML.
function field(label, valueHtml) {
  return `<tr><td style="padding:0 0 16px;">
    <div style="font:400 13px/1.3 ${FONT};color:${LABEL};margin:0 0 3px;">${esc(label)}</div>
    <div style="font:600 16px/1.45 ${FONT};color:${VALUE};">${valueHtml}</div>
  </td></tr>`;
}

// The teal-bordered review quote. text is raw (escaped here).
function reviewBlock(text) {
  const body = esc(text).replace(/\n/g, "<br />");
  return `<tr><td style="padding:0 0 20px;">
    <div style="font:400 13px/1.3 ${FONT};color:${LABEL};margin:0 0 8px;">Review</div>
    <div style="border-left:3px solid ${ACCENT};padding:2px 0 2px 15px;font:400 15px/1.6 ${FONT};color:#41494D;">${body}</div>
  </td></tr>`;
}

// A single full-width action button, stacked as its own table row so the set
// reads as a clean vertical stack — easy to tap on a phone, reliable in email.
// kind ∈ approve|reject|edit|neutral.
function button(label, href, kind = "neutral") {
  const c = BTN_COLORS[kind] || BTN_COLORS.neutral;
  return `<tr><td style="padding:0 0 10px;">
    <a href="${esc(href)}" style="display:block;width:100%;box-sizing:border-box;text-align:center;background:${c.bg};color:${c.fg};font:700 16px/1 ${FONT};text-decoration:none;padding:15px 20px;border-radius:10px;">${esc(label)}</a>
  </td></tr>`;
}

// Sign-off block for reviewer-facing emails: "Warm regards, Tabarnam Triumvirate"
// over the wordmark. Returns a content table row (append to contentHtml).
function signatureBlock(name = "Tabarnam Triumvirate") {
  return `<tr><td style="padding:8px 0 4px;">
    <div style="font:400 15px/1.6 ${FONT};color:#41494D;">Warm regards,</div>
    <div style="font:700 15px/1.5 ${FONT};color:${VALUE};margin:2px 0 10px;">${esc(name)}</div>
    <img src="${LOGO_URL}" width="132" alt="Tabarnam" style="display:block;border:0;width:132px;max-width:50%;height:auto;" />
  </td></tr>`;
}

/**
 * Wrap content in the branded card.
 * @param {object} o
 * @param {string} o.headerLabel  e.g. "REVIEW PENDING"
 * @param {string} [o.timestamp]  right-aligned header text
 * @param {string} o.contentHtml  table rows (use field()/reviewBlock())
 * @param {string} [o.buttonsHtml] table cells (use button())
 * @param {string} [o.footerText]
 * @param {string} [o.preheader]  hidden preview text
 * @param {boolean} [o.showLogo=true]  render the Tabarnam wordmark at the top
 * @param {boolean|string} [o.signature=false]  append a sign-off; pass a string
 *        to override the "Tabarnam Triumvirate" name
 */
function renderEmail({ headerLabel, timestamp = "", contentHtml = "", buttonsHtml = "", footerText = "", preheader = "", showLogo = true, signature = false } = {}) {
  if (signature) {
    contentHtml += signatureBlock(typeof signature === "string" ? signature : undefined);
  }
  const logoRow = showLogo
    ? `<tr><td align="center" style="padding:24px 30px 0;">
        <img src="${LOGO_URL}" width="168" alt="Tabarnam" style="display:block;border:0;width:168px;max-width:62%;height:auto;" />
      </td></tr>`
    : "";
  const pre = preheader
    ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${esc(preheader)}</div>`
    : "";
  const footer = footerText
    ? `<tr><td style="padding:14px 30px;background:rgba(134,198,207,0.10);border-top:1px solid ${BORDER};font:400 12px/1.5 ${FONT};color:${MUTED};">${esc(footerText)}</td></tr>`
    : "";
  const buttons = buttonsHtml
    ? `<tr><td style="padding:6px 30px 26px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${buttonsHtml}</table></td></tr>`
    : "";

  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:${PAGE_BG};">${pre}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${PAGE_BG};padding:24px 12px;">
  <tr><td align="center">
    <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;background:${CARD_BG};border:1px solid ${BORDER};border-radius:14px;overflow:hidden;">
      <tr><td style="height:4px;line-height:4px;font-size:0;background:${ACCENT};">&nbsp;</td></tr>
      ${logoRow}
      <tr><td style="padding:24px 30px 0;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
          <td style="font:700 14px/1 ${FONT};letter-spacing:2px;color:${ACCENT_TEXT};">${esc(headerLabel)}</td>
          <td align="right" style="font:400 13px/1 ${FONT};color:${MUTED};">${esc(timestamp)}</td>
        </tr></table>
        <div style="height:1px;background:${BORDER};margin:16px 0 22px;"></div>
      </td></tr>
      <tr><td style="padding:0 30px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${contentHtml}</table>
      </td></tr>
      ${buttons}
      ${footer}
    </table>
  </td></tr>
</table>
</body></html>`;
}

module.exports = { renderEmail, field, reviewBlock, button, signatureBlock, esc, ACCENT, ACCENT_TEXT, LOGO_URL, companyProfileUrl };
