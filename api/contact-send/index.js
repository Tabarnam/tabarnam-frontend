// api/contact-send/index.js
let app;
try {
  ({ app } = require("../_app"));
} catch {
  app = { http() {} };
}

const { Resend } = require("resend");

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

  // Send via Resend
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey)
    return json({ error: "Email service not configured" }, 503, req);

  const resend = new Resend(apiKey);

  try {
    const fromName = name || "Anonymous";
    const { data, error } = await resend.emails.send({
      from: "Tabarnam Contact <noreply@tabarnam.com>",
      to: ["duh@tabarnam.com"],
      replyTo: email,
      subject: `[Contact] ${displaySubject}`,
      html: `<p><strong>From:</strong> ${fromName} (${email})</p>
             <p><strong>Subject:</strong> ${displaySubject}</p>
             <hr />
             <p>${message.replace(/\n/g, "<br />")}</p>`,
    });

    if (error) {
      context?.log?.error?.("Resend error:", error);
      return json({ error: "Failed to send email" }, 500, req);
    }

    return json({ ok: true, id: data?.id }, 200, req);
  } catch (e) {
    context?.log?.error?.("Contact send error:", e?.message || e);
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
