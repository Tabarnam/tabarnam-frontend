// Azure Functions v4 HTTP trigger: POST /api/logo-scrape
import { app } from "@azure/functions";

app.http("logoScrape", {
  route: "logo-scrape",
  methods: ["POST", "OPTIONS"],
  authLevel: "anonymous",
  handler: async (req) => {
    if (req.method === "OPTIONS") return { status: 204, headers: cors(req) };

    let body = {};
    try { body = await req.json(); } catch {}
    const { url, domain } = body || {};

    const host = normalizeHost(url, domain);
    if (!host) {
      return json({ ok: false, error: "Provide { url } or { domain }" }, 400, req);
    }

    // 1) Try Clearbit first
    const clearbit = `https://logo.clearbit.com/${host}`;
    try {
      const head = await fetch(clearbit, { method: "HEAD" });
      if (head.ok) {
        return json({ ok: true, source: "clearbit", logo_url: clearbit }, 200, req);
      }
    } catch {}

    // 2) Fallback: fetch homepage and parse
    try {
      const homepageUrl = `https://${host}`;
      const r = await fetch(homepageUrl, { method: "GET" });
      const html = await r.text();

      const candidates = extractIconsFromHtml(html);
      const best = pickBestIcon(candidates, homepageUrl);

      if (best) return json({ ok: true, source: "html", logo_url: best }, 200, req);
      return json({ ok: false, error: "No logo tags found" }, 200, req);
    } catch (e) {
      return json({ ok: false, error: e.message || "Fetch failed" }, 500, req);
    }
  }
});

function normalizeHost(url, domain) {
  try {
    if (domain && typeof domain === "string") return domain.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
    if (url && typeof url === "string") {
      const u = new URL(/^https?:\/\//.test(url) ? url : `https://${url}`);
      return u.hostname;
    }
  } catch {}
  return null;
}

function extractIconsFromHtml(html) {
  const tags = [];

  // <meta property="og:image" content="...">
  const og = [...html.matchAll(/<meta[^>]+property=["']og:image["'][^>]*>/gi)];
  og.forEach(m => {
    const c = attr(m[0], "content");
    if (c) tags.push(c);
  });

  // <meta name="twitter:image" content="...">
  const tw = [...html.matchAll(/<meta[^>]+name=["']twitter:image["'][^>]*>/gi)];
  tw.forEach(m => {
    const c = attr(m[0], "content");
    if (c) tags.push(c);
  });

  // link rel icons
  const linkIcon = [...html.matchAll(/<link[^>]+rel=["'][^"']*icon[^"']*["'][^>]*>/gi)];
  linkIcon.forEach(m => {
    const href = attr(m[0], "href");
    if (href) tags.push(href);
  });

  // apple touch
  const apple = [...html.matchAll(/<link[^>]+rel=["'][^"']*apple-touch-icon[^"']*["'][^>]*>/gi)];
  apple.forEach(m => {
    const href = attr(m[0], "href");
    if (href) tags.push(href);
  });

  return tags.filter(Boolean);
}

function attr(tag, name) {
  const re = new RegExp(`${name}\\s*=\\s*["']([^"']+)["']`, "i");
  const m = tag.match(re);
  return m ? m[1] : null;
}

function pickBestIcon(list, baseUrl) {
  if (!Array.isArray(list) || !list.length) return null;

  // Prefer SVG/PNG by size keywords, then others
  const prioritized = [...list].sort((a, b) => score(b) - score(a));

  // Resolve relative URLs
  for (const raw of prioritized) {
    try {
      const u = new URL(raw, baseUrl);
      if (/^https?:\/\//i.test(u.toString())) return u.toString();
    } catch {
      // ignore
    }
  }
  return null;

  function score(u) {
    let s = 0;
    const url = u.toLowerCase();
    if (url.includes("logo")) s += 5;
    if (url.includes("apple-touch")) s += 4;
    if (url.includes("icon")) s += 3;
    if (url.endsWith(".svg")) s += 3;
    if (url.endsWith(".png")) s += 2;
    if (url.includes("192") || url.includes("256") || url.includes("512")) s += 1;
    return s;
  }
}

function cors(req) {
  const origin = req.headers.get("origin") || "*";
  return {
    "Access-Control-Allow-Origin": origin,
    "Vary": "Origin",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization"
  };
}
function json(obj, status = 200, req) {
  return { status, headers: { ...cors(req), "Content-Type": "application/json" }, body: JSON.stringify(obj) };
}
