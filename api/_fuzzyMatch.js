/**
 * Fuzzy matching utilities for typo-tolerant search.
 * Used as a fallback when exact search returns few/no results.
 */

/**
 * Compute Damerau-Levenshtein (optimal string alignment) distance.
 * Counts insertions, deletions, substitutions, AND adjacent transpositions
 * each as a single edit. Standard Levenshtein counts transpositions as 2
 * edits (delete + insert), which penalises common typing mistakes like
 * "fair" → "fari" too harshly.
 */
function damerauLevenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;

  // Full matrix required for transposition look-back
  const lenA = a.length;
  const lenB = b.length;
  const d = Array.from({ length: lenA + 1 }, () => new Array(lenB + 1));

  for (let i = 0; i <= lenA; i++) d[i][0] = i;
  for (let j = 0; j <= lenB; j++) d[0][j] = j;

  for (let i = 1; i <= lenA; i++) {
    for (let j = 1; j <= lenB; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(
        d[i - 1][j] + 1,       // deletion
        d[i][j - 1] + 1,       // insertion
        d[i - 1][j - 1] + cost, // substitution
      );
      // Transposition: swap of two adjacent characters
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + cost);
      }
    }
  }
  return d[lenA][lenB];
}

// Keep the original levenshtein for backwards compat (tests, etc.)
function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;

  let prev = new Array(a.length + 1);
  let curr = new Array(a.length + 1);

  for (let j = 0; j <= a.length; j++) prev[j] = j;

  for (let i = 1; i <= b.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= a.length; j++) {
      if (b[i - 1] === a[j - 1]) {
        curr[j] = prev[j - 1];
      } else {
        curr[j] = 1 + Math.min(prev[j - 1], curr[j - 1], prev[j]);
      }
    }
    [prev, curr] = [curr, prev];
  }
  return prev[a.length];
}

/**
 * Determine max allowed edit distance based on query length.
 * Short words get less tolerance to avoid false positives.
 */
function maxEditDistance(wordLength) {
  if (wordLength <= 3) return 0;
  if (wordLength <= 5) return 1;
  if (wordLength <= 8) return 2;
  return 3;
}

/**
 * Check if a candidate name is a fuzzy match for the query.
 * Compares the full name, compact form, AND individual words against the query
 * using Damerau-Levenshtein distance (transposition-aware).
 */
function isFuzzyNameMatch(candidateName, query, threshold) {
  if (!candidateName || !query) return false;
  const candidateLower = candidateName.toLowerCase().trim();
  const queryLower = query.toLowerCase().trim();
  const maxDist = threshold ?? maxEditDistance(queryLower.length);

  // Check full name match
  if (damerauLevenshtein(candidateLower, queryLower) <= maxDist) return true;

  // Check compact (no spaces) match
  const candidateCompact = candidateLower.replace(/\s+/g, "");
  const queryCompact = queryLower.replace(/\s+/g, "");
  if (damerauLevenshtein(candidateCompact, queryCompact) <= maxDist) return true;

  // Check individual words of candidate name — catches "fairbuilt" vs "faribault"
  // when the full name is "Faribault Mill" (full-name distance too high).
  const candidateWords = candidateLower.split(/\s+/);
  if (candidateWords.length > 1) {
    for (const word of candidateWords) {
      if (word.length >= 3 && damerauLevenshtein(word, queryLower) <= maxDist) return true;
    }
  }

  return false;
}

/**
 * Compute a fuzzy relevance score (0-50) based on edit distance.
 * Lower distance = higher score. Returns 0 if not a fuzzy match.
 */
function fuzzyScore(candidateName, query) {
  if (!candidateName || !query) return 0;
  const candidateLower = candidateName.toLowerCase().trim();
  const queryLower = query.toLowerCase().trim();
  const maxDist = maxEditDistance(queryLower.length);

  const dist = damerauLevenshtein(candidateLower, queryLower);
  if (dist <= maxDist) {
    return Math.max(10, 50 - dist * 15);
  }

  // Try compact
  const candidateCompact = candidateLower.replace(/\s+/g, "");
  const queryCompact = queryLower.replace(/\s+/g, "");
  const distCompact = damerauLevenshtein(candidateCompact, queryCompact);
  if (distCompact <= maxDist) {
    return Math.max(10, 50 - distCompact * 15);
  }

  // Try individual words
  const candidateWords = candidateLower.split(/\s+/);
  if (candidateWords.length > 1) {
    let bestWordDist = Infinity;
    for (const word of candidateWords) {
      if (word.length >= 3) {
        bestWordDist = Math.min(bestWordDist, damerauLevenshtein(word, queryLower));
      }
    }
    if (bestWordDist <= maxDist) {
      return Math.max(10, 50 - bestWordDist * 15);
    }
  }

  return 0;
}

module.exports = { levenshtein, damerauLevenshtein, maxEditDistance, isFuzzyNameMatch, fuzzyScore };
