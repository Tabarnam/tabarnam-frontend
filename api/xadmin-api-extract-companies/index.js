// Extract companies — admin tool endpoint.
//
// POST { url, max_pages? }
//
// Detects the source of `url` and extracts the list of companies selling there
// (Shopify vendors today; pluggable per site — see _companyExtractSources).
// Returns the raw name list. The DB-reconciliation step (exact / possible
// duplicate) is performed by the client against the SAME `/api/import-preflight`
// endpoint that /admin/import uses, so the two flows share one source of truth
// for duplicate detection. The xAI "find the real company URL for the NEW ones"
// step runs on top of the reconciled output.
const { app } = require("../_app");
const { extractCompanies } = require("../_companyExtractSources");

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

  const url = typeof body?.url === "string" ? body.url.trim() : "";
  if (!url) return json({ ok: false, error: "missing_url" }, 400);
  const maxPages = body?.max_pages != null ? Number(body.max_pages) : undefined;

  const extraction = await extractCompanies(url, {
    maxPages,
    log: (m) => context.log?.(m),
  });

  if (!extraction.ok) {
    // invalid_url is a client error; everything else (unsupported source,
    // rate-limited probe) is a handled 200 with an explanatory message so the
    // UI can render it inline.
    if (extraction.error === "invalid_url") {
      return json({ ok: false, error: "invalid_url", message: "Enter a valid http(s) URL." }, 400);
    }
    return json({
      ok: false,
      source: extraction.source,
      url: extraction.url || url,
      message: extraction.message || extraction.error || "Extraction failed.",
      error: extraction.error || null,
      count: 0,
    });
  }

  context.log?.(
    `[extract-companies] source=${extraction.source} url=${extraction.url} ` +
    `found=${extraction.count} pages=${extraction.pages_fetched} truncated=${extraction.truncated}`
  );

  return json({
    ok: true,
    source: extraction.source,
    url: extraction.url,
    generated_at: new Date().toISOString(),
    pages_fetched: extraction.pages_fetched,
    truncated: extraction.truncated,
    truncated_reason: extraction.truncated_reason || null,
    count: extraction.count,
    companies: extraction.companies, // [{ name, product_count }]
  });
}

app.http("adminExtractCompanies", {
  route: "xadmin-api-extract-companies",
  methods: ["POST", "OPTIONS"],
  authLevel: "anonymous",
  handler: require("../_adminAuth").withAdminGuard(handler),
});

module.exports = { handler };
