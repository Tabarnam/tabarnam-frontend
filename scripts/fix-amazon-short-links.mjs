/**
 * Expand & clean Amazon short links (amzn.to, a.co, amzn.com, ...) stored on
 * companies, replacing them with the full canonical amazon.com URL.
 *
 * Why: short links freeze the Associate tag inside Amazon's server-side mapping,
 * so the render-time helper (withAmazonAffiliate) can't rewrite the tag on them.
 * Expanding to the full destination URL lets the helper stamp the current tag
 * (AMAZON_ASSOCIATE_TAG) on every click. Full amazon.com URLs are left alone —
 * the render helper already handles their tag.
 *
 * Usage:
 *   node scripts/fix-amazon-short-links.mjs            # DRY RUN — expands + previews, no writes
 *   node scripts/fix-amazon-short-links.mjs --execute  # writes cleaned URLs back to Cosmos
 *
 * Requires env vars: COSMOS_DB_ENDPOINT, COSMOS_DB_KEY
 * Optional:          COSMOS_DB_DATABASE (default "tabarnam-db"),
 *                    COSMOS_DB_COMPANIES_CONTAINER (default "companies")
 */

import { CosmosClient } from "@azure/cosmos";
import * as dotenv from "dotenv";
import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

dotenv.config();

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLAN_FILE = join(__dirname, "..", ".tmp", "amazon-shortlink-plan.json");

const endpoint = process.env.COSMOS_DB_ENDPOINT;
const key = process.env.COSMOS_DB_KEY;
const databaseId = process.env.COSMOS_DB_DATABASE || "tabarnam-db";
const containerId = process.env.COSMOS_DB_COMPANIES_CONTAINER || "companies";

if (!endpoint || !key) {
  console.error("Missing COSMOS_DB_ENDPOINT or COSMOS_DB_KEY. Set them in .env or as environment variables.");
  process.exit(1);
}

const execute = process.argv.includes("--execute");

// Optional: limit a run to specific companies by name, pipe-separated
// (names can contain commas/&). e.g. --only="Spiceology|Boll & Branch"
const onlyArg = process.argv.find((a) => a.startsWith("--only="));
const onlyNames = onlyArg
  ? new Set(onlyArg.slice("--only=".length).split("|").map((s) => s.trim().toLowerCase()).filter(Boolean))
  : null;

const client = new CosmosClient({ endpoint, key });
const container = client.database(databaseId).container(containerId);

const FIELDS = ["amazon_store_url", "amazon_url"];

// Amazon URL shorteners — these freeze the tag and must be expanded.
const SHORTENER_HOSTS = new Set([
  "amzn.to",
  "a.co",
  "amzn.com",
  "amzn.eu",
  "amzn.asia",
  "amzn.in",
]);

// Full Amazon retail domains — render helper already rewrites their tag.
const AMAZON_ROOT_DOMAINS = [
  "amazon.com", "amazon.ca", "amazon.co.uk", "amazon.de", "amazon.fr",
  "amazon.it", "amazon.es", "amazon.co.jp", "amazon.com.au", "amazon.in",
  "amazon.com.mx", "amazon.com.br", "amazon.sg", "amazon.ae", "amazon.sa",
  "amazon.se", "amazon.nl", "amazon.pl", "amazon.eg", "amazon.tr",
];

