// api/_graphEmail.js
//
// Shared Microsoft Graph email sender. Extracted from contact-send so the
// review-submission flow (submit-review, admin-review-decide) can send the
// submitter a receipt and approval/rejection notifications through the same
// Graph app registration + sender mailbox.
//
// Env vars (same as contact-send has always used):
//   GRAPH_TENANT_ID / GRAPH_CLIENT_ID / GRAPH_CLIENT_SECRET — Azure AD app
//   SENDER_EMAIL — the mailbox that sends (e.g. noreply@tabarnam.com)

let cachedClient;

function getGraphClient() {
  const tenantId = process.env.GRAPH_TENANT_ID;
  const clientId = process.env.GRAPH_CLIENT_ID;
  const clientSecret = process.env.GRAPH_CLIENT_SECRET;

  if (!tenantId || !clientId || !clientSecret) return null;
  if (cachedClient) return cachedClient;

  // Lazy-load the Graph SDK only when email is actually configured. Keeping these
  // out of the module's top-level require chain means importing this helper (e.g.
  // from submit-review) never pulls isomorphic-fetch / @microsoft/microsoft-graph-client
  // / @azure/identity — deps that aren't installed in the API contract-test env.
  require("isomorphic-fetch");
  const { ClientSecretCredential } = require("@azure/identity");
  const { Client } = require("@microsoft/microsoft-graph-client");
  const {
    TokenCredentialAuthenticationProvider,
  } = require("@microsoft/microsoft-graph-client/authProviders/azureTokenCredentials");

  const credential = new ClientSecretCredential(tenantId, clientId, clientSecret);
  const authProvider = new TokenCredentialAuthenticationProvider(credential, {
    scopes: ["https://graph.microsoft.com/.default"],
  });

  cachedClient = Client.initWithMiddleware({ authProvider });
  return cachedClient;
}

function isEmailConfigured() {
  return Boolean(getGraphClient() && process.env.SENDER_EMAIL);
}

// Minimal HTML escaping for user-provided values interpolated into email bodies.
function escapeHtml(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Send a single HTML email via Microsoft Graph.
 *
 * @param {Object} opts
 * @param {string|string[]} opts.to        - recipient address(es)
 * @param {string} opts.subject            - email subject
 * @param {string} opts.html               - HTML body
 * @param {string} [opts.toName]           - display name for the first recipient
 * @param {string} [opts.replyTo]          - reply-to address
 * @param {string} [opts.replyToName]      - reply-to display name
 * @param {boolean} [opts.saveToSentItems=true]
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
async function sendEmail({
  to,
  subject,
  html,
  toName,
  replyTo,
  replyToName,
  saveToSentItems = true,
} = {}) {
  const client = getGraphClient();
  const senderEmail = process.env.SENDER_EMAIL;

  if (!client || !senderEmail) {
    return { ok: false, error: "email_not_configured" };
  }

  const toList = (Array.isArray(to) ? to : [to])
    .map((addr) => String(addr || "").trim())
    .filter(Boolean);

  if (!toList.length) return { ok: false, error: "no_recipient" };

  const toRecipients = toList.map((address, idx) => ({
    emailAddress: {
      address,
      ...(idx === 0 && toName ? { name: toName } : {}),
    },
  }));

  const message = {
    subject: String(subject || ""),
    toRecipients,
    body: { contentType: "HTML", content: String(html || "") },
  };

  const replyToAddr = String(replyTo || "").trim();
  if (replyToAddr) {
    message.replyTo = [
      { emailAddress: { address: replyToAddr, ...(replyToName ? { name: replyToName } : {}) } },
    ];
  }

  await client.api(`/users/${senderEmail}/sendMail`).post({ message, saveToSentItems });
  return { ok: true };
}

module.exports = { getGraphClient, isEmailConfigured, sendEmail, escapeHtml };
