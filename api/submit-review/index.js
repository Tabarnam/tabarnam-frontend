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
const emailLayout = require("../_emailLayout");
const { signReviewToken } = require("../_reviewActionToken");
const { uploadReviewImages, MAX_IMAGES } = require("../_reviewImages");

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Admin inbox that gets a heads-up when a new review lands in the queue.
const REVIEW_ADMIN_INBOX = "duh@tabarnam.com";
const SITE = (process.env.SITE_BASE_URL || "https://tabarnam.com").replace(/\/+$/, "");

function fmtEmailTs(iso) {
  try {
    return new Date(iso).toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZone: "America/Los_Angeles",
    });
  } catch {
    return "";
  }
}

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

  // Honeypot — a filled hidden field means a bot (or aggressive autofill). We
  // no longer silently drop it; instead we FLAG it and still store it pending
  // (applied to the doc below), so a real user whose field got autofilled never
  // loses their review. Accept both the current and legacy field names.
  const honeypot_tripped = Boolean(body?.hp_field || body?._phone);

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
  // Up to 3 client-compressed data-URL images; validated + re-encoded server-side.
  const imageInputs = Array.isArray(body?.images)
    ? body.images.filter((s) => typeof s === "string" && s.startsWith("data:image/")).slice(0, MAX_IMAGES)
    : [];
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
    // Skip the LLM bot-check for honeypot trips — it's already a known bot, no
    // need to spend tokens.
    if (!honeypot_tripped && (process.env.XAI_API_KEY || process.env.XAI_EXTERNAL_KEY)) {
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

  if (honeypot_tripped) {
    flagged_bot = true;
    if (!bot_reason) bot_reason = "Hidden honeypot field was filled (likely bot or aggressive autofill).";
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
    honeypot_tripped,
    images: [],
    created_at: new Date().toISOString(),
  };

  // Upload attached images (skip for honeypot/bot trips — no point storing their
  // uploads). Best-effort: any image that fails validation/upload is dropped.
  if (!honeypot_tripped && imageInputs.length) {
    try {
      doc.images = await uploadReviewImages(imageInputs, doc.id, ctx);
    } catch (e) {
      ctx?.log?.warn?.(`submit-review image upload failed: ${e?.message || e}`);
    }
  }

  try {
    await reviewsContainer.items.upsert(doc, {
      partitionKey: doc.company || "reviews",
    });
  } catch (e) {
    return json({ error: e?.message || "Insert failed" }, 500, req);
  }

  // ---- best-effort emails (never block the response).
  // Skip emails entirely for honeypot trips so bot spam can't flood the inbox
  // or send receipts to forged addresses; the review still lands in the queue.
  if (isEmailConfigured() && !honeypot_tripped) {
    // 1) Receipt to the submitter (only if they gave an email) — branded,
    // logo'd, "Tabarnam Support" signature, matching the decision/thank-you mail.
    if (user_email) {
      const firstName = String(user_name || "").trim().split(/\s+/)[0] || "";
      const greeting = firstName ? `Hi ${escapeHtml(firstName)},` : "Hi there,";
      const row = (html) =>
        `<tr><td style="padding:0 0 14px;"><div style="font:400 15px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#41494D;">${html}</div></td></tr>`;
      const receiptContent =
        row(greeting) +
        row(`Thank you for reviewing <strong>${escapeHtml(resolvedCompanyName)}</strong> on Tabarnam. We've received your submission, and it's pending approval by our team. You will get another email once it's been reviewed.`);
      const receiptHtml = emailLayout.renderEmail({
        headerLabel: "REVIEW RECEIVED",
        contentHtml: receiptContent,
        signature: true,
        preheader: `We received your review of ${resolvedCompanyName}`,
      });
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

    // 2) Branded heads-up to the admin inbox with one-click Approve/Reject.
    // Approve/Reject links carry a signed token (verified server-side; the link
    // only shows a confirm page on GET, so email scanners can't auto-decide).
    const approveTok = signReviewToken({ reviewId: doc.id, company: doc.company, action: "approved" });
    const rejectTok = signReviewToken({ reviewId: doc.id, company: doc.company, action: "rejected" });
    const actionUrl = (t) => `${SITE}/api/review-action?token=${encodeURIComponent(t)}`;

    const photosHtml = Array.isArray(doc.images) && doc.images.length
      ? doc.images
          .map((u) => {
            const abs = `${SITE}${emailLayout.esc(u)}`;
            return `<a href="${abs}" style="text-decoration:none;"><img src="${abs}" width="90" height="90" alt="Review photo" style="width:90px;height:90px;object-fit:cover;border-radius:8px;border:1px solid #E6E9EA;margin:4px 8px 0 0;" /></a>`;
          })
          .join("")
      : "";

    const content = [
      emailLayout.field("Company", emailLayout.esc(resolvedCompanyName)),
      subject ? emailLayout.field("Subject", emailLayout.esc(subject)) : "",
      emailLayout.reviewBlock(text),
      photosHtml ? emailLayout.field("Photos", photosHtml) : "",
      user_name ? emailLayout.field("User name", emailLayout.esc(user_name)) : "",
      source_name ? emailLayout.field("Who", emailLayout.esc(source_name)) : "",
      user_email
        ? emailLayout.field(
            "Email",
            `<a href="mailto:${emailLayout.esc(user_email)}" style="color:#2C7F89;text-decoration:none;">${emailLayout.esc(user_email)}</a>`
          )
        : "",
      flagged_bot
        ? emailLayout.field("Flag", `<span style="color:#B54708;">${emailLayout.esc(bot_reason || "possible automated content")}</span>`)
        : "",
    ].join("");

    const buttons = [
      approveTok ? emailLayout.button("Approve", actionUrl(approveTok), "approve") : "",
      rejectTok ? emailLayout.button("Reject", actionUrl(rejectTok), "reject") : "",
      emailLayout.button("Edit / open in queue", `${SITE}/admin/review-queue`, "edit"),
    ].join("");

    const adminHtml = emailLayout.renderEmail({
      headerLabel: "REVIEW PENDING",
      timestamp: fmtEmailTs(doc.created_at),
      contentHtml: content,
      buttonsHtml: buttons,
      footerText:
        "Tabarnam · community review moderation — Approve and Reject act instantly; Edit opens the full queue.",
      preheader: `New review pending for ${resolvedCompanyName}`,
    });

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