function hostOf(raw) {
  try {
    return new URL(String(raw).trim()).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

function isShortener(raw) {
  const h = hostOf(raw);
  return !!h && (SHORTENER_HOSTS.has(h) || [...SHORTENER_HOSTS].some((s) => h.endsWith(`.${s}`)));
}

function isFullAmazon(raw) {
  const h = hostOf(raw);
  return !!h && AMAZON_ROOT_DOMAINS.some((root) => h === root || h.endsWith(`.${root}`));
}

const UA = "Mozilla/5.0 (compatible; TabarnamLinkFixer/1.0)";

// Follow redirects (HEAD) until we land on a non-shortener host. We only need
// the destination URL, not the page body — so we stop as soon as the Location
// points at a full Amazon domain.
async function expandShortLink(shortUrl, maxHops = 6) {
  let current = shortUrl;
  for (let i = 0; i < maxHops; i++) {
    let res;
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 15000);
      res = await fetch(current, {
        method: "HEAD",
        redirect: "manual",
        headers: { "User-Agent": UA },
        signal: ctrl.signal,
      });
      clearTimeout(t);
    } catch (err) {
      return { ok: false, error: `fetch failed: ${err.message}`, url: current };
    }

    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc) return { ok: false, error: `redirect ${res.status} without Location`, url: current };
      current = new URL(loc, current).toString();
      if (!isShortener(current)) return { ok: true, url: current };
      // still a shortener → keep following
    } else {
      // No redirect. If we've already reached a full Amazon URL, accept it;
      // otherwise the short link is dead/blocked.
      if (isFullAmazon(current)) return { ok: true, url: current };
      return { ok: false, error: `status ${res.status} (not a redirect)`, url: current };
    }
  }
  return { ok: false, error: "too many redirects", url: current };
}

// Affiliate-identity params — always stripped (render helper re-adds the tag).
const AFFILIATE_PARAMS = new Set(["tag", "linkcode", "linkid", "ref_", "ref", "ascsubtag"]);

