// api/contact-send/index.js
let app;
try {
  ({ app } = require("../_app"));
} catch {
  app = { http() {} };
}

const { isEmailConfigured, sendEmail } = require("../_graphEmail");

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

  // Send via Microsoft Graph API (shared helper — see api/_graphEmail.js)
  if (!isEmailConfigured())
    return json({ error: "Email service not configured" }, 503, req);

  try {
    const fromName = name || "Anonymous";
    const htmlBody = `<p><strong>From:</strong> ${fromName} (${email})</p>
             <p><strong>Subject:</strong> ${displaySubject}</p>
             <hr />
             <p>${message.replace(/\n/g, "<br />")}</p>`;

    context?.log?.("Contact send: calling Graph API");

    await sendEmail({
      to: "duh@tabarnam.com",
      subject: `[User] ${displaySubject}`,
      html: htmlBody,
      replyTo: email,
      replyToName: fromName,
    });

    // Send auto-response to the submitter
    const autoResponseHtml = `<p>Hi ${fromName},</p>
<p>We've received your message and appreciate you taking the time to write to us. Our team will review it and respond within a few business days.</p>
<p>Here's a copy of your message for your records:</p>
<p><strong>Subject:</strong> ${displaySubject}</p>
<blockquote style="border-left:3px solid #ccc;padding-left:12px;margin:12px 0;color:#555;">${message.replace(/\n/g, "<br />")}</blockquote>
<p>In the meantime, feel free to reply to this email if you have anything to add.</p>
<p>Best,<br />The Tabarnam Team</p>`;

    try {
      await sendEmail({
        to: email,
        toName: fromName,
        subject: `Thanks for contacting Tabarnam`,
        html: autoResponseHtml,
      });
      context?.log?.("Contact send: auto-response sent to", email);
    } catch (autoErr) {
      context?.log?.error?.("Contact send: auto-response failed:", autoErr?.message || autoErr);
    }

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
