"use strict";

/**
 * Per-contributor daily import quota.
 *
 * Importing costs real money (~5c/company measured), and a contributor is
 * outside help rather than staff. This bounds a single contributor's spend to a
 * known ceiling per day without bounding anyone else's.
 *
 * WHO IS COUNTED: contributors only. Admins, internal job requests (the queue
 * workers, resume-worker) and the local-dev bypass are never metered — staff
 * imports run to thousands of companies a day by design, and metering the
 * internal workers would throttle those imports mid-run.
 *
 * ACCOUNTING: one counter document per contributor per day, updated with an
 * ETag compare-and-set so concurrent batches from the same person cannot both
 * read the same starting value and double-spend. The document carries a TTL so
 * counters age out on their own rather than accumulating forever.
 *
 * FAILURE MODE: closed. If the quota store is unreachable we deny rather than
 * allow — this guards spend, and an unavailable meter is not evidence of
 * remaining budget. Staff are unaffected because staff are never metered.
 */

const DEFAULT_DAILY_LIMIT = 1000;

// The day boundary is a Pacific calendar day, not UTC and not a rolling window,
// so "today" means what it means to the person running the business.
const QUOTA_TIME_ZONE = "America/Los_Angeles";

// Counters are only interesting while the day is current; keep a short history
// for spot-checking usage, then let Cosmos reclaim them.
const QUOTA_TTL_SECONDS = 45 * 24 * 60 * 60;

const CAS_MAX_ATTEMPTS = 5;

function env(key, fallback = "") {
  const value = process.env[key];
  return (value == null ? fallback : String(value)).trim();
}

/**
 * The Pacific calendar day as YYYY-MM-DD. `en-CA` formats in that order, and
 * routing through Intl means DST transitions are handled for us.
 */
function getQuotaDayKey(now = new Date(), timeZone = QUOTA_TIME_ZONE) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

function getDailyImportLimit() {
  const raw = Number(env("CONTRIBUTOR_DAILY_IMPORT_LIMIT"));
  if (Number.isFinite(raw) && raw > 0) return Math.trunc(raw);
  return DEFAULT_DAILY_LIMIT;
}

/** Is this caller metered at all? Only contributors are. */
function isMetered(req) {
  return req?.__role === "contributor";
}

function quotaDocId(email, dayKey) {
  return `quota_${String(email || "").trim().toLowerCase()}_${dayKey}`;
}

let quotaClient = null;

function getQuotaContainer() {
  try {
    const databaseId = env("COSMOS_DB_DATABASE", "tabarnam-db");
    const containerId = env("COSMOS_DB_CONTRIBUTOR_QUOTA_CONTAINER", "contributor_quota");

    quotaClient ||= require("./_cosmosConfig").getCosmosClient();
    if (!quotaClient) return null;

    return quotaClient.database(databaseId).container(containerId);
  } catch {
    return null;
  }
}

function denial(reason, extra = {}) {
  return { ok: false, reason, ...extra };
}

/**
 * Reserve `count` companies against the caller's daily allowance.
 *
 * Returns { ok: true, used, limit, remaining } when the whole request fits, or
 * { ok: false, reason, ... } when it does not. The reservation is all-or-
 * nothing: a request for 400 with 100 left is refused outright rather than
 * partially admitted, so the caller never has to reason about which half of
 * their batch went through.
 *
 * @param {object} params
 * @param {object} params.container  quota container (injectable for tests)
 * @param {string} params.email      the contributor
 * @param {number} params.count      companies this request would create
 * @param {Date}   [params.now]
 * @param {number} [params.limit]
 */
