/**
 * Read-only probe for the Phase 2 search rewrite. Runs the REAL
 * searchCompaniesHandler against the REAL Cosmos container (no deploy), so we
 * can verify the indexed search_tokens query returns correct results + timing
 * against production data BEFORE pushing.
 *
 * Usage (same shell where COSMOS_DB_* env vars are set):
 *   node scripts/probe-search.mjs
 *   node scripts/probe-search.mjs "werner paddles" "3m" "the north face"
 *
 * Requires env: COSMOS_DB_ENDPOINT, COSMOS_DB_KEY
 * Optional:     COSMOS_DB_DATABASE (default "tabarnam-db"),
 *               COSMOS_DB_COMPANIES_CONTAINER (default "companies")
 */

import { CosmosClient } from "@azure/cosmos";
import * as dotenv from "dotenv";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

dotenv.config();

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { _test } = require(join(__dirname, "..", "api", "search-companies", "index.js"));

const endpoint = process.env.COSMOS_DB_ENDPOINT;
const key = process.env.COSMOS_DB_KEY;
const databaseId = process.env.COSMOS_DB_DATABASE || "tabarnam-db";
const containerId = process.env.COSMOS_DB_COMPANIES_CONTAINER || "companies";

if (!endpoint || !key) {
  console.error("Missing COSMOS_DB_ENDPOINT or COSMOS_DB_KEY. Set them in this shell or .env.");
  process.exit(1);
}

const container = new CosmosClient({ endpoint, key }).database(databaseId).container(containerId);
const ctx = { log() {}, error() {}, warn() {} };

const queries = process.argv.slice(2);
const samples = queries.length
  ? queries
  : ["werner paddles", "candles", "3m", "the north face", "yacht", "organic almond butter", "obrilo"];

async function run() {
  console.log(`DB ${databaseId}/${containerId} — probing search-companies (real handler, real data)\n`);
  for (const q of samples) {
    const url = `https://probe.local/api/search-companies?q=${encodeURIComponent(q)}&take=5`;
    const req = { method: "GET", url, headers: new Headers() };
    const t0 = Date.now();
    let res, body;
    try {
      res = await _test.searchCompaniesHandler(req, ctx, { companiesContainer: container });
      body = JSON.parse(res.body || "{}");
    } catch (e) {
      console.log(`"${q}"  -> ERROR: ${e.message}\n`);
      continue;
    }
    const ms = Date.now() - t0;
    const items = body.items || [];
    const total = body.totalCount ?? items.length;
    console.log(`"${q}"  [${ms}ms, status ${res.status}, ${items.length} shown / ${total} total]`);
    for (const it of items.slice(0, 5)) {
      const peer = it._industryRelated ? "  (peer)" : "";
      console.log(`   - ${it.company_name || it.display_name || it.id}${peer}`);
    }
    console.log("");
  }
}

run().catch((e) => { console.error("Fatal:", e); process.exit(1); });
