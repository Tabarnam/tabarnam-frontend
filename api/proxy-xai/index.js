// api/proxy-xai/index.js  (Azure Functions v4, ESM)
import { app } from "@azure/functions";
import axios from "axios";
import { CosmosClient } from "@azure/cosmos";

const BUILD_STAMP = "proxy-xai build 2025-09-28T23:35Z";

// ----- helpers -----
function cors(req) {
  const origin = req.headers.get("origin") || "*";
  return {
    "Access-Control-Allow-Origin": origin,
    "Vary": "Origin",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers":
      "Content-Type, Authorization, x-client-request-id, x-session-id",
  };
}
function json(obj, status = 200, req) {
  return {
    status,
    headers: { ...cors(req), "Content-Type": "application/json" },
    body: JSON.stringify(obj),
  };
}
const toNormalizedDomain = (s = "") => {
  try {
    const u = s.startsWith("http") ? new URL(s) : new URL(`https://${s}`);
    let h = u.hostname.toLowerCase();
    if (h.startsWith("www.")) h = h.slice(4);
    return h || "unknown";
  } catch {
    return "unknown";
  }
};
const safeNum = (n) => (Number.isFinite(Number(n)) ? Number(n) : undefined);
function safeCenter(c) {
  const lat = safeNum(c?.lat),
    lng = safeNum(c?.lng);
  return lat !== undefined && lng !== undefined ? { lat, lng } : undefined;
}
function normalizeIndustries(input) {
  if (Array.isArray(input))
    return [...new Set(input.map((s) => String(s).trim()).filter(Boolean))];
  if (typeof input === "string")
    return [
      ...new Set(
        input
          .split(/[,;|]/)
          .map((s) => s.trim())
          .filter(Boolean)
      ),
    ];
  return [];
}
function normalizeKeywords(value, industries) {
  let kws = [];
  if (Array.isArray(value)) for (const v of value) kws.push(...String(v).split(","));
  else if (typeof value === "string") kws.push(...value.split(","));
  kws = kws.map((s) => s.trim()).filter(Boolean);
  const merged = [...new Set([...(kws || []), ...(industries || [])])].filter(Boolean);
  while (merged.length && merged.length < 5) merged.push(merged[merged.length - 1]);
  return merged.join(", ");
}
function ensureAmazonAffiliateTag(input) {
  if (!input) return { amazon_url: input, tagged: false };
  try {
    const url = new URL(input.startsWith("http") ? input : `https://${input}`);
    if (!/amazon\./i.test(url.hostname))
      return { amazon_url: url.toString(), tagged: false };
    url.searchParams.set("tag", "tabarnam00-20");
    return { amazon_url: url.toString(), tagged: true };
  } catch {
    return { amazon_url: input, tagged: false };
  }
}
function haversineMiles(lat1, lon1, lat2, lon2) {
  const toRad = (d) => (d * Math.PI) / 180,
    R = 3958.7613;
  const dLat = toRad(lat2 - lat1),
    dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
function enrichCompany(company, center) {
  const c = { ...(company || {}) };
  c.industries = normalizeIndustries(c.industries);
  c.product_keywords = normalizeKeywords(c.product_keywords, c.industries);
  const { amazon_url, tagged } = ensureAmazonAffiliateTag(c.amazon_url);
  c.amazon_url = amazon_url;
  c.amazon_url_tagged = tagged;
  const urlForDomain = c.canonical_url || c.url || "";
  c.normalized_domain = toNormalizedDomain(urlForDomain);
  if (center && Number.isFinite(c.hq_lat) && Number.isFinite(c.hq_lng)) {
    c.distance_miles = Number(
      haversineMiles(center.lat, center.lng, c.hq_lat, c.hq_lng).toFixed(1)
    );
  }
  c.social = c.social || {};
  for (const k of [
    "linkedin",
    "instagram",
    "x",
    "twitter",
    "facebook",
    "tiktok",
    "youtube",
  ]) {
    if (typeof c.social[k] !== "string") c.social[k] = c.social[k] || "";
  }
  return c;
}

// cosmos log (optional)
let cosmosClient = null;
function getLogsContainer() {
  const ep = (process.env.COSMOS_DB_ENDPOINT || "").trim();
  const key = (process.env.COSMOS_DB_KEY || "").trim();
  const db = (process.env.COSMOS_DB_DATABASE || "").trim();
  const ct = (process.env.COSMOS_DB_LOGS_CONTAINER || "import_logs").trim();
  if (!ep || !key || !db || !ct) return null;
  cosmosClient ||= new CosmosClient({ endpoint: ep, key });
  return cosmosClient.database(db).container(ct);
}
async function writeDoneLog(sessionId, payload = {}) {
  try {
    const c = getLogsContainer();
    if (!c) return;
    const doc = {
      id: `${Date.now()}-done-${Math.random().toString(36).slice(2)}`,
      session_id: sessionId,
      step: "done",
      msg: "import complete",
      ts: new Date().toISOString(),
      ...payload,
    };
    await c.items.upsert(doc, { partitionKey: sessionId });
  } catch {}
}

function toUpstreamBody(input) {
  const center = safeCenter(input.center);
  if (input.queryType && input.query) {
    const limit = Number(input.limit || input.maxImports) || 5;
    return {
      queryType: String(input.queryType),
      query: String(input.query),
      limit,
      ...(center ? { center } : {}),
    };
  }
  if (input.search && typeof input.search === "object") {
    const [field, value] = Object.entries(input.search)[0] || [];
    const q = String(value || "").trim();
    const limit = Number(input.maxImports) || 5;
    let queryType = "product_keyword";
    switch (String(field || "").toLowerCase()) {
      case "product_keywords":
        queryType = "product_keyword";
        break;
      case "industries":
        queryType = "industry";
        break;
      case "company_name":
        queryType = "company_name";
        break;
      case "headquarters_location":
        queryType = "hq_location";
        break;
      case "manufacturing_locations":
        queryType = "manufacturing_location";
        break;
      case "email_address":
        queryType = "email";
        break;
      case "url":
        queryType = "url";
        break;
      case "amazon_url":
        queryType = "amazon_url";
        break;
      default:
        queryType = "product_keyword";
    }
    return { queryType, query: q, limit, ...(center ? { center } : {}) };
  }
  return {
    queryType: "product_keyword",
    query: String(input.query || "").trim() || "candles",
    limit: Number(input.limit) || 3,
    ...(center ? { center } : {}),
  };
}

function withCodeParam(baseUrl, key) {
  try {
    const url = new URL(baseUrl);
    // Always include the key as a query parameter too (resilient to header stripping)
    url.searchParams.set("code", key);
    return url.toString();
  } catch {
    return baseUrl; // if malformed, let axios throw and report
  }
}

// proxy function
app.http("proxyXai", {
  route: "proxy-xai",
  methods: ["GET", "POST", "OPTIONS"],
  authLevel: "anonymous",
  handler: async (req, ctx) => {
    if (req.method === "OPTIONS") return { status: 204, headers: cors(req) };

    const started = Date.now();
    const vals = process.env || {};
    const XAI_STUB = (vals.XAI_STUB || "").trim() === "1";
    const baseUrl = (vals.FUNCTION_URL || "").trim();
    const funcKey = (vals.FUNCTION_KEY || "").trim();

    if (req.method === "GET") {
      return json(
        {
          ok: true,
          route: "/api/proxy-xai",
          configured: {
            FUNCTION_URL: !!baseUrl,
            FUNCTION_KEY: !!funcKey,
            XAI_STUB,
          },
          build: BUILD_STAMP,
          now: new Date().toISOString(),
        },
        200,
        req
      );
    }

    let inbound = {};
    try {
      inbound = await req.json();
    } catch {}
    const center = safeCenter(inbound.center);

    // STUB mode
    if (XAI_STUB) {
      const demo = [
        {
          company_name: "Carpigiani",
          industries: ["food & beverage", "equipment"],
          hq_lat: 44.5,
          hq_lng: 11.3,
          url: "https://www.carpigiani.com",
        },
        {
          company_name: "Bunn",
          industries: ["food & beverage", "equipment"],
          hq_lat: 40.1,
          hq_lng: -91.6,
          amazon_url: "https://www.amazon.com/dp/B000",
          url: "https://www.bunn.com",
        },
      ].map((c) => enrichCompany(c, center));
      await writeDoneLog(inbound.session_id || "", {
        saved: demo.length,
        mode: "stub",
      });
      return json(
        { companies: demo, meta: { proxy: { status: "stub", build: BUILD_STAMP } } },
        200,
        req
      );
    }

    if (!baseUrl || !funcKey) {
      return json(
        {
          error: "Server not configured (FUNCTION_URL / FUNCTION_KEY)",
          proxy: { status: "misconfigured", build: BUILD_STAMP },
        },
        500,
        req
      );
    }

    const upstreamBody = {
      ...toUpstreamBody(inbound),
      session_id: inbound.session_id || "",
    };

    const finalUrl = withCodeParam(baseUrl, funcKey);

    try {
      const res = await axios.post(finalUrl, upstreamBody, {
        headers: {
          "Content-Type": "application/json",
          // Send header too; some hosts expect it, others ignore it.
          "x-functions-key": funcKey,
        },
        timeout: Math.max(1000, Number(vals.XAI_TIMEOUT_MS) || 600000),
      });

      // If upstream itself returned non-2xx, surface it (don’t silently swallow)
      if (res.status < 200 || res.status >= 300) {
        return json(
          {
            error: "Upstream returned non-2xx",
            upstream: {
              status: res.status,
              data: res.data,
              headers: res.headers,
            },
            request: { url: finalUrl, body: upstreamBody },
            proxy: { status: "upstream_error", build: BUILD_STAMP },
            duration_ms: Date.now() - started,
          },
          502,
          req
        );
      }

      const companies = Array.isArray(res.data?.companies)
        ? res.data.companies
        : [];
      const enriched = companies.map((c) => enrichCompany(c, center));
      await writeDoneLog(upstreamBody.session_id || "", {
        saved: enriched.length,
        mode: "live",
      });
      return json(
        {
          companies: enriched,
          meta: {
            proxy: { status: "ok", build: BUILD_STAMP },
            upstream: { status: res.status },
          },
          duration_ms: Date.now() - started,
        },
        200,
        req
      );
    } catch (e) {
      // Capture as much as possible for diagnosis
      const upstream =
        e?.response
          ? {
              status: e.response.status,
              data: e.response.data,
              headers: e.response.headers,
            }
          : {
              network: {
                message: e?.message || String(e),
                code: e?.code || null,
                cause: e?.cause?.message || null,
              },
            };
      return json(
        {
          error: "Upstream call failed",
          upstream,
          request: { url: finalUrl, body: upstreamBody },
          proxy: { status: "error", build: BUILD_STAMP },
          duration_ms: Date.now() - started,
        },
        502,
        req
      );
    }
  },
});
