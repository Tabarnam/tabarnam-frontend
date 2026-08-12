// /made-in/:slug — SEO landing page: every company in the catalog that
// manufactures in a given country. Data comes entirely from the pins index
// (whole-catalog, accurate counts) — deliberately NOT the search API, whose
// mfgCountry filter only sees a 500-doc recency pool.
import React, { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { Link, Navigate, useParams, useSearchParams } from "react-router-dom";
import { Search } from "lucide-react";
import useDocumentHead from "@/hooks/useDocumentHead";
import ViewToggle from "@/components/madein/ViewToggle";
import {
  getCountryRegistry,
  getMadeInAggregation,
  getRegionRegistry,
  aggregateByRegion,
  companiesForMode,
  flagEmoji,
} from "@/lib/madeIn";
import { fetchPinsIndex } from "@/components/results/map/pinsIndexClient";
import { buildPlaceMarkers } from "@/components/results/map/markerData";

// Lazy so leaflet + markercluster stay out of the main bundle.
const MadeInMap = lazy(() => import("@/components/madein/MadeInMap"));

export default function MadeInPage() {
  const { slug } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const [registry, setRegistry] = useState(null);
  const [agg, setAgg] = useState(null);
  const [pins, setPins] = useState(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let dead = false;
    getCountryRegistry().then((r) => !dead && setRegistry(r)).catch(() => !dead && setFailed(true));
    getMadeInAggregation().then((a) => !dead && setAgg(a)).catch(() => !dead && setFailed(true));
    fetchPinsIndex().then((p) => !dead && setPins(p)).catch(() => {});
    return () => {
      dead = true;
    };
  }, []);


  const country = registry?.bySlug.get(String(slug || "").toLowerCase()) || null;
  const showParam = (searchParams.get("show") || "").toLowerCase();
  const mode = showParam === "hq" || showParam === "both" ? showParam : "mfg";
  const setMode = (next) => {
    const params = new URLSearchParams(searchParams);
    if (next === "mfg") params.delete("show");
    else params.set("show", next);
    setSearchParams(params, { replace: true });
  };

  const data = country && agg ? agg.byCC.get(country.cc) : null;
  // Memoized so the JSON-LD useMemo below doesn't see a new array identity on
  // every render.
  const companies = useMemo(() => companiesForMode(data, mode), [data, mode]);
  // Map pins scoped to THIS country — filtered on each pin's own country
  // code, so a company that also manufactures elsewhere contributes only its
  // in-country locations.
  const markers = useMemo(
    () => (pins && country ? buildPlaceMarkers(pins, { cc: country.cc, mode }) : []),
    [pins, country, mode]
  );
  // Head tags always describe the canonical (manufacturing) view.
  const mfgCount = data?.companies?.length || 0;
  const toggleCounts = useMemo(
    () =>
      data
        ? {
            mfg: data.companies.length,
            hq: data.hqCompanies.length,
            both: companiesForMode(data, "both").length,
          }
        : null,
    [data]
  );

  // State/territory breakdown — only for countries with published
  // subdivision pages (US today).
  const stateRows = useMemo(() => {
    if (!pins || country?.cc !== "US") return [];
    const regRegistry = getRegionRegistry("US");
    const { byRegion } = aggregateByRegion(pins, "US");
    return [...byRegion.entries()]
      .filter(([code, b]) => b.companies.length > 0 && regRegistry.byCode.has(code))
      .map(([code, b]) => ({ ...regRegistry.byCode.get(code), count: b.companies.length }))
      .sort((a, z) => z.count - a.count || a.name.localeCompare(z.name));
  }, [pins, country]);

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
    ? `Made in ${display} — ${mfgCount > 0 ? `${mfgCount.toLocaleString()} ` : ""}Companies That Manufacture in ${display} | Tabarnam`
    : "Made in… | Tabarnam";
  const description = country
    ? `${mfgCount > 0 ? `${mfgCount.toLocaleString()} companies` : "Companies"} that manufacture in ${display}, with headquarters and manufacturing locations verified by Tabarnam. Find products actually made in ${display}.`
    : "";

  // Structured data describes the canonical manufacturing view, not the
  // currently-toggled one, so the three modes never disagree with the
  // canonical URL they all point at. Individual companies are deliberately
  // NOT enumerated: the page shows them on a map rather than as visible text,
  // and structured data must describe content the visitor can actually see.
  const itemListSchema = useMemo(() => {
    const mfgList = data?.companies || [];
    if (!country || mfgList.length === 0) return null;
    return {
      "@context": "https://schema.org",
      "@type": "CollectionPage",
      name: `Companies that manufacture in ${display}`,
      description: `${mfgList.length} companies in the Tabarnam catalog manufacture in ${display}.`,
      url: canonical,
      mainEntity: {
        "@type": "ItemList",
        numberOfItems: mfgList.length,
      },
    };
  }, [country, display, canonical, data]);

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
                {count === 1 ? "company" : "companies"} in the Tabarnam catalog{" "}
                {mode === "hq"
                  ? <>{count === 1 ? "is" : "are"} headquartered in {display}</>
                  : mode === "both"
                    ? <>manufacture in or are headquartered in {display}</>
                    : <>manufacture in {display}</>}
                {mode === "mfg" && data?.hqCount ? (
                  <> · {data.hqCount.toLocaleString()} {data.hqCount === 1 ? "is" : "are"} headquartered here</>
                ) : null}
                .
              </>
            ) : (
              <>
                {mode === "hq"
                  ? <>No companies in the catalog are headquartered in {display} yet</>
                  : <>We haven't verified any manufacturers in {display} yet</>}
                {" "}— the catalog grows daily.
              </>
            )}
          </p>

          <div className="flex flex-wrap gap-2 mt-4">
            <Link
              to={`/results?country=${encodeURIComponent(country.name)}`}
              className="inline-flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-md border border-tabarnam-blue-bold text-tabarnam-blue-dark dark:text-tabarnam-blue-bold hover:bg-muted transition-colors"
            >
              <Search size={15} aria-hidden="true" />
              Search within {display}
            </Link>
          </div>

          {/* The list gets its own inclusive heading: the toggle can show
              manufacturing, headquarters, or both, and "<place> locations"
              stays true for all three — while the page title keeps the
              "Made in ___" identity (and its search keyword). */}
          {toggleCounts && (toggleCounts.mfg > 0 || toggleCounts.hq > 0) && (
            <div className="flex flex-wrap items-center justify-between gap-3 mt-10 pb-2 border-b border-border">
              <h2 className="text-lg font-semibold text-foreground">{display} locations</h2>
              <ViewToggle mode={mode} onChange={setMode} counts={toggleCounts} />
            </div>
          )}

          {count > 0 && (
            <div className="mt-5">
              <Suspense
                fallback={<div className="h-[420px] sm:h-[520px] rounded-lg border border-border bg-card" />}
              >
                <MadeInMap markers={markers} placeName={display} />
              </Suspense>
              <p className="text-xs text-muted-foreground mt-2">
                Hover a pin for the company; click through to open its profile in a new tab.
              </p>
            </div>
          )}

          {stateRows.length > 0 && (
            <section className="mt-10 border-t border-border pt-6">
              <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
                By state &amp; territory
              </h2>
              <ul className="mt-3 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2 list-none p-0">
                {stateRows.map((s) => (
                  <li key={s.code}>
                    <Link
                      to={`/made-in/usa/${s.slug}`}
                      className="flex items-baseline justify-between gap-2 border border-border rounded-lg bg-card px-3 py-2 hover:bg-muted transition-colors"
                    >
                      <span className="text-sm font-medium text-foreground truncate">{s.name}</span>
                      <span className="text-xs text-muted-foreground shrink-0">
                        {s.count.toLocaleString()}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
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
