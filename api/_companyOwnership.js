"use strict";

/**
 * Row-level authorization for endpoints that act on ONE company.
 *
 * The companies CRUD endpoint scopes itself inside its own queries. The
 * satellite endpoints — logo upload, homepage capture, logo retry — instead
 * take a company_id and act on it, so each needs the same question answered
 * before it does anything: may this caller touch that company?
 *
 * Answering it in one place matters more than the few lines saved. Eight
 * endpoints each hand-rolling an owner check is eight chances to get it subtly
 * wrong, and the failure is silent — a missing check looks exactly like a
 * present one until someone edits a company they do not own.
 *
 * ADMINS SHORT-CIRCUIT. Staff are unscoped, and adding a Cosmos read to their
 * path would slow every admin action to answer a question with a known answer.
 *
 * REFUSALS ARE 404. "You may not touch this" and "this does not exist" have to
 * be indistinguishable, or these endpoints become an existence oracle over the
 * catalog — probe ids, read the status code, learn what exists.
 */

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, x-functions-key, x-ms-client-principal",
};

function notFound(extra = {}) {
  return {
    status: 404,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
    body: JSON.stringify({ ok: false, error: "not_found", ...extra }),
  };
}

function forbidden(reason) {
  return {
    status: 403,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
    body: JSON.stringify({ ok: false, error: "forbidden", reason }),
  };
}

/** Is this caller restricted to companies they own? */
function isScoped(req) {
  return req?.__role === "contributor";
}

function scopedEmail(req) {
  return String(req?.__actor_email || req?.__admin_email || "").trim().toLowerCase();
}

/**
 * Gate an endpoint on ownership of a single company.
 *
 * @param {object} req            the guarded request (carries __role / __actor_email)
 * @param {string} companyId      the company the request wants to act on
 * @param {object} opts
 * @param {object} opts.container companies container
 * @param {object} [opts.context] for logging
 * @returns {Promise<null|object>} null to proceed, or an HTTP response to return
 */
async function assertCompanyAccess(req, companyId, opts = {}) {
  // Staff and internal jobs: unscoped, and no read is issued.
  if (!isScoped(req)) return null;

  const email = scopedEmail(req);
  if (!email) return forbidden("unresolved_contributor_identity");

  const id = String(companyId || "").trim();
  if (!id) return notFound();

  const container = opts.container;
  if (!container) {
    // Fail closed. Without the catalog we cannot establish ownership, and
    // "we couldn't check" must never mean "allowed".
    return forbidden("ownership_check_unavailable");
  }

  let doc = null;
  try {
    const { resources } = await container.items
      .query(
        {
          query:
            "SELECT TOP 1 c.id, c.company_id, c.owner FROM c WHERE c.id = @id OR c.company_id = @id ORDER BY c._ts DESC",
          parameters: [{ name: "@id", value: id }],
        },
        { enableCrossPartitionQuery: true }
      )
      .fetchAll();

    doc = (Array.isArray(resources) && resources[0]) || null;
  } catch (e) {
    try {
      opts.context?.log?.("[ownership] lookup failed", { company_id: id, error: e?.message });
    } catch {}
    return forbidden("ownership_check_unavailable");
  }

  if (!doc) return notFound();

  if (String(doc.owner || "").trim().toLowerCase() !== email) {
    try {
      opts.context?.log?.("[ownership] refused — not the owner", { company_id: id });
    } catch {}
    return notFound();
  }

  return null;
}

/**
 * Gate an endpoint on ownership of an IMPORT SESSION.
 *
 * Import runs are reported on by session id (status, progress, stop). Those
 * control documents historically carried no identity at all, so import-start
 * now stamps `initiated_by` on the session doc and this reads it back.
 *
 * A session doc with no `initiated_by` predates that change. It is refused for
 * contributors rather than allowed: an unattributed session is by definition
 * not one they started, and defaulting the other way would open every historic
 * import to them.
 *
 * @returns {Promise<null|object>} null to proceed, or an HTTP response
 */
async function assertSessionAccess(req, sessionId, opts = {}) {
  if (!isScoped(req)) return null;

  const email = scopedEmail(req);
  if (!email) return forbidden("unresolved_contributor_identity");

  const id = String(sessionId || "").trim();
  if (!id) return notFound();

  const container = opts.container;
  if (!container) return forbidden("ownership_check_unavailable");

  let doc = null;
  try {
    const { resources } = await container.items
      .query(
        {
          query: "SELECT TOP 1 c.id, c.initiated_by FROM c WHERE c.id = @id",
          parameters: [{ name: "@id", value: `_import_session_${id}` }],
        },
        { enableCrossPartitionQuery: true }
      )
      .fetchAll();

    doc = (Array.isArray(resources) && resources[0]) || null;
  } catch (e) {
    try {
      opts.context?.log?.("[ownership] session lookup failed", { session_id: id, error: e?.message });
    } catch {}
    return forbidden("ownership_check_unavailable");
  }

  if (!doc) return notFound();

  if (String(doc.initiated_by || "").trim().toLowerCase() !== email) {
    try {
      opts.context?.log?.("[ownership] session refused — not the initiator", { session_id: id });
    } catch {}
    return notFound();
  }

  return null;
}

module.exports = {
  assertCompanyAccess,
  assertSessionAccess,
  isScoped,
  scopedEmail,
  notFound,
  forbidden,
};
