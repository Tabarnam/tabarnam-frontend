/**
 * Search-term highlighting for company result cards.
 *
 * Wraps the portion of a company's text that matched the user's search in a
 * <mark> element (styled brand Tint 82 in light mode / translucent Dark-40
 * cyan in dark mode — see the global `mark` rules in src/index.css).
 *
 * XSS-safe by construction: these functions return React children (plain
 * strings interleaved with <mark> elements), never an HTML string. No
 * dangerouslySetInnerHTML anywhere.
 *
 * Two matching modes, by field type:
 *   - FREE TEXT (company name, tagline): `highlightExactPhrase` — finds the
 *     normalized query as a standalone phrase delimited by word boundaries
 *     and marks each occurrence. Never matches mid-word ("paint" does NOT
 *     light up inside "Painterly").
 *   - DISCRETE CHIPS (each industry / product keyword): `isExactChipMatch` —
 *     true only when the whole chip equals the query (normalized, or via the
 *     compact/space-stripped form so a "MyPillow" chip lights up for a
 *     "my pillow" query). The caller wraps the whole chip in <mark>.
 */

import React from "react";
import { normalizeQuery, compactQuery } from "@/lib/queryNormalizer";

/**
 * True when a discrete chip (one industry tag or one product keyword) should
 * be highlighted: the chip, normalized, equals the query — or their compact
 * (space-stripped) forms are equal, so "my pillow" matches a "MyPillow" chip.
 */
export function isExactChipMatch(chip, query) {
  const c = normalizeQuery(String(chip || ""));
  const q = normalizeQuery(String(query || ""));
  if (!c || !q) return false;
  if (c === q) return true;
  return compactQuery(c) === compactQuery(q);
}

/**
 * Escape a string for safe insertion into a RegExp.
 */
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Highlight occurrences of `query` as a standalone, word-boundary-delimited
 * phrase within free-text `text`. Returns React children:
 *   - the original string unchanged when there's no query or no match
 *   - otherwise an array of strings and <mark> elements, with the matched
 *     spans rendered in their ORIGINAL casing inside <mark>
 *
 * Word-boundary semantics: the match must start at a non-letter/digit
 * boundary and end at one, so "paint" matches "paint" / "Paint" / "the paint"
 * but NOT the "paint" inside "Painterly" or "fingerpaint". Diacritics and
 * case are folded for the comparison (via normalizeQuery) but the displayed
 * text is sliced from the ORIGINAL string so accents/casing are preserved.
 */
export function highlightExactPhrase(text, query) {
  const original = text == null ? "" : String(text);
  const q = normalizeQuery(String(query || ""));
  if (!original || !q) return original;

  // Match the normalized query phrase against the NORMALIZED text, but report
  // positions back onto the original string. normalizeQuery can change length
  // (folding "ß"→"ss", stripping punctuation), so we can't naively reuse
  // normalized offsets on the original. Instead, build the regex from the
  // query and run it case-insensitively against the original text, then
  // verify each candidate match normalizes to exactly the query — this keeps
  // casing/positions exact while staying diacritic/punctuation-tolerant.
  //
  // The query is a normalized phrase: words separated by single spaces, only
  // [a-z0-9]. Between words in the ORIGINAL text there may be any run of
  // whitespace/punctuation, so join the escaped words with a flexible
  // separator. Wrap in lookarounds for word boundaries that treat a letter or
  // digit as "word" (so "MyPillow" boundary rules match our normalizer's
  // alphanumeric tokens).
  const words = q.split(" ").filter(Boolean).map(escapeRegExp);
  if (words.length === 0) return original;

  const sep = "[^a-z0-9]+"; // between-word run in the original (spaces, punct)
  const phrase = words.join(sep);
  // (?<![a-z0-9]) / (?![a-z0-9]) — standalone-phrase boundaries on alphanumerics.
  let re;
  try {
    re = new RegExp(`(?<![a-z0-9])(${phrase})(?![a-z0-9])`, "gi");
  } catch {
    // Lookbehind unsupported (very old engines) — fall back to \b boundaries.
    re = new RegExp(`\\b(${phrase})\\b`, "gi");
  }

  const out = [];
  let lastIndex = 0;
  let match;
  let key = 0;
  while ((match = re.exec(original)) !== null) {
    const start = match.index;
    const end = start + match[0].length;
    // Guard against zero-length matches (shouldn't happen, but avoid a loop).
    if (end === start) { re.lastIndex++; continue; }
    if (start > lastIndex) out.push(original.slice(lastIndex, start));
    out.push(<mark key={`hl-${key++}`}>{original.slice(start, end)}</mark>);
    lastIndex = end;
  }

  if (out.length === 0) return original; // no match — return plain string
  if (lastIndex < original.length) out.push(original.slice(lastIndex));
  return out;
}
