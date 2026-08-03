# Search relevance-regression harness

A before/after guard for **ranking-affecting** search changes (fuzzy/broaden
gating, scoring tweaks, retrieval changes). The unit-level golden snapshot
(`api/search-companies/perf-snapshot.test.js`) guards the scoring *pipeline
logic* on a synthetic corpus; this harness guards **real rankings on real prod
data**, which is what you need before touching recall.

It captures the ordered top-20 results for a curated query set
(`queries.mjs`) and diffs a candidate against a committed baseline. Captures use
`nocache=1` + a fixed San Dimas center, so it's deterministic — prod-vs-prod is
0 changes, meaning any diff is a genuine ranking change, not noise.

## Commands

```bash
# 1. Capture the baseline from prod (commit the resulting baseline.json)
npm run relevance:baseline

# 2. Apply the ranking change on a candidate (preview slot, canary, or a flagged
#    prod build), then diff that candidate against the baseline:
npm run relevance:check -- --base https://<candidate-host>

# ad-hoc capture to a file (no diff)
node scripts/relevance-regression/harness.mjs capture --out /tmp/cand.json
```

Default `--base` is `https://www.tabarnam.com` (override with `$HARNESS_BASE`
or `--base`). Default baseline is `./baseline.json`.

## Reading the report

Per flagged query you get: whether `#1` changed, whether the ordered top-5 is
identical, top-10 overlap (Jaccard), and — the key signal — **drop-outs**
(domains that were in the baseline top-20 and vanished from the candidate).

Status per query:
- `✗ FAIL` — a hard regression: `#1` changed on any query, or an **A/B anchor**
  query's top-5 moved. `check` exits non-zero.
- `· REVIEW` — a **class-C** query shed something (top-5 changed or a drop-out).
  This is the **expected** trade-off of the fuzzy-gate change — a human decides
  if the dropped company mattered. Does not fail the run.
- `⚠ WARN` — an A/B query changed below the top-5.

## Query classes (see `queries.mjs`)

- **A** — exact brand / strong name match. Fuzzy is already skipped, so these
  must NOT move. Anchors.
- **B** — brand + category with a thin pool (`alo yoga`), and typo cases
  (`cliff bar`) where fuzzy is the intended path. Must NOT move.
- **C** — common category words with a healthy keyword pool but no name-prefix
  match (`coffee`, `honey`, `tea`, …). **Fuzzy fires here today**, so these are
  what the fuzzy-gate change would alter. Weighted heaviest in the set.

## Workflow for the fuzzy-gate change

1. `npm run relevance:baseline` on current prod → commit `baseline.json`.
2. Add the `items.length < FUZZY_FALLBACK_THRESHOLD` guard to the fuzzy pass in
   `api/search-companies/index.js` (mirror the broaden pass's existing gate).
3. Deploy to a candidate host and `npm run relevance:check -- --base <host>`.
4. Read the `· REVIEW` rows: if class-C drop-outs are only fuzzy-only
   name-prefix stragglers (a brand named after the category but not tagged for
   it), and no A/B anchor or `#1` moved → ship. Otherwise raise the threshold.
5. Re-capture the baseline after shipping so future diffs compare against the
   new intended state.
