/**
 * Fuzzy matching utilities for typo-tolerant search.
 * Used as a fallback when exact search returns few/no results.
 */

/**
 * Compute Levenshtein edit distance between two strings.
 */
function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;

  // Use two-row optimization instead of full matrix
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
 * Compares each name-level word and the full name against the query.
 */
function isFuzzyNameMatch(candidateName, query, threshold) {
  if (!candidateName || !query) return false;
  const candidateLower = candidateName.toLowerCase().trim();
  const queryLower = query.toLowerCase().trim();
  const maxDist = threshold ?? maxEditDistance(queryLower.length);

  // Check full name match
  if (levenshtein(candidateLower, queryLower) <= maxDist) return true;

  // Check compact (no spaces) match
  const candidateCompact = candidateLower.replace(/\s+/g, "");
  const queryCompact = queryLower.replace(/\s+/g, "");
  if (levenshtein(candidateCompact, queryCompact) <= maxDist) return true;

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

  const dist = levenshtein(candidateLower, queryLower);
  if (dist <= maxDist) {
    return Math.max(10, 50 - dist * 15);
  }

  // Try compact
  const candidateCompact = candidateLower.replace(/\s+/g, "");
  const queryCompact = queryLower.replace(/\s+/g, "");
  const distCompact = levenshtein(candidateCompact, queryCompact);
  if (distCompact <= maxDist) {
    return Math.max(10, 50 - distCompact * 15);
  }

  return 0;
}

module.exports = { levenshtein, maxEditDistance, isFuzzyNameMatch, fuzzyScore };
