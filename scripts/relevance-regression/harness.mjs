#!/usr/bin/env node
// Search relevance-regression harness.
//
// Captures the ordered top-N results for a curated query set (queries.mjs)
// against a running search API, and diffs a candidate capture against a
// committed baseline. Use it to de-risk ANY ranking-affecting change
// (fuzzy/broaden gating, scoring tweaks, retrieval changes): capture a baseline
// from prod, apply the change on a preview/canary/flag, then `check` against it.
//
// Usage:
//   node harness.mjs baseline [--base URL] [--out FILE]   # capture → write baseline
//   node harness.mjs capture  [--base URL] --out FILE      # capture → write FILE
//   node harness.mjs check    [--base URL] [--baseline FILE]  # capture candidate, diff vs baseline
//
// Defaults: --base $HARNESS_BASE || https://www.tabarnam.com ; baseline ./baseline.json
// Results are captured with nocache=1 + a fixed San Dimas center for determinism.
//
// Exit codes (check): 0 = within tolerance, 1 = HARD regression (see THRESHOLDS).

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { QUERIES } from "./queries.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_BASE = process.env.HARNESS_BASE || "https://www.tabarnam.com";
const DEFAULT_BASELINE = join(HERE, "baseline.json");

// How many ranked rows to record/compare per query.
const TOP_N = 20;
// Fixed center so the manu sort's within-tier distance ordering is deterministic.
const LAT = 34.0983;
const LNG = -117.8076;
const CONCURRENCY = 4;

// Tolerances that decide the exit code. Class C is EXPECTED to shed fuzzy-only
// stragglers, so its drop-outs are reported but don't fail the run; A/B anchors
// and any #1 change are hard failures.
const THRESHOLDS = {
  failOnAnyRankOneChange: true, // any query whose #1 domain changed → fail
  failOnAnchorTop5Change: true, // any A/B query whose ordered top-5 changed → fail
};

// ── query normalization (mirror the frontend closely enough for realism;
// consistency between baseline & candidate is what makes the diff valid) ──
function normalize(raw) {
  const norm = raw
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return { raw, norm, compact: norm.replace(/\s+/g, "") };
}

function tierOf(score) {
  if (score >= 90) return 0;
  if (score >= 60) return 1;
  if (score >= 30) return 2;
  return 3;
}

