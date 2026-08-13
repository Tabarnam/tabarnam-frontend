"use strict";

/**
 * Who owns a newly created company, and who is recorded as having brought it in.
 *
 * Both create paths (save-companies for imports, admin-companies-v2 for the
 * editor) must answer this the same way, so the rule lives here rather than
 * inline in each.
 *
 * ADMINS — a caller-supplied value wins, authenticated identity is the
 * fallback. This is deliberate: re-saving an already-attributed document must
 * not silently reassign it to whoever touched it last, and an admin importing
 * a batch on someone else's behalf needs to be able to say so.
 *
 * CONTRIBUTORS — the authenticated identity wins outright. Carried values
 * arrive in the request body and are therefore self-reported. `owner` is the
 * only thing standing between a scoped caller and the rest of the catalog, so
 * it is not a field they get to choose; nor may they attribute an import to
 * somebody else.
 *
 * `imported_by` is immutable provenance and `owner` is reassignable, so owner
 * falls back to the importer when nothing else determines it.
 */

function normalizeEmail(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.toLowerCase() : null;
}

/**
 * @param {object} params
 * @param {string} [params.role]              req.__role — "admin" | "contributor"
 * @param {string} [params.actorEmail]        the authenticated caller
 * @param {string} [params.carriedImportedBy] imported_by from the request body
 * @param {string} [params.carriedOwner]      owner from the request body
 * @returns {{ imported_by: string|null, owner: string|null }}
 */
function resolveAttribution(params = {}) {
  const actor = normalizeEmail(params.actorEmail);
  const carriedImporter = normalizeEmail(params.carriedImportedBy);
  const carriedOwner = normalizeEmail(params.carriedOwner);

  const isContributor = params.role === "contributor";

  const imported_by = isContributor
    ? actor || carriedImporter
    : carriedImporter || actor;

  const owner = isContributor ? actor || imported_by : carriedOwner || imported_by;

  return { imported_by, owner };
}

module.exports = { resolveAttribution, normalizeEmail };
