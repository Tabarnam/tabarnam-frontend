"use strict";

function asString(v) {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

function normalizeExcludedHost(input) {
  const raw = asString(input).trim().toLowerCase();
  if (!raw) return null;

  // Convert simple wildcard patterns (upstream expects concrete websites, not patterns).
  if (raw.endsWith(".*")) {
    const base = raw.slice(0, -2);
    if (base === "amazon") return "amazon.com";
    if (base === "google") return "google.com";
    if (base === "yelp") return "yelp.com";
  }

  // If it already looks like a host, keep it; if it looks like a URL or host/path, parse hostname.
  const toHostname = (value) => {
    const v = asString(value).trim();
    if (!v) return "";

    // Has a scheme.
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(v)) {
      try {
        return new URL(v).hostname || "";
      } catch {
        return "";
      }
    }

    // No scheme but contains path/query/hash.
    if (/[/?#]/.test(v)) {
      try {
        return new URL(`http://${v}`).hostname || "";
      } catch {
        return "";
      }
    }

    // Treat as a host.
    return v;
  };

  let host = toHostname(raw);
  host = asString(host).trim().toLowerCase();
  if (!host) return null;

  // Host-only rule: strip common prefixes.
  host = host.replace(/^www\./, "");

  // Defensive cleanup.
  host = host.replace(/\.+$/, "");

  // Very small sanity filter.
  if (!host || !/[a-z0-9]/.test(host)) return null;

  return host;
}

function uniqPreserveOrder(items) {
  const out = [];
  const seen = new Set();

  for (const item of Array.isArray(items) ? items : []) {
    const v = asString(item).trim();
    if (!v) continue;
    if (seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }

  return out;
}

function buildExcludedHostsCandidates({ companyWebsiteHost, additionalExcludedHosts } = {}) {
  const companyHost = normalizeExcludedHost(companyWebsiteHost);

  const defaults = [
    // Keep these as separate candidates so anything beyond 5 can spill into prompt text.
    "amazon.com",
    "amzn.to",
    "google.com",
    "g.co",
    "goo.gl",
    "yelp.com",

    // Deterministic "directory/aggregator" pick (kept stable across imports/refresh).
    "trustpilot.com",
  ];

  const provided = Array.isArray(additionalExcludedHosts) ? additionalExcludedHosts : [];

  const normalized = [];
  for (const x of defaults.concat(provided)) {
    const h = normalizeExcludedHost(x);
    if (h) normalized.push(h);
  }

  if (companyHost) normalized.unshift(companyHost);

  return uniqPreserveOrder(normalized);
}

function buildCappedExcludedHosts({ companyWebsiteHost, additionalExcludedHosts, maxExcluded = 5 } = {}) {
  const max = Math.max(0, Math.trunc(Number(maxExcluded) || 0));

  const candidates = buildExcludedHostsCandidates({
    companyWebsiteHost,
    additionalExcludedHosts,
  });

  const companyHost = normalizeExcludedHost(companyWebsiteHost);

  const priority = uniqPreserveOrder([
    ...(companyHost ? [companyHost] : []),
    "amazon.com",
    "google.com",
    "yelp.com",
    "trustpilot.com",
  ]);

  const prioritySet = new Set(priority);

  const prioritized = [];
  for (const h of priority) {
    if (candidates.includes(h)) prioritized.push(h);
  }

  const remaining = candidates
    .filter((h) => !prioritySet.has(h))
    .slice()
    .sort((a, b) => a.localeCompare(b));

  const ordered = prioritized.concat(remaining);

  const used = max ? ordered.slice(0, max) : [];
  const spilled = max ? ordered.slice(max) : ordered.slice();

  const excluded_websites_original_count = ordered.length;
  const excluded_websites_used_count = used.length;
  const excluded_websites_truncated = excluded_websites_original_count > excluded_websites_used_count;

  return {
    candidates: ordered,
    used,
    spilled,
    telemetry: {
      excluded_websites_original_count,
      excluded_websites_used_count,
      excluded_websites_truncated,
    },
  };
}

function buildPromptExclusionText(excessExcludedHosts, { maxHostsInPrompt = 15 } = {}) {
  const max = Math.max(0, Math.trunc(Number(maxHostsInPrompt) || 0));
  const hosts = uniqPreserveOrder(
    (Array.isArray(excessExcludedHosts) ? excessExcludedHosts : [])
      .map((h) => normalizeExcludedHost(h))
      .filter(Boolean)
  );

  if (!hosts.length || !max) return "";

  const list = hosts.slice(0, max);

  // Keep prompt size stable.
  const joined = list.map((h) => h.slice(0, 80)).join(", ");

  return `\n\nAlso avoid these websites (even if they appear in search results): ${joined}.`;
}

function buildSearchParameters({ companyWebsiteHost, additionalExcludedHosts } = {}) {
  const { used, spilled, telemetry } = buildCappedExcludedHosts({
    companyWebsiteHost,
    additionalExcludedHosts,
    maxExcluded: 5,
  });

  return {
    search_parameters: {
      mode: "on",
      sources: [
        { type: "web", excluded_websites: used },
        { type: "news", excluded_websites: used },
        { type: "x" },
      ],
    },
    prompt_exclusion_text: buildPromptExclusionText(spilled, { maxHostsInPrompt: 15 }),
    excluded_hosts: {
      used,
      spilled,
    },
    telemetry: {
      ...telemetry,
      excluded_hosts_spilled_to_prompt_count: spilled.length,
      excluded_websites_hosts_preview: used.slice(0, 5),
    },
  };
}

module.exports = {
  normalizeExcludedHost,
  buildExcludedHostsCandidates,
  buildCappedExcludedHosts,
  buildPromptExclusionText,
  buildSearchParameters,
};
