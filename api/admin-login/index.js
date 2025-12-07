const { app } = require('@azure/functions');
const bcrypt = require('bcryptjs');
const crypto = require('node:crypto');

const E = (k, d = "") => (process.env[k] ?? d).toString().trim();

function getHeader(req, name) {
  if (!req || !req.headers) return "";
  const headers = req.headers;
  if (typeof headers.get === "function") {
    try {
      return headers.get(name) || headers.get(name.toLowerCase()) || "";
    } catch {
      return "";
    }
  }
  return headers[name] || headers[name.toLowerCase()] || "";
}

const cors = (req) => {
  const origin = getHeader(req, "origin") || "*";
  return {
    "Access-Control-Allow-Origin": origin,
    Vary: "Origin",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, x-client-request-id, x-session-id",
  };
};

const json = (obj, status = 200, req) => ({
  status,
  headers: { ...cors(req), "Content-Type": "application/json" },
  body: JSON.stringify(obj),
});

function parseAdminCredentials() {
  const raw = E("ADMIN_CREDENTIALS");
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") return parsed;
    } catch {}
  }
  const plain = E("ADMIN_PLAIN_CREDENTIALS");
  if (plain) {
    const out = {};
    for (const pair of plain.split(",")) {
      const [email, password] = pair.split(":");
      if (email && password) out[email.trim()] = password.trim();
    }
    return out;
  }
  return {};
}

function signToken(payload, secret) {
  const h = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const p = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto
    .createHmac("sha256", secret)
    .update(`${h}.${p}`)
    .digest("base64url");
  return `${h}.${p}.${sig}`;
}

async function getJson(req) {
  if (!req) return {};
  if (typeof req.json === "function") {
    try {
      const val = await req.json();
      if (val && typeof val === "object") return val;
    } catch {}
  }
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.rawBody === "string" && req.rawBody) {
    try {
      const parsed = JSON.parse(req.rawBody);
      if (parsed && typeof parsed === "object") return parsed;
    } catch {}
  }
  return {};
}

app.http('adminLogin', {
  route: 'xadmin-api-login',
  methods: ['POST', 'OPTIONS'],
  authLevel: 'anonymous',
  handler: async (req, context) => {
    const method = String(req.method || "").toUpperCase();
    if (method === "OPTIONS") return { status: 204, headers: cors(req) };

    let body = await getJson(req);

    const email = String(body?.email || "").trim().toLowerCase();
    const password = String(body?.password || "");
    if (!email || !password) {
      return json({ success: false, error: "Email and password are required" }, 400, req);
    }

    const creds = parseAdminCredentials();
    const configured = Object.keys(creds).length > 0;
    if (!configured) {
      return json(
        {
          success: false,
          error: "Admin credentials are not configured. Set ADMIN_CREDENTIALS (JSON of email->bcrypt hash) or ADMIN_PLAIN_CREDENTIALS.",
        },
        500,
        req
      );
    }

    const stored = creds[email];
    if (!stored) {
      return json({ success: false, error: "Email not authorized as admin" }, 401, req);
    }

    let ok = false;
    try {
      if (stored.startsWith("$2a$") || stored.startsWith("$2b$") || stored.startsWith("$2y$")) {
        ok = await bcrypt.compare(password, stored);
      } else {
        ok = stored === password;
      }
    } catch (e) {
      return json({ success: false, error: "Password verification failed" }, 500, req);
    }

    if (!ok) {
      return json({ success: false, error: "Invalid password" }, 401, req);
    }

    const secret = E("ADMIN_JWT_SECRET", "tabarnam_admin_secret");
    const now = Math.floor(Date.now() / 1000);
    const token = signToken({ sub: email, iat: now, exp: now + 60 * 60 * 8 }, secret);

    return json({ success: true, token }, 200, req);
  }
});
