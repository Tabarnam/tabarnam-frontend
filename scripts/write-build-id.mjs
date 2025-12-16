import fs from "node:fs";
import path from "node:path";

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

function resolveBuildId() {
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

  const repoRoot = path.resolve(process.cwd());
  const gitSha = tryReadGitShaFromRepoRoot(repoRoot);
  if (isNonEmptyString(gitSha)) return gitSha;

  return "";
}

const buildId = resolveBuildId();
if (!buildId) {
  console.log("[write-build-id] No build id detected; skipping api/__build_id.txt generation.");
  process.exit(0);
}

const targets = [
  path.resolve(process.cwd(), "api", "__build_id.txt"),
  path.resolve(process.cwd(), "public", "__build_id.txt"),
];

for (const outPath of targets) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${buildId}\n`, "utf8");
  console.log(`[write-build-id] Wrote ${outPath} (${buildId.slice(0, 8)}…)`);
}
