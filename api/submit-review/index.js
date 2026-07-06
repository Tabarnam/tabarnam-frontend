// api/submit-review/index.js
let app;
try {
  ({ app } = require("../_app"));
} catch {
  app = { http() {} };
}
const { randomUUID, randomBytes } = require("node:crypto");
const {
  getCompaniesContainer,
  getReviewsContainer,
  findCompanyByIdOrName,
} = require("../_reviewCounts");
const { xaiResponses } = require("../_xai");
// Phase 4.0 — centralized default xAI model.
const { DEFAULT_XAI_MODEL } = require("../_shared");
const { isEmailConfigured, sendEmail, escapeHtml } = require("../_graphEmail");

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Admin inbox that gets a heads-up when a new review lands in the queue.
const REVIEW_ADMIN_INBOX = "duh@tabarnam.com";

// -------- helpers ----------
const E = (k, d = "") => (process.env[k] ?? d).toString().trim();
const cors = (req) => {
  const origin = req.headers.get("origin") || "*";
  return {
    "Access-Control-Allow-Origin": origin,
    Vary: "Origin",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers":
      "Content-Type, Authorization, x-client-request-id, x-session-id",
  };
};
const json = (obj, status = 200, req) => ({
  status,
  headers: { ...cors(req), "Content-Type": "application/json" },
  body: JSON.stringify(obj),
});
const safeUuid = () => {
  try {
    return randomUUID();
  } catch {
    const a = randomBytes(16);
    return [...a].map((b) => b.toString(16).padStart(2, "0")).join("");
  }
};

