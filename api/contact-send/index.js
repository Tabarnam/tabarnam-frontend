// api/contact-send/index.js
let app;
try {
  ({ app } = require("../_app"));
} catch {
  app = { http() {} };
}

require("isomorphic-fetch");
const { ClientSecretCredential } = require("@azure/identity");
const { Client } = require("@microsoft/microsoft-graph-client");
const {
  TokenCredentialAuthenticationProvider,
} = require("@microsoft/microsoft-graph-client/authProviders/azureTokenCredentials");

// -------- helpers ----------
const cors = (req) => {
  const origin = req.headers.get("origin") || "*";
  return {
    "Access-Control-Allow-Origin": origin,
    Vary: "Origin",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
};

const json = (obj, status = 200, req) => ({
  status,
  headers: { ...cors(req), "Content-Type": "application/json" },
  body: JSON.stringify(obj),
});

const SUBJECT_LABELS = {
  "propose-company": "Propose a company",
  "site-improvement": "Site improvement idea",
  "report-issue": "Report an issue / Bug",
  "general-inquiry": "General inquiry",
};

function getGraphClient() {
  const tenantId = process.env.GRAPH_TENANT_ID;
  const clientId = process.env.GRAPH_CLIENT_ID;
  const clientSecret = process.env.GRAPH_CLIENT_SECRET;

  if (!tenantId || !clientId || !clientSecret) return null;

  const credential = new ClientSecretCredential(tenantId, clientId, clientSecret);
  const authProvider = new TokenCredentialAuthenticationProvider(credential, {
    scopes: ["https://graph.microsoft.com/.default"],
  });

  return Client.initWithMiddleware({ authProvider });
}

async function contactSendHandler(req, context) {
  if (req.method === "OPTIONS") return { status: 200, headers: cors(req) };

  // Parse body
  let body;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400, req);
  }

  // Honeypot check — if _phone has any value, silently return success (bot trap)
  if (body._phone) {
    return json({ ok: true }, 200, req);
  }

  // Validate fields
  const name = String(body.name || "").trim();
  const email = String(body.email || "").trim();
  const subject = String(body.subject || "").trim();
  const customSubject = String(body.customSubject || "").trim();
  const message = String(body.message || "").trim();

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    return json({ error: "Valid email is required" }, 400, req);
  if (!subject)
    return json({ error: "Subject is required" }, 400, req);
  if (subject === "other" && !customSubject)
    return json({ error: "Custom subject is required" }, 400, req);
  if (message.length < 10)
    return json({ error: "Message must be at least 10 characters" }, 400, req);

  // Resolve display subject
  const displaySubject =
    subject === "other" ? customSubject : SUBJECT_LABELS[subject] || subject;

  // Send via Microsoft Graph API
  const senderEmail = process.env.SENDER_EMAIL;
  const graphClient = getGraphClient();

  if (!graphClient || !senderEmail)
    return json({ error: "Email service not configured" }, 503, req);

  try {
    const fromName = name || "Anonymous";
    const htmlBody = `<p><strong>From:</strong> ${fromName} (${email})</p>
             <p><strong>Subject:</strong> ${displaySubject}</p>
             <hr />
             <p>${message.replace(/\n/g, "<br />")}</p>`;

    context?.log?.("Contact send: calling Graph API for sender:", senderEmail);

    const sendMailBody = {
      message: {
        subject: `[Contact] ${displaySubject}`,
        toRecipients: [
          { emailAddress: { address: "duh@tabarnam.com" } },
        ],
        replyTo: [
          { emailAddress: { address: email, name: fromName } },
        ],
        body: {
          contentType: "HTML",
          content: htmlBody,
        },
      },
      saveToSentItems: true,
    };

    context?.log?.("Contact send: request body:", JSON.stringify(sendMailBody));

    const response = await graphClient
      .api(`/users/${senderEmail}/sendMail`)
      .post(sendMailBody);

    context?.log?.("Contact send: Graph response:", JSON.stringify(response));

    // Graph returns 202 Accepted with empty body on success
    return json({ ok: true }, 200, req);
  } catch (e) {
    context?.log?.error?.("Contact send error:", e?.message || e);
    context?.log?.error?.("Contact send error details:", JSON.stringify(e, Object.getOwnPropertyNames(e)));
    return json({ error: e?.message || "Send failed" }, 500, req);
  }
}

app.http("contact-send", {
  route: "contact-send",
  methods: ["POST", "OPTIONS"],
  authLevel: "anonymous",
  handler: contactSendHandler,
});

module.exports = { handler: contactSendHandler };
