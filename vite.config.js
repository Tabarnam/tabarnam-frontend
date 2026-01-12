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
    (process.env.XAI_EXTERNAL_KEY && String(process.env.XAI_EXTERNAL_KEY).trim()) ||
    (process.env.FUNCTION_KEY && String(process.env.FUNCTION_KEY).trim()) ||
    "";

  const proxyHeaders = isNonEmptyString(FUNCTIONS_KEY) ? { "x-functions-key": FUNCTIONS_KEY } : undefined;

  return {
    plugins: [react(), copyStaticWebAppConfig, emitBuildIdFile],
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
