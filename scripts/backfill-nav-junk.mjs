/**
 * One-time cleanup of WEBSITE-NAVIGATION junk (and leaked xAI JSON) from stored
 * product lists. Deliberately does NOT use the heuristic sanitizeKeywords — that
 * keeps deleting real products (model numbers, acronyms, "Cookies", Magnum
 * Research firearms). This removes a term ONLY when it:
 *   1. exactly matches the explicit NAV_DENYLIST (lowercased + whitespace-collapsed), OR
 *   2. is leaked JSON (contains {}/[], a "key": pair, or a leading quote).
 * Everything else is kept. No import-pipeline or _requiredFields changes.
 *
 * Usage:
 *   node scripts/backfill-nav-junk.mjs           # dry-run (no writes)
 *   node scripts/backfill-nav-junk.mjs --apply   # write to Cosmos
 *
 * Required env: COSMOS_DB_ENDPOINT, COSMOS_DB_KEY
 */

import { CosmosClient } from "@azure/cosmos";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { applySortKeys } = require("../api/_sortKeys.js");
const { computeContractEnrichmentHealth } = require("../api/_contractHealth.js");

const ENDPOINT = process.env.COSMOS_DB_ENDPOINT || "";
const KEY = process.env.COSMOS_DB_KEY || "";
const DB = process.env.COSMOS_DB_DATABASE || "tabarnam-db";
const CONTAINER = process.env.COSMOS_DB_COMPANIES_CONTAINER || "companies";
const DRY_RUN = !process.argv.includes("--apply");

if (!ENDPOINT || !KEY) {
  console.error("Missing COSMOS_DB_ENDPOINT or COSMOS_DB_KEY env vars");
  process.exit(1);
}

// Website navigation / chrome / store-merchandising labels — never a product a
// user would search. Exact-match only (normalized). KEEP gift cards, subscriptions,
// bundles, gifts, Cookies, model numbers, acronyms — anything not listed here.
const NAV_DENYLIST = new Set([
  "homepage", "home", "about", "about us", "our story", "our mission", "contact", "contact us",
  "faq", "faqs", "help", "support", "customer service", "customer support", "privacy policy",
  "terms", "terms of service", "terms & conditions", "terms and conditions", "cookie policy",
  "accessibility", "shipping", "shipping & returns", "returns", "returns & exchanges", "refund",
  "refund policy", "refunds", "track order", "order tracking", "order status", "my account",
  "account", "login", "log in", "sign in", "sign up", "signup", "register", "register or sign in",
  "create account", "my orders", "cart", "view cart", "my bag", "checkout", "wishlist",
  "my wishlist", "favorites", "favourites", "search", "open search", "advanced search", "menu",
  "main menu", "menus", "sitemap", "site map", "skip to content", "back to top", "blog", "news",
  "press", "press release", "press releases", "media", "careers", "jobs", "locations",
  "store locator", "find a store", "find in store", "stores", "newsletter", "view all",
  "learn more", "read more", "see all", "see more", "show more", "quick view", "size guide",
  "size chart", "gift guide", "rewards", "loyalty", "refer a friend", "affiliates",
  "affiliate program", "wholesale", "wholesale inquiries", "fast order", "product registration",
  "new arrivals", "new", "best sellers", "best seller", "bestsellers", "shop", "shop all",
  "shop all products", "shop by category", "shop by concern", "shop by print", "all products",
  "featured", "sale", "sale items", "on sale", "clearance", "last chance", "deals", "promotions",
  "promotional products", "promotional items", "sample sale", "staff favorites", "staff picks",
  "trending", "collections", "order", "what", "products", "product",
]);

const norm = (s) => String(s || "").trim().toLowerCase().replace(/\s+/g, " ");
// Leaked JSON only: brackets, a "key": pair, or a value that is ENTIRELY one
// quoted string (bare JSON values like "google.com", "amzn.to"). NOT a blanket
// includes('"') / leading-quote — those nuke real products with inch marks
// (HEPA Filter 2.5"), quoted phrases ("Touch Me" Body Wash, Wake & "No Bake"),
// or leading quoted names ("Mama Mia" Italian Soup Blend, "Pit Master" Apron).
const isJSON = (t) => /[{}[\]]/.test(t) || /"\s*:|:\s*"/.test(t) || /^\s*"[^"]*"\s*$/.test(t);
const isNavJunk = (t) => NAV_DENYLIST.has(norm(t)) || isJSON(t);

