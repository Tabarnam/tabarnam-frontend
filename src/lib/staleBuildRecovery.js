// Recover a tab that was open across a deploy.
//
// Vite emits hashed chunks and lazy-loads pages via dynamic import(). After a
// deploy the old hashes are GONE from the server, so a tab that was already
// open fails the moment it needs a chunk it hasn't loaded yet — clicking
// through to a lazy page, or opening the spreadsheet writer for an export.
// The failure surfaces as "Failed to fetch dynamically imported module", and
// the tab stays broken until someone thinks to hard-refresh.
//
// The service worker made this worse by serving /assets/* cache-first: the
// stale main bundle kept loading happily while the chunks it asked for 404ed.
//
// One reload picks up the new build. The sessionStorage guard means a genuine
// network failure cannot turn into a reload loop — it retries once per tab,
// then lets the error surface normally.

const RELOAD_FLAG = "stale_build_reloaded";

const CHUNK_ERROR = /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module/i;

function alreadyTried() {
  try {
    return sessionStorage.getItem(RELOAD_FLAG) === "1";
  } catch {
    return false;
  }
}

function markTried() {
  try {
    sessionStorage.setItem(RELOAD_FLAG, "1");
  } catch {
    /* non-fatal — worst case we reload twice */
  }
}

function looksLikeStaleBuild(reason) {
  const message =
    typeof reason === "string" ? reason : reason?.message || reason?.reason?.message || "";
  return CHUNK_ERROR.test(String(message));
}

function recover(reason) {
  if (!looksLikeStaleBuild(reason)) return;
  if (alreadyTried()) return; // already reloaded once; let the error show

  markTried();
  // Bypass any cached copy of the shell on the way back in.
  window.location.reload();
}

export function installStaleBuildRecovery() {
  if (typeof window === "undefined") return;

  window.addEventListener("unhandledrejection", (event) => recover(event?.reason));
  window.addEventListener("error", (event) => recover(event?.error || event?.message));

  // A successful load means this build is current — clear the guard so a
  // future deploy gets its own single retry.
  try {
    if (alreadyTried()) sessionStorage.removeItem(RELOAD_FLAG);
  } catch {
    /* non-fatal */
  }
}

export const __test = { looksLikeStaleBuild, CHUNK_ERROR, RELOAD_FLAG };
