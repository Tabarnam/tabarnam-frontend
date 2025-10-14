// tools/scripts/dumpCompanies.mjs (ESM)
import { CosmosClient } from "@azure/cosmos";
import fs from "fs";

function readSettings() {
  // Be tolerant of BOM
  const raw = fs.readFileSync(new URL("../local.settings.json", import.meta.url), "utf8").replace(/^\uFEFF/, "");
  const j = JSON.parse(raw);
  const v = j.Values || {};
  const required = ["COSMOS_DB_ENDPOINT", "COSMOS_DB_KEY", "COSMOS_DB_DATABASE", "COSMOS_DB_CONTAINER"];
  for (const k of required) {
    if (!v[k]) throw new Error(`Missing ${k} in local.settings.json Values`);
  }
  return v;
}

function tsToIso(ts) {
  // Cosmos _ts is seconds since epoch
  if (!Number.isFinite(Number(ts))) return "";
  return new Date(Number(ts) * 1000).toISOString();
}

(async () => {
  const v = readSettings();
  const client = new CosmosClient({ endpoint: v.COSMOS_DB_ENDPOINT, key: v.COSMOS_DB_KEY });
  const c = client.database(v.COSMOS_DB_DATABASE).container(v.COSMOS_DB_CONTAINER);

  const query = `
    SELECT TOP 20 c.company_name, c.normalized_domain, c.amazon_url,
                  c.session_id, c.created_at, c._ts
    FROM c
    ORDER BY c._ts DESC
  `;

  const { resources } = await c.items.query(query, { enableCrossPartitionQuery: true }).fetchAll();

  // decorate with readable time
  const rows = (resources || []).map(r => ({ ...r, _ts_iso: tsToIso(r._ts) }));
  console.table(rows);
})().catch(err => {
  console.error("dumpCompanies failed:", err.message);
  process.exit(1);
});
