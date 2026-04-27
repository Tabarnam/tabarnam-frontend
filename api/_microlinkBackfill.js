// Shared per-company Microlink fetch+persist logic.
//
// Both the bulk backfill workers (xadmin-api-backfill-{logos,homepages}-start)
// and the per-row admin endpoint (xadmin-api-microlink-fetch-one) call into
// this module so the field-write semantics stay in one place. Diverging the
// per-asset field set across two callsites was the original sin we cleaned up
// here — if a future change adds, say, a logo_etag field, it goes in one spot.

const { CosmosClient } = require("@azure/cosmos");
const { BlobServiceClient, StorageSharedKeyCredential } = require("@azure/storage-blob");
const { v4: uuidv4 } = require("uuid");

const { fetchMicrolinkScreenshot, fetchMicrolinkLogo, reencodeAsWebp } = require("./_microlinkClient");
const { uploadBufferToBlob } = require("./_logoImport");

const E = (key, def = "") => (process.env[key] ?? def).toString().trim();

// Module-level cached clients. Each Function App instance creates these once,
// not per-call. Safe because both Cosmos and Blob client objects are
// thread-safe per the SDK contract.
let cosmosClient = null;
function getCosmosClient() {
  const endpoint = E("COSMOS_DB_ENDPOINT");
  const key = E("COSMOS_DB_KEY");
  if (!endpoint || !key) return null;
  cosmosClient ||= new CosmosClient({ endpoint, key });
  return cosmosClient;
}
function getCompaniesContainer() {
  const c = getCosmosClient();
  if (!c) return null;
  return c.database(E("COSMOS_DB_DATABASE", "tabarnam-db")).container(E("COSMOS_DB_COMPANIES_CONTAINER", "companies"));
}

let blobService = null;
function getHomepagesContainerClient() {
  const accountName = E("AZURE_STORAGE_ACCOUNT_NAME", "tabarnamstor2356");
  const accountKey = E("AZURE_STORAGE_ACCOUNT_KEY");
  if (!accountKey) return null;
  if (!blobService) {
    const creds = new StorageSharedKeyCredential(accountName, accountKey);
    blobService = new BlobServiceClient(`https://${accountName}.blob.core.windows.net`, creds);
  }
  return blobService.getContainerClient("company-homepages");
}

// ────────── HOMEPAGE ──────────

/**
 * Fetch a homepage screenshot for one company and persist the result.
 *
 * On success: writes homepage_image_url, homepage_fetch_status="ok",
 * homepage_fetched_at, resets homepage_fetch_attempts. If opts.autoApprove
 * is true (bulk job default), also sets homepage_approved + images_approved.
 *
 * On failure: writes homepage_fetch_status="failed", homepage_fetch_error,
 * increments homepage_fetch_attempts.
 *
 * Returns: { ok, homepage_image_url, reason, started_at, duration_ms }
 *
 * @param {object} company - company doc with at least id, normalized_domain, website_url
 * @param {object} ctx - logger ({ log })
 * @param {object} [opts]
 * @param {boolean} [opts.autoApprove=false] - set approval flags on success
 */
async function fetchAndPersistHomepageForCompany(company, ctx, opts = {}) {
  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();
  const result = (extra) => ({ started_at: startedAt, duration_ms: Date.now() - startedAtMs, ...extra });

  const containerClient = getHomepagesContainerClient();
  if (!containerClient) return result({ ok: false, reason: "blob_storage_not_configured" });

  let payload;
  try {
    const fetched = await fetchMicrolinkScreenshot(company.website_url, ctx);
    if (!fetched.ok) {
      payload = { ok: false, reason: fetched.reason };
    } else {
      let webp;
      try { webp = await reencodeAsWebp(fetched.bytes); }
      catch (e) { payload = { ok: false, reason: `reencode_failed: ${e?.message || e}` }; }

      if (!payload) {
        const blobName = `${company.id}/${uuidv4()}.webp`;
        const blob = containerClient.getBlockBlobClient(blobName);
        try {
          await blob.upload(webp, webp.length, { blobHTTPHeaders: { blobContentType: "image/webp" } });
          payload = { ok: true, homepage_image_url: blob.url };
        } catch (e) {
          payload = { ok: false, reason: `blob_upload_failed: ${e?.message || e}` };
        }
      }
    }
  } catch (e) {
    payload = { ok: false, reason: `exception: ${e?.message || e}` };
  }

  await persistHomepageOnDoc(company, payload, ctx, opts);
  return result(payload);
}