async function consumeImportQuota(params = {}) {
  const email = String(params.email || "").trim().toLowerCase();
  const count = Math.trunc(Number(params.count) || 0);
  const limit = Number.isFinite(params.limit) ? params.limit : getDailyImportLimit();
  const now = params.now instanceof Date ? params.now : new Date();
  const dayKey = getQuotaDayKey(now);

  if (!email) return denial("unresolved_identity", { limit });

  // Nothing to charge for — a no-op request is not a quota event.
  if (count <= 0) return { ok: true, used: 0, limit, remaining: limit, charged: 0 };

  // A single request larger than the whole day's allowance can never fit; say
  // so plainly instead of letting them retry into a wall.
  if (count > limit) {
    return denial("request_exceeds_daily_limit", { limit, requested: count });
  }

  const container = params.container || getQuotaContainer();
  if (!container) return denial("quota_store_unavailable", { limit });

  const id = quotaDocId(email, dayKey);

  for (let attempt = 0; attempt < CAS_MAX_ATTEMPTS; attempt++) {
    let existing = null;
    let etag = null;

    try {
      const { resource } = await container.item(id, id).read();
      if (resource) {
        existing = resource;
        etag = resource._etag || null;
      }
    } catch (e) {
      // 404 is the normal "first import of the day" case. Anything else means
      // the store is misbehaving, and we fail closed.
      const status = Number(e?.code || e?.statusCode || 0);
      if (status !== 404) return denial("quota_store_unavailable", { limit });
    }

    const used = Math.max(0, Math.trunc(Number(existing?.used) || 0));

    if (used + count > limit) {
      return denial("daily_limit_reached", {
        limit,
        used,
        remaining: Math.max(0, limit - used),
        requested: count,
      });
    }

    const next = {
      id,
      // Partition key is /id: every contributor-day is its own partition, so a
      // busy day never becomes a hot partition for anyone else.
      contributor: email,
      day: dayKey,
      time_zone: QUOTA_TIME_ZONE,
      used: used + count,
      limit,
      updated_at: now.toISOString(),
      created_at: existing?.created_at || now.toISOString(),
      ttl: QUOTA_TTL_SECONDS,
    };

    try {
      // CAS in both directions:
      //  - counter exists  → upsert guarded by its ETag, so a batch that
      //    incremented it since our read makes this fail rather than be
      //    overwritten.
      //  - counter absent  → create, which conflicts if another batch got
      //    there first. An unguarded upsert here would let two same-day first
      //    imports both write their own total and silently lose one.
      if (etag) {
        await container.items.upsert(next, {
          accessCondition: { type: "IfMatch", condition: etag },
        });
      } else {
        await container.items.create(next);
      }

      return {
        ok: true,
        used: next.used,
        limit,
        remaining: Math.max(0, limit - next.used),
        charged: count,
        day: dayKey,
      };
    } catch (e) {
      const status = Number(e?.code || e?.statusCode || 0);
      // 412 (precondition failed) / 409 (conflict) — someone beat us to it.
      if (status === 412 || status === 409) continue;
      return denial("quota_store_unavailable", { limit });
    }
  }

  // Only reachable under sustained contention from one contributor.
  return denial("quota_contention", { limit });
}

/**
 * Turn a denial into the HTTP shape endpoints return. Kept here so every
 * caller reports the same thing.
 */
function quotaDenialResponse(result) {
  const reason = result?.reason || "quota_denied";

  const message =
    reason === "daily_limit_reached"
      ? `Daily import limit reached (${result.used}/${result.limit} companies today). The allowance resets at midnight Pacific.`
      : reason === "request_exceeds_daily_limit"
        ? `This request is ${result.requested} companies, above the ${result.limit}/day limit. Split it across days.`
        : reason === "quota_store_unavailable"
          ? "Import is temporarily unavailable: the usage meter could not be read."
          : reason === "unresolved_identity"
            ? "Forbidden: unresolved contributor identity."
            : "Import refused by the daily usage limit.";

  return {
    status: reason === "unresolved_identity" ? 403 : 429,
    body: {
      ok: false,
      error: message,
      quota_error: reason,
      limit: result?.limit ?? null,
      used: result?.used ?? null,
      remaining: result?.remaining ?? null,
    },
  };
}

module.exports = {
  consumeImportQuota,
  quotaDenialResponse,
  getQuotaDayKey,
  getDailyImportLimit,
  getQuotaContainer,
  isMetered,
  QUOTA_TIME_ZONE,
  DEFAULT_DAILY_LIMIT,
};
