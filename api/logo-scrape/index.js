const { app } = require("@azure/functions");
const { httpRequest } = require("../_http");
const { getProxyBase, json: sharedJson } = require("../_shared");

function json(obj, status = 200) {
  return {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "content-type,x-functions-key",
    },
    body: JSON.stringify(obj),
  };
}

app.http("logo-scrape", {
  route: "logo-scrape",
  methods: ["POST", "OPTIONS"],
  authLevel: "anonymous",
  handler: async (req, context) => {
    const method = String(req.method || "").toUpperCase();
    if (method === "OPTIONS") {
      return {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
          "Access-Control-Allow-Headers": "content-type,x-functions-key",
          "Access-Control-Max-Age": "86400",
        },
      };
    }

    const base = getProxyBase();
    const bodyObj = await req.json().catch(() => ({}));
    const domain = (bodyObj.domain || "").trim();
    if (!domain) {
      return json({ ok: false, error: "Missing domain" }, 400);
    }

    if (base) {
      try {
        const out = await httpRequest("POST", `${base}/logo-scrape`, {
          body: { domain },
        });
        let b = out.body;
        try {
          b = JSON.parse(out.body);
        } catch {}
        return json(b, out.status || 502);
      } catch (e) {
        return json(
          { ok: false, error: `Proxy error: ${e.message || String(e)}` },
          502
        );
      }
    }

    return json(
      {
        ok: true,
        domain,
        logo_url: `https://logo.clearbit.com/${encodeURIComponent(domain)}`,
      },
      200
    );
  },
});
