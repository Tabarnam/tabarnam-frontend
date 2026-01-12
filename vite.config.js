// vite.config.js
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "path";
import fs from "fs";
import path from "path";

function isNonEmptyString(v) {
  return typeof v === "string" && v.trim().length > 0;
}

function normalizeSha(v) {
  const s = String(v || "").trim();
  if (!s) return "";
  const m = s.match(/[0-9a-f]{7,40}/i);
  return m ? m[0] : s;
}

function looksLikeSha(v) {
  const s = String(v || "").trim();
  return /^[0-9a-f]{7,40}$/i.test(s);
}

function tryReadFile(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
}

function tryReadGitShaFromRepoRoot(repoRoot) {
  const gitDir = path.join(repoRoot, ".git");
  const head = tryReadFile(path.join(gitDir, "HEAD")).trim();
  if (!head) return "";

  if (looksLikeSha(head)) return head;

  const refMatch = head.match(/^ref:\s+(.+)$/);
  if (!refMatch) return "";

  const refPath = path.join(gitDir, refMatch[1].trim());
  const refSha = tryReadFile(refPath).trim();
  if (looksLikeSha(refSha)) return refSha;

  const packed = tryReadFile(path.join(gitDir, "packed-refs"));
  if (!packed) return "";

  const refName = refMatch[1].trim();
  const lines = packed
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#") && !l.startsWith("^"));

  for (const line of lines) {
    const parts = line.split(/\s+/);
    if (parts.length < 2) continue;
    const [sha, ref] = parts;
    if (ref === refName && looksLikeSha(sha)) return sha;
  }

  return "";
}

function resolveBuildIdFromEnvOrGit() {
  const env = process.env || {};
  const candidates = [
    env.WEBSITE_COMMIT_HASH,
    env.SCM_COMMIT_ID,
    env.BUILD_SOURCEVERSION,
    env.GITHUB_SHA,
    env.BUILD_ID,
    env.COMMIT_SHA,
    env.SOURCE_VERSION,
    env.NETLIFY_COMMIT_SHA,
    env.VERCEL_GIT_COMMIT_SHA,
  ];

  for (const c of candidates) {
    if (!isNonEmptyString(c)) continue;
    const normalized = normalizeSha(c);
    if (isNonEmptyString(normalized)) return normalized;
  }

  const repoRoot = resolve(__dirname);
  const gitSha = tryReadGitShaFromRepoRoot(repoRoot);
  if (isNonEmptyString(gitSha)) return gitSha;

  return "unknown";
}

// Custom plugin to copy staticwebapp.config.json to dist/
const copyStaticWebAppConfig = {
  name: "copy-staticwebapp-config",
  apply: "build",
  writeBundle() {
    const src = resolve(__dirname, "public/staticwebapp.config.json");
    const dest = resolve(__dirname, "dist/staticwebapp.config.json");
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, dest);
      console.log(`✓ Copied staticwebapp.config.json to dist/`);
    } else {
      console.warn(`⚠ staticwebapp.config.json not found in public/`);
    }
  },
};

// Emit dist/__build_id.txt for production verification (SWA often doesn't expose commit env vars at runtime)
const emitBuildIdFile = {
  name: "emit-build-id-file",
  apply: "build",
  writeBundle() {
    const buildId = resolveBuildIdFromEnvOrGit();
    const dest = resolve(__dirname, "dist/__build_id.txt");
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, `${buildId}\n`, "utf8");
    console.log(`✓ Wrote __build_id.txt (${String(buildId).slice(0, 8)}…)`);
  },
};

function tryJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function withCorsHeaders(res) {
  try {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "content-type");
  } catch {
    // ignore
  }
}

function sendJson(res, status, body) {
  try {
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json");
    withCorsHeaders(res);
    res.end(JSON.stringify(body));
  } catch {
    try {
      res.end();
    } catch {
      // ignore
    }
  }
}

function readNodeRequestBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 1_000_000) {
        // prevent runaway memory
        data = data.slice(0, 1_000_000);
      }
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