async function submitReviewHandler(req, ctx) {
  if (req.method === "OPTIONS") return { status: 200, headers: cors(req) };

  const reviewsContainer = getReviewsContainer();
  if (!reviewsContainer) return json({ error: "Cosmos env not configured" }, 500, req);

  const companiesContainer = getCompaniesContainer();

  // ---- parse & validate
  let body = {};
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400, req);
  }

  // Honeypot — if the hidden field is filled, it's a bot. Silently pretend
  // success so bots don't learn. Field renamed _phone → hp_field so browser
  // autofill stops tripping the trap for real users (was silently dropping
  // legit submissions); accept both names for safety.
  if (body?.hp_field || body?._phone) return json({ ok: true }, 200, req);

  const companyIdInput = String(body?.company_id || body?.companyId || body?.id || "").trim();
  const companyNameInput = String(body?.company_name || body?.company || "").trim();

  // Score is OPTIONAL and may be any number 0–5 including tenths (e.g. 4.3).
  // Absent/blank → null (a review with no numeric score).
  const rawRating = body?.rating;
  const hasRating =
    rawRating !== undefined && rawRating !== null && String(rawRating).trim() !== "";
  const ratingNum = hasRating ? Number(rawRating) : null;

  const subject = String(body?.subject || "").trim();
  // Reviewer-editable public byline; defaults to the community label.
  const source_name = String(body?.source_name || "").trim() || "Tabarnam Transparency Advocate";
  const text = String(body?.text || "").trim();
  const user_name = String(body?.user_name || "").trim();
  const user_location = String(body?.user_location || "").trim();
  const user_email = String(body?.user_email || body?.email || "").trim();
  // Opt-in: only when the reviewer both left an email and checked the box do we
  // ever expose it publicly. Default is private.
  const show_email =
    (body?.show_email === true || String(body?.show_email).toLowerCase() === "true");

  const companyDoc = await findCompanyByIdOrName(companiesContainer, {
    companyId: companyIdInput,
    companyName: companyNameInput,
  }).catch(() => null);

  const resolvedCompanyId =
    String(companyDoc?.id || companyDoc?.company_id || companyDoc?.companyId || companyIdInput || "").trim() || null;

  const resolvedCompanyName =
    String(companyDoc?.company_name || companyDoc?.name || companyNameInput || "").trim() || null;

  if (!resolvedCompanyName) return json({ error: "company_name required" }, 400, req);
  if (hasRating && !(Number.isFinite(ratingNum) && ratingNum >= 0 && ratingNum <= 5))
    return json({ error: "rating must be a number between 0 and 5" }, 400, req);
  if (text.length < 10)
    return json({ error: "review text too short" }, 400, req);
  if (user_email && !EMAIL_RE.test(user_email))
    return json({ error: "invalid email address" }, 400, req);

  const rating = hasRating ? ratingNum : null;

  // ---- optional bot check (best effort)
  let flagged_bot = false,
    bot_reason = "";
  try {
    if (process.env.XAI_API_KEY || process.env.XAI_EXTERNAL_KEY) {
      const prompt = `Return strictly JSON: {"likely_bot": true|false, "reason": "short reason"} for this review:
Review: ${JSON.stringify(text)}
Name: ${user_name || "(none)"} | Location: ${user_location || "(none)"} | Length: ${
        text.length
      }`;
      const result = await xaiResponses({
        model: DEFAULT_XAI_MODEL,
        input: [{ role: "user", content: prompt }],
        store: false,
      });

      if (result.ok) {
        const content = result.json?.output?.[0]?.content?.find?.((c) => c?.type === "output_text")?.text ||
                       result.json?.choices?.[0]?.message?.content || "{}";
        try {
          const parsed = JSON.parse(content);
          flagged_bot = !!parsed?.likely_bot;
          bot_reason = String(parsed?.reason || "");
        } catch {
          /* ignore parse errors */
        }
      }
    }
  } catch (e) {
    ctx?.log?.warn?.(`Bot check failed: ${e?.message || e}`);
  }

  // ---- write
  // Pending-by-default: nothing is public or score-affecting until an admin
  // approves it in /admin/review-queue. is_public stays false so get-reviews
  // excludes it, and company review counts are NOT bumped here — that happens
  // on approval. This neutralizes the score-poisoning vector for bot spam.
  const doc = {
    id: safeUuid(),
    // NOTE: our reviews container is assumed to use /company as the partition key.
    company: resolvedCompanyName,
    company_name: resolvedCompanyName,
    ...(resolvedCompanyId ? { company_id: resolvedCompanyId } : {}),
    subject: subject || null,
    source_name,
    rating,
    text,
    user_name: user_name || null,
    user_location: user_location || null,
    user_email: user_email || null,
    show_email: user_email ? show_email : false,
    is_public: false,
    status: "pending",
    flagged_bot,
    bot_reason,
    created_at: new Date().toISOString(),
  };

  try {
    await reviewsContainer.items.upsert(doc, {
      partitionKey: doc.company || "reviews",
    });
  } catch (e) {
    return json({ error: e?.message || "Insert failed" }, 500, req);
  }

  // ---- best-effort emails (never block the response)
  if (isEmailConfigured()) {
    const scoreLine =
      rating != null ? `<p><strong>Your score:</strong> ${escapeHtml(rating)} / 5</p>` : "";
    const subjLine = subject
      ? `<p><strong>Subject:</strong> ${escapeHtml(subject)}</p>`
      : "";
    const reviewBlock = `${subjLine}${scoreLine}
<blockquote style="border-left:3px solid #ccc;padding-left:12px;margin:12px 0;color:#555;">${escapeHtml(text).replace(/\n/g, "<br />")}</blockquote>`;

    // 1) Receipt to the submitter (only if they gave an email)
    if (user_email) {
      const receiptHtml = `<p>Hi${user_name ? " " + escapeHtml(user_name) : ""},</p>
<p>Thanks for reviewing <strong>${escapeHtml(resolvedCompanyName)}</strong> on Tabarnam. We've received your submission and it's pending approval by our team. You'll get another email once it's been reviewed.</p>
<p>Here's a copy of what you submitted:</p>
${reviewBlock}
<p>Best,<br />The Tabarnam Team</p>`;
      try {
        await sendEmail({
          to: user_email,
          toName: user_name || undefined,
          subject: `We received your review of ${resolvedCompanyName}`,
          html: receiptHtml,
        });
      } catch (mailErr) {
        ctx?.log?.warn?.(`submit-review receipt email failed: ${mailErr?.message || mailErr}`);
      }
    }

    // 2) Heads-up to the admin inbox that a review is waiting in the queue
    const adminHtml = `<p>A new user review is pending approval.</p>
<p><strong>Company:</strong> ${escapeHtml(resolvedCompanyName)}</p>
<p><strong>From:</strong> ${escapeHtml(user_name || "Anonymous")}${user_email ? ` (${escapeHtml(user_email)})` : ""}${flagged_bot ? " — ⚠ flagged as possible bot" : ""}</p>
${reviewBlock}
<p>Review it in the admin Review Queue.</p>`;
    try {
      await sendEmail({
        to: REVIEW_ADMIN_INBOX,
        subject: `[Review pending] ${resolvedCompanyName}`,
        html: adminHtml,
        replyTo: user_email || undefined,
        replyToName: user_name || undefined,
      });
    } catch (mailErr) {
      ctx?.log?.warn?.(`submit-review admin notice failed: ${mailErr?.message || mailErr}`);
    }
  }

  return json({ ok: true, review: doc }, 200, req);
}

app.http("submit-review", {
  route: "submit-review",
  methods: ["POST", "OPTIONS"],
  authLevel: "anonymous",
  handler: submitReviewHandler,
});

module.exports = { handler: submitReviewHandler };
