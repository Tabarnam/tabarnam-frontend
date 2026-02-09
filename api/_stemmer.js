/**
 * Simple English plural stemmer for search.
 * Conservative: only strips clear plural suffixes to avoid corrupting brand names.
 * Idempotent: simpleStem(simpleStem(word)) === simpleStem(word).
 */

/**
 * Strip common English plural suffixes from a word.
 * Only applies to words with length >= 4 to protect short brand names.
 *
 * Rules (applied in order, first match wins):
 *   "ies"  → "y"     (companies → company, batteries → battery)
 *   "sses" → "ss"    (grasses → grass)
 *   "shes" → "sh"    (washes → wash)
 *   "ches" → "ch"    (watches → watch)
 *   "xes"  → "x"     (boxes → box)
 *   "zes"  → "z"     (fizzes handled by sses; quizzes → quiz via zes)
 *   "ses"  → "se"    (cases → case, bases → base)
 *   trailing "s" (not after s, u vowel-s patterns "us", or "is") → remove
 */
function simpleStem(word) {
  if (!word || typeof word !== "string") return word || "";
  const w = word.toLowerCase();
  if (w.length < 4) return w;

  // "ies" → "y"
  if (w.endsWith("ies")) return w.slice(0, -3) + "y";

  // "sses" → "ss"
  if (w.endsWith("sses")) return w.slice(0, -2);

  // "shes" → "sh"
  if (w.endsWith("shes")) return w.slice(0, -2);

  // "ches" → "ch"
  if (w.endsWith("ches")) return w.slice(0, -2);

  // "xes" → "x"
  if (w.endsWith("xes")) return w.slice(0, -2);

  // "zes" → "z"
  if (w.endsWith("zes")) return w.slice(0, -2);

  // "ses" → "se" (case→cases, base→bases)
  if (w.endsWith("ses")) return w.slice(0, -1);

  // Generic trailing "s" — skip if word ends in "ss", "us", or "is"
  if (w.endsWith("s") && !w.endsWith("ss") && !w.endsWith("us") && !w.endsWith("is")) {
    return w.slice(0, -1);
  }

  return w;
}

/**
 * Stem each word in a normalized (space-separated) string.
 */
function stemWords(normalized) {
  if (!normalized || typeof normalized !== "string") return "";
  return normalized
    .split(/\s+/)
    .map(simpleStem)
    .filter(Boolean)
    .join(" ");
}

module.exports = { simpleStem, stemWords };
