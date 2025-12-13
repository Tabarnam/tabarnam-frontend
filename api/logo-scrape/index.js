const { app } = require("@azure/functions");
const { discoverLogoSourceUrl } = require("../_logoImport");

function json(obj, status = 200) {
  return {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
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

    const bodyObj = await req.json().catch(() => ({}));
    const domain = String(bodyObj.domain || "").trim();
    const websiteUrl = String(bodyObj.website_url || bodyObj.url || "").trim();

    if (!domain && !websiteUrl) {
      return json({ ok: false, error: "Missing domain" }, 400);
    }

    try {
      const out = await discoverLogoSourceUrl({ domain, websiteUrl }, context);
      return json(
        {
          ok: Boolean(out?.ok),
          domain: domain || "",
          website_url: websiteUrl || "",
          logo_source_url: out?.logo_source_url || "",
          logo_url: out?.logo_source_url || "",
          strategy: out?.strategy || "",
          page_url: out?.page_url || "",
          warning: out?.warning || "",
          error: out?.error || "",
        },
        out?.ok ? 200 : 404
      );
    } catch (e) {
      return json({ ok: false, error: e?.message || String(e) }, 500);
    }
  },
});