const devGoogleMiddleware = {
  name: "dev-google-middleware",
  apply: "serve",
  configureServer(server) {
    const googleKey =
      (process.env.GOOGLE_GEOCODE_KEY && String(process.env.GOOGLE_GEOCODE_KEY).trim()) ||
      (process.env.GOOGLE_MAPS_KEY && String(process.env.GOOGLE_MAPS_KEY).trim()) ||
      "";

    const translateEndpoint =
      (process.env.GOOGLE_TRANSLATE_ENDPOINT && String(process.env.GOOGLE_TRANSLATE_ENDPOINT).trim()) ||
      "https://translation.googleapis.com/language/translate/v2";

    if (!isNonEmptyString(googleKey)) return;

    server.middlewares.use("/__dev/google/geocode", async (req, res, next) => {
      if (req.method === "OPTIONS") {
        withCorsHeaders(res);
        res.statusCode = 200;
        return res.end();
      }

      if (req.method !== "POST") return next();

      const rawText = await readNodeRequestBody(req).catch(() => "");
      const body = (rawText && tryJsonParse(rawText)) || {};

      const address = typeof body.address === "string" ? body.address.trim() : "";
      const lat = Number(body.lat);
      const lng = Number(body.lng);
      const hasLatLng = Number.isFinite(lat) && Number.isFinite(lng);
      const ipLookup = body.ipLookup === true || body.ipLookup === "true";
      const strict = body.strict === true || body.strict === "true";

      const params = new URLSearchParams();
      if (hasLatLng) params.set("latlng", `${lat},${lng}`);
      else if (address) params.set("address", address);

      if (!params.toString()) {
        if (strict) return sendJson(res, 200, { error: "geocode_failed", source: "none", best: null });
        return sendJson(res, 200, {
          best: {
            location: { lat: 34.0983, lng: -117.8076 },
            components: [{ types: ["country"], short_name: "US" }],
          },
          source: "fallback",
        });
      }

      params.set("key", googleKey);

      try {
        const url = `https://maps.googleapis.com/maps/api/geocode/json?${params.toString()}`;
        const r = await fetch(url);
        const data = await r.json().catch(() => null);

        if (r.ok && data && Array.isArray(data.results) && data.results.length) {
          const first = data.results[0];
          const loc = first.geometry?.location;
          const components = Array.isArray(first.address_components)
            ? first.address_components.map((c) => ({
                long_name: c.long_name,
                short_name: c.short_name,
                types: c.types,
              }))
            : [];

          if (loc && typeof loc.lat === "number" && typeof loc.lng === "number") {
            return sendJson(res, 200, {
              best: {
                location: { lat: loc.lat, lng: loc.lng },
                components,
              },
              raw: data,
              source: "google",
            });
          }
        }
      } catch {
        // ignore and try ipLookup/fallback below
      }

      if (ipLookup) {
        try {
          const r = await fetch("https://ipapi.co/json/");
          const d = await r.json().catch(() => null);
          const ilat = Number(d?.latitude);
          const ilng = Number(d?.longitude);
          if (Number.isFinite(ilat) && Number.isFinite(ilng)) {
            const components = [];
            if (d?.country_code) components.push({ types: ["country"], short_name: d.country_code });
            if (d?.city) components.push({ types: ["locality"], short_name: d.city, long_name: d.city });

            return sendJson(res, 200, {
              best: { location: { lat: ilat, lng: ilng }, components },
              source: "ipapi",
            });
          }
        } catch {
          // ignore
        }
      }

      if (strict) return sendJson(res, 200, { error: "geocode_failed", source: "none", best: null });

      return sendJson(res, 200, {
        best: {
          location: { lat: 34.0983, lng: -117.8076 },
          components: [{ types: ["country"], short_name: "US" }],
        },
        source: "fallback",
      });
    });

    server.middlewares.use("/__dev/google/places", async (req, res, next) => {
      if (req.method === "OPTIONS") {
        withCorsHeaders(res);
        res.statusCode = 200;
        return res.end();
      }

      if (req.method !== "GET") return next();

      const u = new URL(req.url || "/", "http://127.0.0.1");
      const input = String(u.searchParams.get("input") || "").trim();
      const country = String(u.searchParams.get("country") || "").trim();
      const placeId = String(u.searchParams.get("place_id") || "").trim();

      if (!input && !placeId) return sendJson(res, 400, { error: "Missing input or place_id parameter" });

      try {
        if (placeId) {
          const params = new URLSearchParams();
          params.set("place_id", placeId);
          params.set("key", googleKey);
          params.set("fields", "geometry,address_components");

          const url = `https://maps.googleapis.com/maps/api/place/details/json?${params.toString()}`;
          const r = await fetch(url);
          const data = await r.json().catch(() => null);
          if (!r.ok || !data?.result) return sendJson(res, 502, { error: "Places details request failed" });

          const result = data.result;
          const loc = result.geometry?.location;
          const components = Array.isArray(result.address_components)
            ? result.address_components.map((c) => ({ long_name: c.long_name, short_name: c.short_name, types: c.types }))
            : [];

          return sendJson(res, 200, {
            geometry: loc ? { lat: loc.lat, lng: loc.lng } : null,
            components,
            status: data.status,
            source: "google_places",
          });
        }

        const params = new URLSearchParams();
        params.set("input", input);
        params.set("key", googleKey);
        if (country) params.set("components", `country:${country}`);

        const url = `https://maps.googleapis.com/maps/api/place/autocomplete/json?${params.toString()}`;
        const r = await fetch(url);
        const data = await r.json().catch(() => null);
        if (!r.ok || !Array.isArray(data?.predictions)) return sendJson(res, 502, { error: "Places autocomplete request failed" });

        return sendJson(res, 200, {
          predictions: data.predictions.map((p) => ({
            place_id: p.place_id,
            description: p.description,
            main_text: p.structured_formatting?.main_text || p.main_text,
            secondary_text: p.structured_formatting?.secondary_text || p.secondary_text,
          })),
          status: data.status,
          source: "google_places",
        });
      } catch {
        return sendJson(res, 502, { error: "Places API request failed" });
      }
    });

    server.middlewares.use("/__dev/google/translate", async (req, res, next) => {
      if (req.method === "OPTIONS") {
        withCorsHeaders(res);
        res.statusCode = 200;
        return res.end();
      }

      if (req.method !== "POST") return next();

      const rawText = await readNodeRequestBody(req).catch(() => "");
      const body = (rawText && tryJsonParse(rawText)) || {};

      const text = typeof body.text === "string" ? body.text : "";
      const target = typeof body.target === "string" ? body.target : "en";

      // If Translate API isn't enabled for this key, we gracefully return original text.
      try {
        const params = new URLSearchParams();
        params.set("key", googleKey);

        const r = await fetch(`${translateEndpoint}?${params.toString()}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ q: text, target }),
        });

        const data = await r.json().catch(() => null);
        const translated = data?.data?.translations?.[0]?.translatedText;
        if (r.ok && typeof translated === "string") {
          return sendJson(res, 200, { text, target, translatedText: translated, source: "google_translate" });
        }
      } catch {
        // ignore
      }

      return sendJson(res, 200, { text, target, translatedText: text, source: "fallback" });
    });
  },
};

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const API_TARGET =
    (env.VITE_FUNCTIONS_URL && env.VITE_FUNCTIONS_URL.trim()) ||
    (env.VITE_API_BASE && env.VITE_API_BASE.trim()) ||
    (env.VITE_API_URL && env.VITE_API_URL.trim()) ||
    "http://127.0.0.1:7071"; // Azure Functions Core Tools default

  // If you're proxying to a protected Azure Functions backend during local dev,
  // this adds the function key at the dev-server layer (so it is NOT bundled to the client).
  const FUNCTIONS_KEY =
    (process.env.FUNCTION_KEY && String(process.env.FUNCTION_KEY).trim()) ||
    (process.env.XAI_EXTERNAL_KEY && String(process.env.XAI_EXTERNAL_KEY).trim()) ||
    "";

  const proxyHeaders = isNonEmptyString(FUNCTIONS_KEY) ? { "x-functions-key": FUNCTIONS_KEY } : undefined;

  return {
    plugins: [react(), devGoogleMiddleware, copyStaticWebAppConfig, emitBuildIdFile],
    resolve: {
      alias: {
        "@": resolve(__dirname, "src"),
        "@pages": resolve(__dirname, "src/pages"),
        "@components": resolve(__dirname, "src/components"),
        "@contexts": resolve(__dirname, "src/contexts"),
        "@lib": resolve(__dirname, "src/lib"),
      },
      extensions: [".js", ".jsx", ".ts", ".tsx"],
    },
    server: {
      host: "127.0.0.1",
      port: 5173,
      strictPort: true,
      proxy: {
        "/api": {
          target: API_TARGET,
          changeOrigin: true,
          secure: false,
          ws: true,
          timeout: 600000,
          proxyTimeout: 600000,
          ...(proxyHeaders ? { headers: proxyHeaders } : {}),
          rewrite: (p) => p, // keep /api prefix because host.json uses routePrefix "api"
        },
        "/xapi": {
          target: API_TARGET,
          changeOrigin: true,
          secure: false,
          ws: true,
          timeout: 600000,
          proxyTimeout: 600000,
          ...(proxyHeaders ? { headers: proxyHeaders } : {}),
          rewrite: (p) => p.replace(/^\/xapi(\/|$)/, "/api$1"),
        },
      },
    },
    build: {
      chunkSizeWarningLimit: 1000,
      sourcemap: true, // help trace prod errors (disabled by default in Vite)
      rollupOptions: {
        output: {
          manualChunks(id) {
            if (id.includes("node_modules")) {
              // Keep only well-known groups; let Rollup handle the rest to avoid TDZ from over-aggregating
              if (
                id.includes("/react/") ||
                id.includes("/react-dom/") ||
                id.includes("/react-router/") ||
                id.includes("/react-router-dom/")
              ) {
                return "vendor-react";
              }
              if (id.includes("/@tanstack/")) return "vendor-tanstack";
              if (id.includes("/@radix-ui/")) return "vendor-radix";
              if (id.includes("/framer-motion/")) return "vendor-framer";
              if (id.includes("/sonner/")) return "vendor-sonner";
            }
          },
        },
      },
    },
  };
});
