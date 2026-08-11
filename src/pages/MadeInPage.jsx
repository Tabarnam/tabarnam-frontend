// /made-in/:slug — SEO landing page: every company in the catalog that
// manufactures in a given country. Data comes entirely from the pins index
// (whole-catalog, accurate counts) — deliberately NOT the search API, whose
// mfgCountry filter only sees a 500-doc recency pool.
import React, { useEffect, useMemo, useState } from "react";
import { Link, Navigate, useParams } from "react-router-dom";
import { Map as MapIcon, Search } from "lucide-react";
import useDocumentHead from "@/hooks/useDocumentHead";
import {
  getCountryRegistry,
  getMadeInAggregation,
  companyHref,
  flagEmoji,
} from "@/lib/madeIn";

const INITIAL_VISIBLE = 96;
const SHOW_MORE_STEP = 240;

export default function MadeInPage() {
  const { slug } = useParams();
  const [registry, setRegistry] = useState(null);
  const [agg, setAgg] = useState(null);
  const [failed, setFailed] = useState(false);
  const [visible, setVisible] = useState(INITIAL_VISIBLE);

  useEffect(() => {
    let dead = false;
    getCountryRegistry().then((r) => !dead && setRegistry(r)).catch(() => !dead && setFailed(true));
    getMadeInAggregation().then((a) => !dead && setAgg(a)).catch(() => !dead && setFailed(true));
    return () => {
      dead = true;
    };
  }, []);

  useEffect(() => {
    setVisible(INITIAL_VISIBLE);
  }, [slug]);

  const country = registry?.bySlug.get(String(slug || "").toLowerCase()) || null;
  const data = country && agg ? agg.byCC.get(country.cc) : null;
  const companies = data?.companies || [];

  const siblings = useMemo(() => {
    if (!agg || !registry) return [];
    return [...agg.byCC.entries()]
      .filter(([cc, b]) => b.companies.length > 0 && cc !== country?.cc && registry.byCC.has(cc))
      .sort((a, z) => z[1].companies.length - a[1].companies.length)
      .slice(0, 12)
      .map(([cc, b]) => ({ ...registry.byCC.get(cc), count: b.companies.length }));
  }, [agg, registry, country]);

  const display = country?.displayName || "";
  const count = companies.length;
  const flag = country ? flagEmoji(country.cc) : "";
  const canonical = country ? `https://tabarnam.com/made-in/${country.slug}` : "https://tabarnam.com/made-in";
  const title = country
    ? `Made in ${display} — ${count > 0 ? `${count.toLocaleString()} ` : ""}Companies That Manufacture in ${display} | Tabarnam`
    : "Made in… | Tabarnam";
  const description = country
    ? `${count > 0 ? `${count.toLocaleString()} companies` : "Companies"} that manufacture in ${display}, with headquarters and manufacturing locations verified by Tabarnam. Find products actually made in ${display}.`
    : "";

  const itemListSchema = useMemo(() => {
    if (!country || count === 0) return null;
    return {
      "@context": "https://schema.org",
      "@type": "CollectionPage",
      name: `Companies that manufacture in ${display}`,
      url: canonical,
      mainEntity: {
        "@type": "ItemList",
        numberOfItems: count,
        itemListElement: companies.slice(0, 25).map((c, i) => ({
          "@type": "ListItem",
          position: i + 1,
          name: c.name,
          url: `https://tabarnam.com${companyHref(c)}`,
        })),
      },
    };
  }, [country, count, display, canonical, companies]);

  // Written only once the catalog has loaded, so the title never ships a
  // placeholder count. (Hooks run before the redirects below by necessity.)
  useDocumentHead({
    title,
    description,
    canonical,
    jsonLd: itemListSchema,
    ready: !!country && !!agg,
  });

  // Unknown slug: send to the country directory rather than 404ing.
  if (registry && !country) return <Navigate to="/made-in" replace />;
  // Alias slug (e.g. /made-in/united-states): redirect to the canonical slug.
  if (country && String(slug).toLowerCase() !== country.slug) {
    return <Navigate to={`/made-in/${country.slug}`} replace />;
  }

  return (
    <div className="px-4 pb-12 max-w-5xl mx-auto">
      <nav className="text-sm text-muted-foreground mt-6" aria-label="Breadcrumb">
        <Link to="/made-in" className="hover:text-foreground transition-colors">
          Browse by country
        </Link>
        {country && <span> / {display}</span>}
      </nav>

      <h1 className="text-3xl font-bold text-foreground mt-3">
        Made in {display} {flag && <span aria-hidden="true">{flag}</span>}
      </h1>

      {!agg && !failed && <p className="text-muted-foreground mt-3">Loading the catalog…</p>}
      {failed && (
        <p className="text-muted-foreground mt-3">
          The catalog is unavailable right now — please try again shortly.
        </p>
      )}

      {country && agg && (
        <>
          <p className="text-lg text-muted-foreground mt-2">
            {count > 0 ? (
              <>
                <span className="font-semibold text-foreground">{count.toLocaleString()}</span>{" "}
                {count === 1 ? "company" : "companies"} in the Tabarnam catalog manufacture in {display}
                {data?.hqCount ? (
                  <> · {data.hqCount.toLocaleString()} {data.hqCount === 1 ? "is" : "are"} headquartered here</>
                ) : null}
                .
              </>
            ) : (
              <>We haven't verified any manufacturers in {display} yet — the catalog grows daily.</>
            )}
          </p>

          <div className="flex flex-wrap gap-2 mt-4">
            <Link
              to="/map"
              className="inline-flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-md border border-tabarnam-blue-bold text-tabarnam-blue-dark dark:text-tabarnam-blue-bold hover:bg-muted transition-colors"
            >
              <MapIcon size={15} aria-hidden="true" />
              See the company map
            </Link>
            <Link
              to={`/results?country=${encodeURIComponent(country.name)}`}
              className="inline-flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-md border border-border text-foreground hover:bg-muted transition-colors"
            >
              <Search size={15} aria-hidden="true" />
              Search within {display}
            </Link>
          </div>

          {count > 0 && (
            <>
              <ul className="mt-8 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 list-none p-0">
                {companies.slice(0, visible).map((c) => (
                  <li key={c.id} className="border border-border rounded-lg bg-card p-3">
                    <Link
                      to={companyHref(c)}
                      className="font-semibold text-tabarnam-blue-dark dark:text-tabarnam-blue-bold hover:underline underline-offset-2"
                    >
                      {c.name}
                    </Link>
                    {c.tagline && (
                      <p className="text-xs text-muted-foreground mt-1 line-clamp-2">{c.tagline}</p>
                    )}
                  </li>
                ))}
              </ul>
              {visible < count && (
                <div className="text-center mt-6">
                  <button
                    type="button"
                    onClick={() => setVisible((v) => v + SHOW_MORE_STEP)}
                    className="text-sm px-4 py-2 rounded-md border border-border text-foreground hover:bg-muted transition-colors"
                  >
                    Show more ({(count - visible).toLocaleString()} remaining)
                  </button>
                </div>
              )}
            </>
          )}

          {siblings.length > 0 && (
            <section className="mt-12 border-t border-border pt-6">
              <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
                Also made in
              </h2>
              <div className="flex flex-wrap gap-2 mt-3">
                {siblings.map((s) => (
                  <Link
                    key={s.cc}
                    to={`/made-in/${s.slug}`}
                    className="text-sm px-3 py-1.5 rounded-full border border-border text-foreground hover:bg-muted transition-colors"
                  >
                    {flagEmoji(s.cc)} {s.displayName}{" "}
                    <span className="text-muted-foreground">({s.count.toLocaleString()})</span>
                  </Link>
                ))}
                <Link
                  to="/made-in"
                  className="text-sm px-3 py-1.5 rounded-full border border-border text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                >
                  All countries →
                </Link>
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}
