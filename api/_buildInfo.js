const fs = require("fs");
const path = require("path");

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

function tryReadGitShaFromRepo() {
  const gitDir = path.resolve(__dirname, "..", ".git");
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

  const lines = packed
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#") && !l.startsWith("^"));

  for (const line of lines) {
    const parts = line.split(/\s+/);
    if (parts.length < 2) continue;
    const [sha, ref] = parts;
    if (ref === refMatch[1].trim() && looksLikeSha(sha)) return sha;
  }

  return "";
}

function getBuildId() {
  const env = process.env || {};
  // In Azure App Service / Azure Functions, these env vars are commonly populated with the deployed commit.
  // Order matters: first non-empty wins.
  const candidates = [
    { key: "WEBSITE_COMMIT_HASH", value: env.WEBSITE_COMMIT_HASH },
    { key: "SCM_COMMIT_ID", value: env.SCM_COMMIT_ID },
    { key: "BUILD_SOURCEVERSION", value: env.BUILD_SOURCEVERSION },
    { key: "GITHUB_SHA", value: env.GITHUB_SHA },
    { key: "BUILD_ID", value: env.BUILD_ID },

    // Additional providers / legacy names
    { key: "COMMIT_SHA", value: env.COMMIT_SHA },
    { key: "SOURCE_VERSION", value: env.SOURCE_VERSION },
    { key: "NETLIFY_COMMIT_SHA", value: env.NETLIFY_COMMIT_SHA },
    { key: "VERCEL_GIT_COMMIT_SHA", value: env.VERCEL_GIT_COMMIT_SHA },
  ];

  for (const c of candidates) {
    if (!isNonEmptyString(c.value)) continue;
    const normalized = normalizeSha(c.value);
    return { build_id: normalized, build_id_source: c.key };
  }

  const gitSha = tryReadGitShaFromRepo();
  if (gitSha) return { build_id: gitSha, build_id_source: "git" };

  return { build_id: "unknown", build_id_source: "none" };
}

function getRuntimeInfo() {
  const env = process.env || {};
  return {
    website_site_name: String(env.WEBSITE_SITE_NAME || ""),
    website_hostname: String(env.WEBSITE_HOSTNAME || ""),
    azure_functions_environment: String(env.AZURE_FUNCTIONS_ENVIRONMENT || ""),
    functions_worker_runtime: String(env.FUNCTIONS_WORKER_RUNTIME || ""),
    swa_deployment_id: String(env.SWA_DEPLOYMENT_ID || ""),
  };
}

function getBuildInfo() {
  return {
    ...getBuildId(),
    runtime: getRuntimeInfo(),
  };
}

module.exports = { getBuildInfo };
