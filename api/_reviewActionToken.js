// api/_reviewActionToken.js
//
// Stateless HMAC-signed tokens for one-click review actions from the admin
// notification email. A token authorizes ONE action (approve|reject) on ONE
// review and expires. It is the bearer credential — it only ever exists in the
// duh@tabarnam.com inbox.
//
// Format:  base64url(JSON{rid,cmp,act,exp}) + "." + base64url(HMAC-SHA256(payload, secret))
//
// Security notes:
// - No nonce store: the action is gated on the review's current status at use
//   time (see review-action), so a token is effectively single-use and a replay
//   is idempotent.
// - Requires env REVIEW_ACTION_SECRET; without it, signing returns null and the
//   email degrades to an "open in queue" link only.

const crypto = require("node:crypto");

const TTL_DAYS = Math.max(1, Number(process.env.REVIEW_ACTION_TTL_DAYS) || 30);

function getSecret() {
  const s = (process.env.REVIEW_ACTION_SECRET || "").trim();
  return s || null;
}

function isConfigured() {
  return !!getSecret();
}

function b64url(input) {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function b64urlToBuffer(s) {
  let str = String(s || "").replace(/-/g, "+").replace(/_/g, "/");
  while (str.length % 4) str += "=";
  return Buffer.from(str, "base64");
}

function sign(payloadB64, secret) {
  return b64url(crypto.createHmac("sha256", secret).update(payloadB64).digest());
}

function signReviewToken({ reviewId, company, action }) {
  const secret = getSecret();
  if (!secret) return null;
  const act = String(action || "").toLowerCase();
  if (act !== "approved" && act !== "rejected") return null;

  const exp = Math.floor(Date.now() / 1000) + TTL_DAYS * 24 * 3600;
  const payloadB64 = b64url(
    JSON.stringify({ rid: String(reviewId || ""), cmp: String(company || ""), act, exp })
  );
  return `${payloadB64}.${sign(payloadB64, secret)}`;
}

function verifyReviewToken(token) {
  const secret = getSecret();
  if (!secret) return { ok: false, reason: "not_configured" };

  const parts = String(token || "").split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return { ok: false, reason: "malformed" };

  const [payloadB64, sig] = parts;
  const expected = sign(payloadB64, secret);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false, reason: "bad_signature" };

  let payload;
  try {
    payload = JSON.parse(b64urlToBuffer(payloadB64).toString("utf8"));
  } catch {
    return { ok: false, reason: "bad_payload" };
  }
  if (!payload || typeof payload !== "object") return { ok: false, reason: "bad_payload" };

  const nowS = Math.floor(Date.now() / 1000);
  if (!(Number(payload.exp) > nowS)) return { ok: false, reason: "expired" };

  const act = String(payload.act || "").toLowerCase();
  if (act !== "approved" && act !== "rejected") return { ok: false, reason: "bad_action" };

  return {
    ok: true,
    reviewId: String(payload.rid || ""),
    company: String(payload.cmp || ""),
    action: act,
  };
}

module.exports = { signReviewToken, verifyReviewToken, isConfigured };
