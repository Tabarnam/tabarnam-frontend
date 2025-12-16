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

app.http("import-status", {
  route: "import/status",
  methods: ["GET", "OPTIONS"],
  authLevel: "anonymous",
  handler: async (req, context) => {
    const method = String(req.method || "").toUpperCase();
    if (method === "OPTIONS") {
      return {
        status: 200,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
          "Access-Control-Allow-Headers": "content-type,x-functions-key",
        },
      };
    }

    const base = getProxyBase();
    const url = new URL(req.url);
    const session_id = (url.searchParams.get("session_id") || "").trim();
    const take = Number(url.searchParams.get("take") || 10) || 10;

    if (!session_id) {
      return json({ ok: false, error: "Missing session_id" }, 400);
    }

    if (base) {
      try {
        const fullUrl = `${base}/import/status?session_id=${encodeURIComponent(
          session_id
        )}&take=${encodeURIComponent(take)}`;
        const out = await httpRequest("GET", fullUrl);
        let body = out.body;
        try {
          body = JSON.parse(out.body);
        } catch {}
        if (out.status >= 200 && out.status < 300) return json(body, out.status);
        return json(
          { ok: false, error: body || "Upstream error" },
          out.status || 502
        );
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
        session_id,
        items: [],
        completed: true,
        note: "XAI_PROXY_BASE not set; stub mode.",
      },
      200
    );
  },
});