const asStr = (v) => (typeof v === "string" ? v : v == null ? "" : String(v));
// Union of stored product entries (product_keywords + keywords), trimmed + deduped.
function storedProductList(doc) {
  const out = [];
  const pk = doc.product_keywords;
  if (typeof pk === "string") for (const s of pk.split(/\s*,\s*/g)) { const t = s.trim(); if (t) out.push(t); }
  else if (Array.isArray(pk)) for (const s of pk) { const t = asStr(s).trim(); if (t) out.push(t); }
  if (Array.isArray(doc.keywords)) for (const s of doc.keywords) { const t = asStr(s).trim(); if (t) out.push(t); }
  const seen = new Set();
  const deduped = [];
  for (const t of out) { const k = t.toLowerCase(); if (!seen.has(k)) { seen.add(k); deduped.push(t); } }
  return deduped;
}

const container = new CosmosClient({ endpoint: ENDPOINT, key: KEY }).database(DB).container(CONTAINER);

console.log(DRY_RUN ? "=== DRY RUN (pass --apply to write) ===" : "=== APPLYING CHANGES ===");
console.log(`Cosmos: ${DB}/${CONTAINER}`);

const queryIterator = container.items.query({
  query: `
    SELECT * FROM c
    WHERE (NOT IS_DEFINED(c.is_deleted) OR c.is_deleted != true)
      AND NOT STARTSWITH(c.id, "_import_")
      AND NOT STARTSWITH(c.id, "refresh_job_")
      AND NOT STARTSWITH(c.id, "resume_")
      AND (NOT IS_DEFINED(c.type) OR c.type != "import_control")
  `,
}, { enableCrossPartitionQuery: true });

let total = 0;
let changed = 0;
let emptied = 0;
let removedTotal = 0;
let failed = 0;
const freq = new Map();
const sample = [];
const emptiedNames = [];

while (queryIterator.hasMoreResults()) {
  const { resources } = await queryIterator.fetchNext();
  for (const doc of resources || []) {
    total++;
    const before = storedProductList(doc);
    if (before.length === 0) continue;

    const kept = before.filter((t) => !isNavJunk(t));
    const removed = before.filter((t) => isNavJunk(t));
    if (removed.length === 0) continue;

    changed++;
    removedTotal += removed.length;
    if (kept.length === 0) { emptied++; if (emptiedNames.length < 30) emptiedNames.push(doc.company_name || doc.name || doc.id); }
    for (const r of removed) { const k = r.toLowerCase(); const e = freq.get(k) || { n: 0, s: r }; e.n++; freq.set(k, e); }
    if (sample.length < 25) sample.push({ name: doc.company_name || doc.name, removed: removed.slice(0, 10), kept: kept.length });

    if (!DRY_RUN) {
      doc.keywords = kept;
      doc.product_keywords = kept.join(", ");
      delete doc._kwCacheKey;
      delete doc._kwRelevantCount;
      try {
        const fresh = computeContractEnrichmentHealth(doc);
        if (fresh && typeof fresh === "object") doc.enrichment_health = fresh;
      } catch { /* keep existing health */ }
      try {
        applySortKeys(doc);
        await container.item(doc.id, doc.normalized_domain || doc.id).replace(doc);
      } catch {
        try {
          applySortKeys(doc);
          await container.items.upsert(doc);
        } catch (e2) {
          failed++;
          if (failed <= 5) console.error(`Failed to write ${doc.id}:`, e2?.message || e2);
        }
      }
    }

    if (changed % 200 === 0) console.log(`  ${changed} cleaned so far (${total} scanned)…`);
  }
}

console.log("");
console.log("=== Summary ===");
console.log(`Total scanned:               ${total}`);
console.log(`Companies with junk removed: ${changed}`);
console.log(`  of those emptied entirely: ${emptied}`);
console.log(`Total terms removed:         ${removedTotal}`);
console.log(`Distinct terms removed:      ${freq.size}`);
console.log(`Failed writes:               ${failed}`);
console.log("");
console.log("Emptied-entirely companies:", emptiedNames.join(", ") || "(none)");
console.log("");
console.log("Sample (removed → kept count):");
for (const s of sample) console.log(`  ${s.name}: [${s.removed.join(" | ")}] → ${s.kept} kept`);

if (DRY_RUN) console.log("\nDry run only. Re-run with --apply to write to Cosmos.");