// Clean an expanded Amazon URL while preserving its destination:
//  - Self-contained pages (/dp/ASIN, /stores/page/ID, /gp/product/) → path only;
//    the ASIN/store-ID in the path fully identifies the page, all query is tracking.
//  - Search / browse pages (/s?k=...) → KEEP the query (it defines what's shown),
//    but drop the affiliate-identity params.
// The render-time helper (withAmazonAffiliate) stamps the current tag either way.
function cleanAmazonUrl(raw) {
  const u = new URL(raw);
  const path = u.pathname;
  const selfContained =
    /\/dp\//i.test(path) || /^\/gp\/(product|aw\/d)\//i.test(path) || /^\/stores\b/i.test(path);

  if (selfContained) return `${u.origin}${path}`;

  for (const k of [...u.searchParams.keys()]) {
    if (AFFILIATE_PARAMS.has(k.toLowerCase())) u.searchParams.delete(k);
  }
  const qs = u.searchParams.toString();
  return qs ? `${u.origin}${path}?${qs}` : `${u.origin}${path}`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function scanAndExpand() {
  const sql = `
    SELECT c.id, c.normalized_domain, c.company_name, c.amazon_store_url, c.amazon_url
    FROM c
    WHERE c.amazon_store_url != null OR c.amazon_url != null
  `;
  const { resources } = await container.items
    .query(sql, { enableCrossPartitionQuery: true })
    .fetchAll();

  console.log(`Found ${resources.length} companies with Amazon URLs.\n`);

  const plans = [];      // { id, normalized_domain, company_name, field, oldUrl, newUrl }
  const failures = [];   // { company_name, field, oldUrl, error }
  let fullUrlCount = 0;  // already-OK full amazon.com URLs (render handles tag)
  let otherCount = 0;    // non-amazon / unparseable
  let expanded = 0;

  for (const co of resources) {
    for (const field of FIELDS) {
      const val = co[field];
      if (!val || typeof val !== "string") continue;

      if (isShortener(val)) {
        const r = await expandShortLink(val.trim());
        await sleep(150); // be polite to amzn.to
        expanded++;
        if (expanded % 250 === 0) console.error(`  ...expanded ${expanded} short links`);
        if (r.ok) {
          plans.push({
            id: co.id,
            normalized_domain: co.normalized_domain,
            company_name: co.company_name,
            field,
            oldUrl: val,
            newUrl: cleanAmazonUrl(r.url),
          });
        } else {
          failures.push({ company_name: co.company_name || co.id, field, oldUrl: val, error: r.error });
        }
      } else if (isFullAmazon(val)) {
        fullUrlCount++;
      } else {
        otherCount++;
      }
    }
  }

  return { total: resources.length, plans, failures, fullUrlCount, otherCount };
}

function printReport({ total, plans, failures, fullUrlCount, otherCount }) {
  if (plans.length) {
    console.log(`--- ${plans.length} short link(s) to convert ---`);
    for (const p of plans) {
      console.log(`\n  ${p.company_name || p.id}  [${p.field}]`);
      console.log(`    OLD: ${p.oldUrl}`);
      console.log(`    NEW: ${p.newUrl}`);
    }
    console.log("");
  }

  if (failures.length) {
    console.log(`--- ${failures.length} short link(s) that could NOT be expanded (need manual re-grab) ---`);
    for (const f of failures) {
      console.log(`  ${f.company_name}  [${f.field}]  ${f.oldUrl}  →  ${f.error}`);
    }
    console.log("");
  }

  console.log("=== SUMMARY ===");
  console.log(`  Companies with Amazon URLs : ${total}`);
  console.log(`  Short links to convert     : ${plans.length}`);
  console.log(`  Short links failed/dead    : ${failures.length}`);
  console.log(`  Full amazon.com (already OK): ${fullUrlCount}`);
  console.log(`  Non-Amazon / unparseable   : ${otherCount}`);
}

async function applyPlans(plans) {
  if (!plans.length) {
    console.log(`\nNothing to write.`);
    return 0;
  }
  console.log(`\nWriting ${plans.length} cleaned URL(s)...`);
  let updated = 0;
  let errors = 0;

  // Group by company so multiple fields on one doc are written in a single upsert.
  const byCompany = new Map();
  for (const p of plans) {
    if (!byCompany.has(p.id)) byCompany.set(p.id, { meta: p, changes: [] });
    byCompany.get(p.id).changes.push(p);
  }

  for (const { meta, changes } of byCompany.values()) {
    try {
      const partitionKey = String(meta.normalized_domain || "unknown").trim();
      const { resource: full } = await container.item(meta.id, partitionKey).read();
      if (!full) {
        console.error(`  SKIP ${meta.company_name || meta.id} — could not read full document`);
        errors++;
        continue;
      }
      for (const c of changes) full[c.field] = c.newUrl;
      full.updated_at = new Date().toISOString();
      await container.items.upsert(full, { partitionKey });
      updated++;
      if (updated % 250 === 0) console.error(`  ...wrote ${updated}`);
    } catch (err) {
      errors++;
      console.error(`  ✗ ${meta.company_name || meta.id}: ${err.message}`);
    }
  }

  console.log(`\nDone. Companies updated: ${updated}, Errors: ${errors}`);
  return errors;
}

async function run() {
  console.log(`Database: ${databaseId} / Container: ${containerId}`);
  console.log(`Mode: ${execute ? "EXECUTE" : "DRY RUN — no changes"}\n`);

  // EXECUTE against a previously-approved plan → apply exactly what was previewed.
  if (execute && existsSync(PLAN_FILE)) {
    const saved = JSON.parse(readFileSync(PLAN_FILE, "utf-8"));
    let toApply = saved.plans;
    if (onlyNames) {
      toApply = toApply.filter((p) => onlyNames.has(String(p.company_name || "").toLowerCase()));
      console.log(`--only filter: ${onlyNames.size} name(s) requested → ${toApply.length} matching conversion(s)`);
      for (const p of toApply) console.log(`   • ${p.company_name} [${p.field}] → ${p.newUrl}`);
      console.log("");
    }
    console.log(`Applying ${toApply.length} conversion(s) from ${PLAN_FILE}\n`);
    const errors = await applyPlans(toApply);
    process.exit(errors > 0 ? 1 : 0);
  }

  // Otherwise scan + expand fresh, report, and persist the plan.
  const result = await scanAndExpand();
  printReport(result);

  mkdirSync(dirname(PLAN_FILE), { recursive: true });
  writeFileSync(
    PLAN_FILE,
    JSON.stringify({ generatedAt: new Date().toISOString(), plans: result.plans, failures: result.failures }, null, 2),
  );
  console.log(`\nPlan written to ${PLAN_FILE}`);

  if (!execute) {
    console.log(`Dry run complete. Re-run with --execute to write the ${result.plans.length} conversion(s).`);
    process.exit(0);
  }

  const errors = await applyPlans(result.plans);
  process.exit(errors > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