async function fetchQuery(base, item, attempt = 1) {
  const { raw, norm, compact } = normalize(item.q);
  const p = new URLSearchParams({
    raw, norm, compact,
    sort: "manu",
    take: "25",
    lat: String(LAT),
    lng: String(LNG),
    nocache: "1",
    _t: `${Date.now()}_${Math.round(performance.now())}`,
  });
  const url = `${base.replace(/\/$/, "")}/api/search-companies?${p.toString()}`;
  try {
    const res = await fetch(url, { headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const d = await res.json();
    const items = Array.isArray(d.items) ? d.items : [];
    const top = items.slice(0, TOP_N).map((it, i) => ({
      pos: i,
      domain: it.normalized_domain || it.id || "",
      name: it.company_name || it.display_name || "",
      score: Number(it._relevanceScore) || 0,
      tier: tierOf(Number(it._relevanceScore) || 0),
    }));
    const t = (d.meta && d.meta._timing) || {};
    return {
      q: item.q,
      class: item.class,
      top,
      totalCount: Number(d.totalCount ?? d.meta?.totalCount ?? items.length) || 0,
      cosmos_ms: t.cosmos_ms ?? null,
      total_ms: t.total_ms ?? null,
    };
  } catch (e) {
    if (attempt < 3) {
      await new Promise((r) => setTimeout(r, 400 * attempt));
      return fetchQuery(base, item, attempt + 1);
    }
    return { q: item.q, class: item.class, top: [], totalCount: 0, cosmos_ms: null, total_ms: null, error: String(e.message || e) };
  }
}

async function capture(base) {
  process.stderr.write(`capturing ${QUERIES.length} queries from ${base} …\n`);
  const out = {};
  for (let i = 0; i < QUERIES.length; i += CONCURRENCY) {
    const batch = QUERIES.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map((item) => fetchQuery(base, item)));
    for (const r of results) {
      out[r.q] = r;
      process.stderr.write(`  ${r.error ? "✗" : "✓"} ${r.q} (${r.top.length} rows${r.cosmos_ms != null ? `, cosmos=${r.cosmos_ms}ms` : ""})\n`);
    }
  }
  return { capturedAt: new Date().toISOString().slice(0, 19) + "Z", base, topN: TOP_N, queries: out };
}

// ── diff ──
function jaccard(a, b) {
  const A = new Set(a), B = new Set(b);
  if (A.size === 0 && B.size === 0) return 1;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

function diff(baseline, candidate) {
  const rows = [];
  let hardFail = false;
  for (const item of QUERIES) {
    const b = baseline.queries[item.q];
    const c = candidate.queries[item.q];
    if (!b || !c) {
      rows.push({ q: item.q, class: item.class, status: "MISSING", note: !b ? "not in baseline" : "not in candidate" });
      continue;
    }
    const bDomains = b.top.map((r) => r.domain);
    const cDomains = c.top.map((r) => r.domain);
    const bSet = new Set(bDomains), cSet = new Set(cDomains);
    const dropouts = bDomains.filter((d) => !cSet.has(d)); // in baseline top-N, gone from candidate
    const entrants = cDomains.filter((d) => !bSet.has(d));
    const top5Same = bDomains.slice(0, 5).join("|") === cDomains.slice(0, 5).join("|");
    const rankOneChanged = (bDomains[0] || "") !== (cDomains[0] || "");
    const jac10 = jaccard(bDomains.slice(0, 10), cDomains.slice(0, 10)).toFixed(2);

    let status = "ok";
    if (rankOneChanged && THRESHOLDS.failOnAnyRankOneChange) { status = "FAIL"; hardFail = true; }
    else if ((item.class === "A" || item.class === "B") && !top5Same && THRESHOLDS.failOnAnchorTop5Change) { status = "FAIL"; hardFail = true; }
    else if (dropouts.length || !top5Same) { status = item.class === "C" ? "review" : "warn"; }

    rows.push({
      q: item.q, class: item.class, status,
      top5Same, rankOneChanged, jac10,
      dropouts, entrants,
      cosmosΔ: b.cosmos_ms != null && c.cosmos_ms != null ? c.cosmos_ms - b.cosmos_ms : null,
      bTop1: b.top[0]?.name, cTop1: c.top[0]?.name,
    });
  }
  return { rows, hardFail };
}

function report(baseline, candidate, d) {
  const line = "─".repeat(72);
  console.log(line);
  console.log(`Relevance regression: baseline ${baseline.capturedAt} (${baseline.base})`);
  console.log(`                      candidate ${candidate.capturedAt} (${candidate.base})`);
  console.log(line);
  const flagged = d.rows.filter((r) => r.status !== "ok");
  if (flagged.length === 0) {
    console.log("✓ No ranking changes — every query's top-N is identical.");
  }
  for (const r of flagged) {
    const tag = { FAIL: "✗ FAIL", warn: "⚠ WARN", review: "· REVIEW", MISSING: "? MISSING" }[r.status] || r.status;
    console.log(`\n${tag}  [${r.class}] "${r.q}"`);
    if (r.note) { console.log(`    ${r.note}`); continue; }
    console.log(`    #1: "${r.bTop1}" → "${r.cTop1}"${r.rankOneChanged ? "   ← CHANGED" : ""}`);
    console.log(`    top-5 identical: ${r.top5Same}   top-10 overlap: ${r.jac10}`);
    if (r.dropouts.length) console.log(`    dropped from top-${TOP_N}: ${r.dropouts.join(", ")}`);
    if (r.entrants.length) console.log(`    new in top-${TOP_N}: ${r.entrants.join(", ")}`);
  }
  // aggregate
  const n = d.rows.length;
  const identical = d.rows.filter((r) => r.status === "ok").length;
  const rankOne = d.rows.filter((r) => r.rankOneChanged).length;
  const withDrop = d.rows.filter((r) => r.dropouts && r.dropouts.length).length;
  const cosΔ = d.rows.map((r) => r.cosmosΔ).filter((x) => typeof x === "number");
  const avgΔ = cosΔ.length ? Math.round(cosΔ.reduce((a, b) => a + b, 0) / cosΔ.length) : null;
  console.log(`\n${line}`);
  console.log(`Summary: ${identical}/${n} identical · ${rankOne} #1 changes · ${withDrop} with drop-outs` + (avgΔ != null ? ` · avg cosmosΔ ${avgΔ >= 0 ? "+" : ""}${avgΔ}ms` : ""));
  console.log(d.hardFail ? "RESULT: ✗ HARD REGRESSION — review before shipping." : "RESULT: ✓ within tolerance (review any · REVIEW rows — class-C drop-outs are the expected fuzzy-gate trade-off).");
  console.log(line);
}

// ── CLI ──
function arg(flag, def) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

const cmd = process.argv[2];
const base = arg("--base", DEFAULT_BASE);

if (cmd === "baseline") {
  const out = arg("--out", DEFAULT_BASELINE);
  const cap = await capture(base);
  writeFileSync(out, JSON.stringify(cap, null, 2));
  console.error(`baseline written → ${out}`);
} else if (cmd === "capture") {
  const out = arg("--out", null);
  const cap = await capture(base);
  const json = JSON.stringify(cap, null, 2);
  if (out) { writeFileSync(out, json); console.error(`capture written → ${out}`); }
  else process.stdout.write(json + "\n");
} else if (cmd === "check") {
  const baselineFile = arg("--baseline", DEFAULT_BASELINE);
  const baseline = JSON.parse(readFileSync(baselineFile, "utf8"));
  const candidate = await capture(base);
  const d = diff(baseline, candidate);
  report(baseline, candidate, d);
  process.exit(d.hardFail ? 1 : 0);
} else {
  console.error("usage: harness.mjs <baseline|capture|check> [--base URL] [--out FILE] [--baseline FILE]");
  process.exit(2);
}
