// Wraps global fetch with a hard timeout so a hung outbound call can't pin the
// Functions worker (the root cause of the recurring 500-storms). Aborts after
// timeoutMs (default 8s) via AbortController.
async function fetchWithTimeout(url, options = {}, timeoutMs = 8000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

module.exports = { fetchWithTimeout };
