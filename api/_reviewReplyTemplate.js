// api/_reviewReplyTemplate.js
//
// The default "thank you for contributing" reply an admin sends to a reviewer,
// plus the branded HTML wrapper. The admin can send this as-is or personalize
// the body before sending (see AdminReviewQueue.jsx, which pre-fills the same
// DEFAULT_THANKYOU_MESSAGE — keep the two in sync).

const { renderEmail, esc } = require("./_emailLayout");

const THANKYOU_SUBJECT = "Thank you for your review on Tabarnam";

// Editable body only — the greeting ("Hi {name},") and the "Tabarnam Support" +
// logo sign-off are added by the wrapper, so admins personalize just this part.
const DEFAULT_THANKYOU_MESSAGE =
  "Thank you for taking the time to share your review on Tabarnam. " +
  "Contributions like yours are what make our community more transparent and " +
  "help other shoppers choose with confidence — that's the whole reason we exist.\n\n" +
  "We really appreciate you being part of it.";

// Use the reviewer's full name field verbatim in the greeting; falls back to no
// name (→ "Hi there,").
function greetingName(userName) {
  return String(userName || "").trim();
}

/**
 * Build the branded thank-you email.
 * @param {object} o
 * @param {string} [o.userName]  reviewer's name (greeting uses the full name field)
 * @param {string} [o.message]   personalized body; defaults to DEFAULT_THANKYOU_MESSAGE
 * @returns {{subject: string, html: string}}
 */
function buildThankYouEmail({ userName, message } = {}) {
  const name = greetingName(userName);
  const greeting = name ? `Hi ${esc(name)},` : "Hi there,";
  const body = String(message || "").trim() || DEFAULT_THANKYOU_MESSAGE;
  const bodyHtml = esc(body).replace(/\n{2,}/g, "</div><div style=\"height:12px;\"></div><div>").replace(/\n/g, "<br />");

  const contentHtml =
    `<tr><td style="padding:0 0 12px;"><div style="font:400 15px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#41494D;">${greeting}</div></td></tr>` +
    `<tr><td style="padding:0 0 16px;"><div style="font:400 15px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#41494D;"><div>${bodyHtml}</div></div></td></tr>`;

  const html = renderEmail({
    headerLabel: "THANK YOU",
    contentHtml,
    signature: true,
    preheader: "Thank you for contributing to the Tabarnam community.",
  });

  return { subject: THANKYOU_SUBJECT, html };
}

module.exports = { THANKYOU_SUBJECT, DEFAULT_THANKYOU_MESSAGE, buildThankYouEmail };
