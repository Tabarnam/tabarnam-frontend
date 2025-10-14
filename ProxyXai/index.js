// Minimal proxy-xai function with optional stub + upstream forwarding.
// Works on Functions v3/v4 (node 18+). No extra deps required.

const CORS_ORIGINS = "*"; // lock this down later if you want

function corsHeaders(req) {
  const h = {
    "Access-Control-Allow-Origin": CORS_ORIGINS,
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,Authorization"
  };
  // reflect credentials only if needed
  return h;
}

function json(body, status = 200, req) {
  return {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...corsHeaders(req)
    },
    body: JSON.stringify(body)
  };
}

module.exports = async function (context, req) {
  // Preflight
  if (req.method === "OPTIONS") {
    context.res = { status: 204, headers: corsHeaders(req) };
    return;
  }

  const started = Date.now();
  const XAI_STUB = (process.env.XAI_STUB || "").trim() === "1";
  const UPSTREAM_BASE = (process.env.UPSTREAM_BASE || "").replace(/\/+$/, "");
  const UPSTREAM_KEY  = (process.env.UPSTREAM_KEY || "").trim(); // optional

  if (req.method === "GET") {
    context.res = json({
      ok: true,
      route: "/api/proxy-xai",
      stub: XAI_STUB,
      upstream: { base: !!UPSTREAM_BASE, key: !!UPSTREAM_KEY },
      now: new Date().toISOString()
    }, 200, req);
    return;
  }

  // POST
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const limit = Number(body?.limit ?? 10);

    if (XAI_STUB) {
      // Return a simple, valid shape for your frontend
      const companies = Array.from({ length: Math.max(1, Math.min(limit, 5)) }).map((_, i) => ({
        company_name: `Stub Company ${i + 1}`,
        industries: ["Example"],
        url: "https://example.com",
        amazon_url: "",
        product_keywords: "stub, demo",
        confidence_score: 0.9
      }));
      context.res = json({
        companies,
        meta: { request_id: `stub_${Date.now()}`, latency_ms: Date.now() - started, model: "stub" }
      }, 200, req);
      return;
    }

    if (!UPSTREAM_BASE) {
      context.res = json({ error: "UPSTREAM_BASE not set and XAI_STUB != 1" }, 500, req);
      return;
    }

    // Forward to upstream
    const url = `${UPSTREAM_BASE}/proxy-xai`;
    const headers = { "Content-Type": "application/json" };
    if (UPSTREAM_KEY) headers["x-api-key"] = UPSTREAM_KEY;

    const resp = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body)
    });

    const text = await resp.text();
    let parsed = {};
    try { parsed = JSON.parse(text); } catch { /* leave as {} */ }

    if (!resp.ok) {
      context.res = json({
        error: parsed?.error || `Upstream error ${resp.status}`,
        upstream_status: resp.status,
        upstream_body: text?.slice(0, 500)
      }, 502, req);
      return;
    }

    context.res = {
      status: 200,
      headers: { "Content-Type": "application/json; charset=utf-8", ...corsHeaders(req) },
      body: text  // pass through
    };
  } catch (e) {
    context.res = json({ error: e?.message || "proxy-xai failed" }, 500, req);
  }
};