async function persistHomepageOnDoc(company, payload, ctx, opts = {}) {
  const companiesContainer = getCompaniesContainer();
  if (!companiesContainer) return;
  const partitionKey = String(company.normalized_domain || "unknown").trim();
  try {
    const { resource: doc } = await companiesContainer.item(company.id, partitionKey).read();
    if (!doc) return;
    if (payload.ok) {
      doc.homepage_image_url = payload.homepage_image_url;
      doc.homepage_fetch_status = "ok";
      doc.homepage_fetch_error = null;
      doc.homepage_fetched_at = new Date().toISOString();
      // A successful capture clears the failure counter so future audits
      // (e.g. an admin tool that surfaces "tried N times") read clean.
      doc.homepage_fetch_attempts = 0;
      if (opts.autoApprove) {
        // Bulk job default: visible to public users immediately. Per-row
        // admin clicks pass autoApprove=false so the admin reviews first.
        doc.homepage_approved = true;
        doc.images_approved = true;
      }
    } else {
      doc.homepage_fetch_status = "failed";
      doc.homepage_fetch_error = String(payload.reason || "unknown");
      doc.homepage_fetched_at = new Date().toISOString();
      // Persistent across jobs so a site that's failed every renderer we've
      // ever tried stops being re-pulled. Capped by maxAttempts in isPending().
      doc.homepage_fetch_attempts = (Number(doc.homepage_fetch_attempts) || 0) + 1;
    }
    doc.updated_at = new Date().toISOString();
    await companiesContainer.items.upsert(doc, { partitionKey });
  } catch (e) {
    ctx?.log?.(`[microlink-backfill] persist homepage ${company.id} failed: ${e?.message || e}`);
  }
}

// ────────── LOGO ──────────

/**
 * Fetch a logo for one company and persist the result.
 *
 * On success: writes logo_url (SAS-signed blob URL), logo_source_url
 * (Microlink's CDN URL), logo_source_type, logo_status="imported",
 * logo_import_status, logo_stage_status, logo_fetched_at, resets
 * logo_fetch_attempts. logo_approved is forced to false so the new logo
 * shows up unapproved for admin review.
 *
 * On failure: writes logo_status="failed", logo_error, increments
 * logo_fetch_attempts.
 *
 * Returns: { ok, logo_url, logo_source_url, reason, started_at, duration_ms }
 */
async function fetchAndPersistLogoForCompany(company, ctx, opts = {}) {
  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();
  const result = (extra) => ({ started_at: startedAt, duration_ms: Date.now() - startedAtMs, ...extra });

  let payload;
  try {
    const fetched = await fetchMicrolinkLogo(company.website_url, ctx);
    if (!fetched.ok) {
      payload = { ok: false, reason: fetched.reason };
    } else {
      // force=true: caller (either pending-criterion in bulk job, or admin
      // intent in the per-row endpoint) has already decided the existing logo
      // is replaceable. The blob-size guard inside uploadBufferToBlob would
      // otherwise silently drop legitimate replacements.
      let blobUrl;
      try {
        blobUrl = await uploadBufferToBlob(
          { companyId: company.id, buffer: fetched.bytes, ext: fetched.ext, contentType: fetched.contentType },
          ctx,
          { force: true }
        );
        payload = { ok: true, logo_url: blobUrl, logo_source_url: fetched.sourceUrl };
      } catch (e) {
        payload = { ok: false, reason: `blob_upload_failed: ${e?.message || e}` };
      }
    }
  } catch (e) {
    payload = { ok: false, reason: `exception: ${e?.message || e}` };
  }

  // opts is reserved for future flags (e.g. autoApprove); intentionally
  // unused right now since logos always land unapproved.
  void opts;
  await persistLogoOnDoc(company, payload, ctx);
  return result(payload);
}

async function persistLogoOnDoc(company, payload, ctx) {
  const companiesContainer = getCompaniesContainer();
  if (!companiesContainer) return;
  const partitionKey = String(company.normalized_domain || "unknown").trim();
  try {
    const { resource: doc } = await companiesContainer.item(company.id, partitionKey).read();
    if (!doc) return;
    if (payload.ok) {
      doc.logo_url = payload.logo_url;
      doc.logo_source_url = payload.logo_source_url || null;
      doc.logo_source_type = "microlink_backfill";
      doc.logo_status = "imported";
      doc.logo_import_status = "imported";
      doc.logo_stage_status = "imported";
      doc.logo_error = null;
      doc.logo_fetched_at = new Date().toISOString();
      doc.logo_fetch_attempts = 0;
      // Always unapproved. Admin reviews and flips logo_approved (or
      // images_approved) in /admin/images.
      doc.logo_approved = false;
    } else {
      doc.logo_status = "failed";
      doc.logo_error = String(payload.reason || "unknown");
      doc.logo_fetched_at = new Date().toISOString();
      doc.logo_fetch_attempts = (Number(doc.logo_fetch_attempts) || 0) + 1;
    }
    doc.updated_at = new Date().toISOString();
    await companiesContainer.items.upsert(doc, { partitionKey });
  } catch (e) {
    ctx?.log?.(`[microlink-backfill] persist logo ${company.id} failed: ${e?.message || e}`);
  }
}

module.exports = {
  fetchAndPersistHomepageForCompany,
  fetchAndPersistLogoForCompany,
};
