/**
 * Canonical URL slugs for company pages (/company/<slug>).
 *
 * Assigned in the pins index rather than derived at request time, because
 * uniqueness is a GLOBAL property: you cannot tell whether "eclipse" is free
 * without looking at all 14k companies. Computing it once per index rebuild
 * and storing it on the row means the server renderer and the React route both
 * just READ the slug — no shared derivation to drift, no per-request work.
 *
 * Measured on the live catalog (2026-08-20, 14,486 companies): 14,445 distinct
 * name slugs, 41 colliding slugs covering 82 companies (0.6%), of which 4 are
 * true duplicate records sharing one domain. So the plain name wins for
 * virtually everyone and the tie-break machinery is a rare path.
 *
 * Stability is the constraint that shapes the rules — a URL that moves loses
 * whatever ranking it had:
 *   - The bare slug goes to the OLDEST colliding company (ids are time-ordered,
 *     `company_<epoch-ms>_<rand>`). A newly imported namesake therefore never
 *     displaces an existing URL; it takes the suffixed form itself.
 *   - Losers get `<name>-<first domain label>`, which is stable, unique in
 *     practice, and still readable: /company/eclipse-eclipsemints.
 *   - Genuine duplicates (same name AND same domain) fall back to a numeric
 *     suffix in id order.
 */

/**
 * Slug-safe form of a display name. `&` becomes "and" rather than vanishing,
 * so "Boll & Branch" reads boll-and-branch instead of boll-branch.
 */
function slugify(value) {
  return String(value == null ? "" : value)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    // Keep URLs sane for a company whose "name" is a sentence.
    .slice(0, 70)
    .replace(/-+$/, "");
}

/** First label of a domain: "eclipsemints.com.au" → "eclipsemints". */
function domainLabel(domain) {
  return slugify(String(domain || "").split(".")[0]);
}

/**
 * Assign a unique slug to every entry, in place, returning the same array.
 *
 * Deterministic: the result depends only on the (id, name, domain) set, so a
 * full rebuild and an incremental upsert converge on identical slugs.
 *
 * @param {Array<Array>} entries pins rows — [id, name, …]; slug is written to
 *   the index given by `slugIndex`.
 * @param {{idIndex?: number, nameIndex?: number, domainIndex?: number, slugIndex?: number}} [pos]
 */
function assignSlugs(entries, pos = {}) {
  const { idIndex = 0, nameIndex = 1, domainIndex = 3, slugIndex = 12 } = pos;
  const rows = Array.isArray(entries) ? entries : [];

  // Oldest first, so the bare slug lands on the company that has had the URL
  // longest. localeCompare on the id string is time-ordered given the
  // company_<epoch-ms>_<rand> format, and is stable for anything else.
  const ordered = [...rows].sort((a, z) =>
    String(a?.[idIndex] ?? "").localeCompare(String(z?.[idIndex] ?? ""))
  );

  const byBase = new Map();
  for (const row of ordered) {
    if (!Array.isArray(row)) continue;
    const base = slugify(row[nameIndex]);
    if (!base) continue;
    if (!byBase.has(base)) byBase.set(base, []);
    byBase.get(base).push(row);
  }

  const taken = new Set();
  // Uncontested bases are claimed first: a company that shares its name with
  // nobody must never lose its plain slug to another company's tie-break.
  for (const [base, group] of byBase) {
    if (group.length === 1) {
      group[0][slugIndex] = base;
      taken.add(base);
    }
  }

  for (const [base, group] of byBase) {
    if (group.length === 1) continue;
    let first = true;
    for (const row of group) {
      if (first && !taken.has(base)) {
        row[slugIndex] = base;
        taken.add(base);
        first = false;
        continue;
      }
      first = false;
      const label = domainLabel(row[domainIndex]);
      let candidate = label && label !== base ? `${base}-${label}` : base;
      if (!candidate || taken.has(candidate)) {
        // Same name and same domain — a genuine duplicate record.
        let n = 2;
        const stem = candidate || base;
        while (taken.has(`${stem}-${n}`)) n += 1;
        candidate = `${stem}-${n}`;
      }
      row[slugIndex] = candidate;
      taken.add(candidate);
    }
  }

  return rows;
}

module.exports = { assignSlugs, slugify, domainLabel };
