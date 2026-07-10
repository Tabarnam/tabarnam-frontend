// Extract Companies — URL capture endpoint (pipeline step 3).
//
// POST { companies: [name, ...], source_url?, model?, concurrency? }
//
// Resolves each company NAME to its official website via xAI web search
// (_companyUrlLookup). The client sends the reconciled "new" companies in
// bounded batches; this endpoint fans out with limited internal concurrency so
// a batch stays within the HTTP invocation budget. Model is operator-selectable
// via XAI_URL_LOOKUP_MODEL (falls back to the app's xAI model chain) so a cheap
// model can be used for this simple lookup.
const { app } = require("../_app");
const { lookupCompanyUrlsBatch, MAX_BATCH } = require("../_companyUrlLookup");

function getCorsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Content-Type": "application/json",
  };
}

const json = (obj, status = 200) => ({
  status,
  headers: getCorsHeaders(),
  body: JSON.stringify(obj),
});

async function handler(req, context) {
  const method = String(req.method || "").toUpperCase();
  if (method === "OPTIONS") return { status: 200, headers: getCorsHeaders() };

  let body;
  try { body = await req.json(); } catch { body = {}; }

  const companies = Array.isArray(body?.companies) ? body.companies : [];
  if (companies.length === 0) return json({ ok: false, error: "no_companies" }, 400);
  if (companies.length > MAX_BATCH) {
    return json({ ok: false, error: "batch_too_large", max: MAX_BATCH }, 400);
  }

  // Use the app's existing XAI_MODEL (grok-4.3) by default — no new env var to
  // manage. XAI_URL_LOOKUP_MODEL stays as an optional override if a cheaper
  // model is ever provisioned for this simple lookup.
  const model = (
    process.env.XAI_URL_LOOKUP_MODEL ||
    process.env.XAI_MODEL ||
    body?.model ||
    ""
  ).toString().trim();

  const { results } = await lookupCompanyUrlsBatch(companies, {
    model,
    sourceUrl: typeof body?.source_url === "string" ? body.source_url : "",
    sourceContext: (() => {
      try { return body?.source_url ? new URL(body.source_url).hostname.replace(/^www\./, "") : ""; }
      catch { return ""; }
    })(),
    concurrency: body?.concurrency,
  });

  const found = results.filter((r) => r.found).length;
  // Log the error breakdown so systematic failures (bad payload shape, auth,
  // upstream outage) are visible in traces — the first production run failed
  // 935/935 with zero log signal beyond found=0.
  const errorCounts = {};
  for (const r of results) {
    if (!r.found && r.error) errorCounts[r.error] = (errorCounts[r.error] || 0) + 1;
  }
  const errorSummary = Object.entries(errorCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([e, n]) => `${e}×${n}`)
    .join(", ");
  context.log?.(
    `[extract-lookup-urls] n=${companies.length} found=${found} model=${model || "(default)"}` +
    (errorSummary ? ` errors: ${errorSummary}` : "")
  );

  return json({ ok: true, model: model || "(default)", results });
}

app.http("adminExtractLookupUrls", {
  route: "xadmin-api-extract-lookup-urls",
  methods: ["POST", "OPTIONS"],
  authLevel: "anonymous",
  handler: require("../_adminAuth").withAdminGuard(handler),
});

module.exports = { handler };
