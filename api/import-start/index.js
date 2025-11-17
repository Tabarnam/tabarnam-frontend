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

app.http("importStart", {
  route: "import/start",
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
        },
      };
    }

    const base = getProxyBase();

    if (base) {
      try {
        const bodyObj = await req.json().catch(() => ({}));
        const out = await httpRequest("POST", `${base}/import/start`, {
          headers: { "content-type": "application/json" },
          body: bodyObj || {},
        });
        let body = out.body;
        try {
          body = JSON.parse(out.body);
        } catch {}
        if (out.status >= 200 && out.status < 300) return json(body, out.status);
        return json({ ok: false, error: body || "Upstream error" }, out.status || 502);
      } catch (e) {
        return json(
          { ok: false, error: `Proxy error: ${e.message || String(e)}` },
          502
        );
      }
    }

    const session_id = `stub_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    return json(
      { ok: true, session_id, note: "XAI_PROXY_BASE not set; stub mode." },
      200
    );
  },
});
