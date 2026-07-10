// Extract companies — admin tool endpoint.
//
// POST { url, page?, page_limit? }
//
// Detects the source of `url` and extracts one CHUNK of the companies selling
// there (Shopify vendors today; pluggable per site — see _companyExtractSources).
// The client loops with `page = next_page` until `next_page` is null, so it can
// show a live ticker of pages fetched / companies found. The DB-reconciliation
// step (exact / possible duplicate) is performed by the client against the SAME
// `/api/import-preflight` endpoint that /admin/import uses, so the two flows
// share one source of truth for duplicate detection. The xAI "find the real
// company URL for the NEW ones" step runs on top of the reconciled output.
const { app } = require("../_app");
const { extractCompaniesChunk } = require("../_companyExtractSources");

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
  const startPage = body?.page != null ? Number(body.page) : 1;
  const pageLimit = body?.page_limit != null ? Number(body.page_limit) : undefined;

  const chunk = await extractCompaniesChunk(url, {
    startPage,
    pageLimit,
    log: (m) => context.log?.(m),
  });

  if (!chunk.ok) {
    // invalid_url is a client error; everything else (unsupported source,
    // rate-limited probe) is a handled 200 with an explanatory message so the
    // UI can render it inline.
    if (chunk.error === "invalid_url") {
      return json({ ok: false, error: "invalid_url", message: "Enter a valid http(s) URL." }, 400);
    }
    return json({
      ok: false,
      source: chunk.source,
      url: chunk.url || url,
      message: chunk.message || chunk.error || "Extraction failed.",
      error: chunk.error || null,
      count: 0,
    });
  }

  context.log?.(
    `[extract-companies] source=${chunk.source} url=${chunk.url} ` +
    `pages=${chunk.from_page}-${chunk.to_page} chunk_found=${chunk.companies.length} ` +
    `next=${chunk.next_page ?? "done"} truncated=${chunk.truncated}`
  );

  return json({
    ok: true,
    source: chunk.source,
    url: chunk.url,
    generated_at: new Date().toISOString(),
    from_page: chunk.from_page,
    to_page: chunk.to_page,
    next_page: chunk.next_page,
    done: chunk.done,
    truncated: chunk.truncated,
    truncated_reason: chunk.truncated_reason || null,
    count: chunk.companies.length, // this chunk
    companies: chunk.companies,    // [{ name, product_count }] for this chunk
  });
}

app.http("adminExtractCompanies", {
  route: "xadmin-api-extract-companies",
  methods: ["POST", "OPTIONS"],
  authLevel: "anonymous",
  handler: require("../_adminAuth").withAdminGuard(handler),
});

module.exports = { handler };
