let app;
try {
  ({ app } = require("@azure/functions"));
} catch {
  app = { http() {} };
}

const { CosmosClient } = require("@azure/cosmos");

let randomUUID;
try {
  ({ randomUUID } = require("crypto"));
} catch {
  randomUUID = null;
}

function generateRequestId(req) {
  const headerKeys = ["x-request-id", "x-correlation-id", "x-client-request-id"];
  for (const k of headerKeys) {
    const v = req && req.headers ? req.headers.get?.(k) || req.headers[k] : null;
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  if (typeof randomUUID === "function") return randomUUID();
  return `req_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

function json(obj, status = 200, extraHeaders) {
  return {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,OPTIONS",
      "Access-Control-Allow-Headers":
        "content-type,authorization,x-functions-key,x-request-id,x-correlation-id,x-session-id,x-client-request-id",
      "Access-Control-Expose-Headers": "x-request-id,x-correlation-id,x-session-id",
      ...(extraHeaders && typeof extraHeaders === "object" ? extraHeaders : {}),
    },
    body: JSON.stringify(obj),
  };
}

const cosmosSmokeHandler = async (req, context) => {
  const requestId = generateRequestId(req);
  const responseHeaders = { "x-request-id": requestId };

  try {
    const method = String(req.method || "").toUpperCase();

    if (method === "OPTIONS") {
      return {
        status: 200,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET,OPTIONS",
          "Access-Control-Allow-Headers":
            "content-type,authorization,x-functions-key,x-request-id,x-correlation-id,x-session-id,x-client-request-id",
          "Access-Control-Expose-Headers": "x-request-id,x-correlation-id,x-session-id",
          ...responseHeaders,
        },
      };
    }

    if (method !== "GET") {
      return json(
        {
          ok: false,
          request_id: requestId,
          cosmos_ok: false,
          error_message: "Method not allowed",
        },
        405,
        responseHeaders
      );
    }

    const endpoint = String(
      process.env.COSMOS_DB_ENDPOINT ||
        process.env.COSMOS_ENDPOINT ||
        process.env.COSMOS_DB_DB_ENDPOINT ||
        ""
    ).trim();

    const key = String(
      process.env.COSMOS_DB_KEY ||
        process.env.COSMOS_KEY ||
        process.env.COSMOS_DB_DB_KEY ||
        ""
    ).trim();

    if (!endpoint || !key) {
      return json(
        {
          ok: false,
          request_id: requestId,
          cosmos_ok: false,
          error_message: "Cosmos environment variables are not configured (missing endpoint or key)",
        },
        500,
        responseHeaders
      );
    }

    try {
      const client = new CosmosClient({ endpoint, key });

      // Minimal, safe operation that does not depend on a specific DB/container existing.
      // This should fail fast if endpoint/key/network are wrong.
      await client.getDatabaseAccount();

      return json(
        {
          ok: true,
          request_id: requestId,
          cosmos_ok: true,
        },
        200,
        responseHeaders
      );
    } catch (e) {
      return json(
        {
          ok: false,
          request_id: requestId,
          cosmos_ok: false,
          error_message: e?.message ? String(e.message) : String(e || "Cosmos error"),
        },
        502,
        responseHeaders
      );
    }
  } catch (e) {
    return json(
      {
        ok: false,
        request_id: requestId,
        cosmos_ok: false,
        error_message: e?.message ? String(e.message) : String(e || "Unhandled error"),
      },
      500,
      responseHeaders
    );
  }
};

app.http("cosmos-smoke", {
  route: "cosmos/smoke",
  methods: ["GET", "OPTIONS"],
  authLevel: "anonymous",
  handler: cosmosSmokeHandler,
});

module.exports = {
  _test: {
    cosmosSmokeHandler,
  },
};
