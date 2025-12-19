/**
 * Migrate stored company.logo_url values away from SAS URLs.
 *
 * Finds companies where logo_url contains common SAS query params (sv/sig/se)
 * and replaces logo_url with the stable URL (query string removed).
 *
 * Usage:
 *   node scripts/migrate-logo-urls.mjs            # dry-run (no writes)
 *   node scripts/migrate-logo-urls.mjs --apply   # write changes
 *
 * Optional:
 *   --max=<n>         stop after processing n matching documents
 *   --pageSize=<n>    query page size (default 100)
 */

import { CosmosClient } from "@azure/cosmos";

const COSMOS_ENDPOINT = process.env.COSMOS_DB_ENDPOINT || process.env.COSMOS_ENDPOINT || "";
const COSMOS_KEY = process.env.COSMOS_DB_KEY || process.env.COSMOS_KEY || "";
const DATABASE_ID = process.env.COSMOS_DB_DATABASE || process.env.COSMOS_DB || "tabarnam-db";
const CONTAINER_ID = process.env.COSMOS_DB_COMPANIES_CONTAINER || process.env.COSMOS_CONTAINER || "companies";

function parseArgs(argv) {
  const out = { apply: false, max: null, pageSize: 100 };

  for (const raw of argv.slice(2)) {
    if (raw === "--apply") {
      out.apply = true;
      continue;
    }

    const [k, v] = raw.split("=", 2);
    if (k === "--max") {
      const n = Number(v);
      if (Number.isFinite(n) && n > 0) out.max = Math.floor(n);
      continue;
    }

    if (k === "--pageSize") {
      const n = Number(v);
      if (Number.isFinite(n) && n > 0) out.pageSize = Math.max(1, Math.min(1000, Math.floor(n)));
      continue;
    }

    throw new Error(`Unknown argument: ${raw}`);
  }

  return out;
}

function toNormalizedDomain(input = "") {
  try {
    const u = String(input || "").trim();
    if (!u) return "unknown";
    const parsed = u.startsWith("http") ? new URL(u) : new URL(`https://${u}`);
    let h = parsed.hostname.toLowerCase();
    if (h.startsWith("www.")) h = h.slice(4);
    return h || "unknown";
  } catch {
    return "unknown";
  }
}

function isLikelySasUrl(url) {
  return /[?&](sv|sig|se)=/i.test(String(url || ""));
}

function stripQueryString(url) {
  const s = String(url || "").trim();
  const idx = s.indexOf("?");
  return idx === -1 ? s : s.slice(0, idx);
}

async function main() {
  const { apply, max, pageSize } = parseArgs(process.argv);

  if (!COSMOS_ENDPOINT || !COSMOS_KEY) {
    throw new Error("Missing COSMOS_DB_ENDPOINT/COSMOS_DB_KEY (or COSMOS_ENDPOINT/COSMOS_KEY) environment variables.");
  }

  const client = new CosmosClient({ endpoint: COSMOS_ENDPOINT, key: COSMOS_KEY });
  const container = client.database(DATABASE_ID).container(CONTAINER_ID);

  const querySpec = {
    query: `SELECT * FROM c
      WHERE IS_DEFINED(c.logo_url)
        AND c.logo_url != null
        AND (
          CONTAINS(c.logo_url, "?sv=")
          OR CONTAINS(c.logo_url, "&sv=")
          OR CONTAINS(c.logo_url, "?sig=")
          OR CONTAINS(c.logo_url, "&sig=")
          OR CONTAINS(c.logo_url, "?se=")
          OR CONTAINS(c.logo_url, "&se=")
        )`,
  };

  const iterator = container.items.query(querySpec, {
    enableCrossPartitionQuery: true,
    maxItemCount: pageSize,
  });

  let scanned = 0;
  let matched = 0;
  let changed = 0;
  let skipped = 0;
  let failed = 0;

  while (true) {
    const { resources } = await iterator.fetchNext();
    if (!resources || resources.length === 0) break;

    for (const doc of resources) {
      scanned += 1;

      const current = typeof doc?.logo_url === "string" ? doc.logo_url.trim() : "";
      if (!current || !isLikelySasUrl(current)) {
        skipped += 1;
        continue;
      }

      matched += 1;
      const next = stripQueryString(current);

      if (!next || next === current) {
        skipped += 1;
        continue;
      }

      const partitionKey =
        typeof doc?.normalized_domain === "string" && doc.normalized_domain.trim()
          ? doc.normalized_domain.trim()
          : toNormalizedDomain(doc?.website_url || doc?.url || doc?.domain || "");

      if (apply) {
        try {
          const updatedDoc = {
            ...doc,
            logo_url: next,
            updated_at: new Date().toISOString(),
          };

          await container.items.upsert(updatedDoc, { partitionKey });
          changed += 1;
          console.log(`[apply] ${doc.id} logo_url updated`);
        } catch (e) {
          failed += 1;
          console.error(`[error] ${doc?.id || "(unknown id)"}: ${e?.message || String(e)}`);
        }
      } else {
        changed += 1;
        console.log(`[dry-run] ${doc.id} would update logo_url`);
      }

      if (max != null && changed >= max) {
        console.log(`Reached --max=${max}. Stopping early.`);
        console.log(JSON.stringify({ apply, scanned, matched, changed, skipped, failed }, null, 2));
        return;
      }
    }
  }

  console.log(JSON.stringify({ apply, scanned, matched, changed, skipped, failed }, null, 2));
}

main().catch((e) => {
  console.error(e?.stack || e?.message || String(e));
  process.exitCode = 1;
});
