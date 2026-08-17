// Client-side fuzzy matcher for small, already-loaded lists (e.g. the
// Recent Activity feed, ≤100 rows). Two goals:
//
//   1. Reuse the SAME normalization the admin/public search already applies
//      (src/lib/queryNormalizer) so behavior is consistent across the app:
//      case-insensitive, diacritic-folded, punctuation/spacing-insensitive,
//      plural-insensitive.
//   2. Add the one thing no search here has — true edit-distance tolerance —
//      so a typo like "aspctek" still finds "Aspectek". This is affordable
//      only because we're filtering a tiny in-memory set, not the DB.
//
// Strategy mirrors the app's "fuzzy fallback" pattern: try an exact
// (normalized) substring pass first — predictable, no false positives — and
// only fall back to per-token edit-distance when the exact pass finds nothing.

import { normalizeQuery, compactQuery, simpleStem } from "./queryNormalizer";

/**
 * Bounded Damerau–Levenshtein distance. Returns the true edit distance if it
 * is ≤ max, otherwise returns max + 1 (early-exit — we never need the exact
 * value once it exceeds the threshold). Counts insertions, deletions,
 * substitutions, and adjacent transpositions ("aspetck" ↔ "aspectk").
 */
export function boundedEditDistance(a, b, max) {
  a = a || "";
  b = b || "";
  if (a === b) return 0;
  const la = a.length;
  const lb = b.length;
  if (Math.abs(la - lb) > max) return max + 1;
  if (la === 0) return lb <= max ? lb : max + 1;
  if (lb === 0) return la <= max ? la : max + 1;

  let prevPrev = new Array(lb + 1);
  let prev = new Array(lb + 1);
  let curr = new Array(lb + 1);
  for (let j = 0; j <= lb; j++) prev[j] = j;

  for (let i = 1; i <= la; i++) {
    curr[0] = i;
    let rowMin = curr[0];
    const ai = a.charCodeAt(i - 1);
    for (let j = 1; j <= lb; j++) {
      const cost = ai === b.charCodeAt(j - 1) ? 0 : 1;
      let v = Math.min(
        prev[j] + 1, // deletion
        curr[j - 1] + 1, // insertion
        prev[j - 1] + cost // substitution
      );
      // transposition of two adjacent characters
      if (
        i > 1 &&
        j > 1 &&
        ai === b.charCodeAt(j - 2) &&
        a.charCodeAt(i - 2) === b.charCodeAt(j - 1)
      ) {
        v = Math.min(v, prevPrev[j - 2] + 1);
      }
      curr[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1; // whole row already past threshold
    const tmp = prevPrev;
    prevPrev = prev;
    prev = curr;
    curr = tmp;
  }
  return prev[lb] <= max ? prev[lb] : max + 1;
}

// Typo tolerance scales with word length: short words get 1 edit, longer
// words get 2. Very short tokens (≤3) require an exact/substring hit — one
// edit on a 3-letter word matches almost anything.
function editBudget(len) {
  if (len <= 3) return 0;
  if (len <= 6) return 1;
  return 2;
}

/** Split normalized text into stemmed word tokens. */
function tokenize(normalized) {
  if (!normalized) return [];
  return normalized.split(" ").filter(Boolean).map(simpleStem);
}

// A "clean" token hit — stem-equality (plural-insensitive) or the haystack
// token containing the query token (prefix/partial typing). No edit distance,
// so these count as ordinary matches, not typo corrections.
function tokenClean(qTok, hTok) {
  return hTok === qTok || hTok.includes(qTok);
}

// A "fuzzy" token hit — a clean hit, OR within the length-scaled edit budget.
function tokenFuzzy(qTok, hTok) {
  if (tokenClean(qTok, hTok)) return true;
  const budget = editBudget(qTok.length);
  return budget > 0 && boundedEditDistance(qTok, hTok, budget) <= budget;
}

/**
 * Build a reusable matcher for one query. Returns null for an empty query.
 * `.exact(text)` → normalized/stemmed match: substring, spacing-insensitive,
 *                  or every query token stem-matches some text token. Silent
 *                  normalization only — no typo tolerance, no false positives.
 * `.fuzzy(text)` → same, plus per-token edit-distance (typo correction).
 */
export function makeActivityMatcher(rawQuery) {
  const qNorm = normalizeQuery(rawQuery || "");
  if (!qNorm) return null;
  const qCompact = compactQuery(qNorm);
  const qTokens = tokenize(qNorm);

  return {
    exact(text) {
      const tNorm = normalizeQuery(text || "");
      if (tNorm.includes(qNorm)) return true; // whole-phrase substring
      // Spacing-insensitive: "lipgloss" matches "lip gloss" and vice versa.
      if (compactQuery(tNorm).includes(qCompact)) return true;
      const hayTokens = tokenize(tNorm);
      if (hayTokens.length === 0) return false;
      return qTokens.every((qt) => hayTokens.some((ht) => tokenClean(qt, ht)));
    },
    fuzzy(text) {
      const hayTokens = tokenize(normalizeQuery(text || ""));
      if (hayTokens.length === 0) return false;
      return qTokens.every((qt) => hayTokens.some((ht) => tokenFuzzy(qt, ht)));
    },
  };
}

/**
 * Filter `rows` by `rawQuery`, extracting each row's searchable text with
 * `getText`. Exact (normalized) matches win; only if there are none do we
 * fall back to edit-distance fuzzy matching.
 *
 * @returns {{ rows: any[], fuzzy: boolean }} `fuzzy` is true when the result
 *          set came from the typo-tolerant fallback (so the UI can say so).
 */
export function filterActivity(rawQuery, rows, getText) {
  const matcher = makeActivityMatcher(rawQuery);
  if (!matcher) return { rows, fuzzy: false };

  const exact = rows.filter((r) => matcher.exact(getText(r)));
  if (exact.length > 0) return { rows: exact, fuzzy: false };

  const fuzzy = rows.filter((r) => matcher.fuzzy(getText(r)));
  return { rows: fuzzy, fuzzy: fuzzy.length > 0 };
}
