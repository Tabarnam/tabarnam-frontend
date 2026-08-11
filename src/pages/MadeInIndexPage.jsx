// /made-in — the country directory: every country with at least one verified
// manufacturer, with whole-catalog counts from the pins index.
import React, { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import useDocumentHead from "@/hooks/useDocumentHead";
import { getCountryRegistry, getMadeInAggregation, flagEmoji } from "@/lib/madeIn";

export default function MadeInIndexPage() {
  const [registry, setRegistry] = useState(null);
  const [agg, setAgg] = useState(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let dead = false;
    getCountryRegistry().then((r) => !dead && setRegistry(r)).catch(() => !dead && setFailed(true));
    getMadeInAggregation().then((a) => !dead && setAgg(a)).catch(() => !dead && setFailed(true));
    return () => {
      dead = true;
    };
  }, []);

  const rows = useMemo(() => {
    if (!agg || !registry) return [];
    return [...agg.byCC.entries()]
      .filter(([cc, b]) => b.companies.length > 0 && registry.byCC.has(cc))
      .map(([cc, b]) => ({ ...registry.byCC.get(cc), count: b.companies.length }))
      .sort((a, z) => z.count - a.count || a.displayName.localeCompare(z.displayName));
  }, [agg, registry]);

  const canonical = "https://tabarnam.com/made-in";
  const title = "Made in… — Browse Companies by Manufacturing Country | Tabarnam";
  const description =
    "Browse the Tabarnam catalog by where products are actually manufactured — verified headquarters and manufacturing locations for every company, in every country.";

  useDocumentHead({ title, description, canonical });

  return (
    <div className="px-4 pb-12 max-w-5xl mx-auto">
      <h1 className="text-3xl font-bold text-foreground mt-6">Made in…</h1>
      <p className="text-lg text-muted-foreground mt-2">
        Browse companies by where they actually manufacture.
        {agg ? ` ${agg.total.toLocaleString()} companies across ${rows.length} countries.` : ""}
      </p>

      {!agg && !failed && <p className="text-muted-foreground mt-4">Loading the catalog…</p>}
      {failed && (
        <p className="text-muted-foreground mt-4">
          The catalog is unavailable right now — please try again shortly.
        </p>
      )}

      {rows.length > 0 && (
        <ul className="mt-8 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2 list-none p-0">
          {rows.map((r) => (
            <li key={r.cc}>
              <Link
                to={`/made-in/${r.slug}`}
                className="flex items-baseline justify-between gap-2 border border-border rounded-lg bg-card px-3 py-2 hover:bg-muted transition-colors"
              >
                <span className="text-sm font-medium text-foreground truncate">
                  {flagEmoji(r.cc)} {r.displayName}
                </span>
                <span className="text-xs text-muted-foreground shrink-0">{r.count.toLocaleString()}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
