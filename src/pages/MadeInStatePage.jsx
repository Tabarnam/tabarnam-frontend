// /made-in/usa/:state — companies that manufacture in a US state, DC, or
// territory. Same pins-index data path as the country pages (the search API
// cannot answer this accurately — see src/lib/madeIn.js).
import React, { useEffect, useMemo, useState } from "react";
import { Link, Navigate, useParams, useSearchParams } from "react-router-dom";
import { Map as MapIcon } from "lucide-react";
import useDocumentHead from "@/hooks/useDocumentHead";
import ViewToggle from "@/components/madein/ViewToggle";
import {
  getRegionRegistry,
  getMadeInRegionAggregation,
  companiesForMode,
  companyHref,
} from "@/lib/madeIn";

const INITIAL_VISIBLE = 96;
const SHOW_MORE_STEP = 240;

export default function MadeInStatePage() {
  const { state: stateSlug } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const [agg, setAgg] = useState(null);
  const [failed, setFailed] = useState(false);
  const [visible, setVisible] = useState(INITIAL_VISIBLE);

  const showParam = (searchParams.get("show") || "").toLowerCase();
  const mode = showParam === "hq" || showParam === "both" ? showParam : "mfg";
  const setMode = (next) => {
    const params = new URLSearchParams(searchParams);
    if (next === "mfg") params.delete("show");
    else params.set("show", next);
    setSearchParams(params, { replace: true });
    setVisible(INITIAL_VISIBLE);
  };

  useEffect(() => {
    let dead = false;
    getMadeInRegionAggregation("US")
      .then((a) => !dead && setAgg(a))
      .catch(() => !dead && setFailed(true));
    return () => {
      dead = true;
    };
  }, []);

  useEffect(() => {
    setVisible(INITIAL_VISIBLE);
  }, [stateSlug]);

  const registry = useMemo(() => getRegionRegistry("US"), []);
  const region = registry.bySlug.get(String(stateSlug || "").toLowerCase()) || null;
  const data = region && agg ? agg.byRegion.get(region.code) : null;
  // Memoized so the JSON-LD useMemo below sees a stable array identity.
  const companies = useMemo(() => companiesForMode(data, mode), [data, mode]);
  const count = companies.length;
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

  const siblings = useMemo(() => {
    if (!agg) return [];
    return [...agg.byRegion.entries()]
      .filter(([code, b]) => b.companies.length > 0 && code !== region?.code && registry.byCode.has(code))
      .sort((a, z) => z[1].companies.length - a[1].companies.length)
      .slice(0, 12)
      .map(([code, b]) => ({ ...registry.byCode.get(code), count: b.companies.length }));
  }, [agg, region, registry]);

  const name = region?.name || "";
  const canonical = region
    ? `https://tabarnam.com/made-in/usa/${region.slug}`
    : "https://tabarnam.com/made-in/usa";
  const title = region
    ? `Made in ${name} — ${mfgCount > 0 ? `${mfgCount.toLocaleString()} ` : ""}Companies That Manufacture in ${name} | Tabarnam`
    : "Made in the USA | Tabarnam";
  const description = region
    ? `${mfgCount > 0 ? `${mfgCount.toLocaleString()} companies` : "Companies"} that manufacture in ${name}, with headquarters and manufacturing locations verified by Tabarnam. Find products actually made in ${name}.`
    : "";

  // Structured data describes the canonical manufacturing view, not the
  // currently-toggled one, so the three modes never disagree with the
  // canonical URL they all point at.
  const jsonLd = useMemo(() => {
    const mfgList = data?.companies || [];
    if (!region || mfgList.length === 0) return null;
    return {
      "@context": "https://schema.org",
      "@type": "CollectionPage",
      name: `Companies that manufacture in ${name}`,
      url: canonical,
      mainEntity: {
        "@type": "ItemList",
        numberOfItems: mfgList.length,
        itemListElement: mfgList.slice(0, 25).map((c, i) => ({
          "@type": "ListItem",
          position: i + 1,
          name: c.name,
          url: `https://tabarnam.com${companyHref(c)}`,
        })),
      },
    };
  }, [region, name, canonical, data]);

  useDocumentHead({ title, description, canonical, jsonLd, ready: !!region && !!agg });

  // Unknown state slug → the USA country page.
  if (!region) return <Navigate to="/made-in/usa" replace />;

  return (
    <div className="px-4 pb-12 max-w-5xl mx-auto">
      <nav className="text-sm text-muted-foreground mt-6" aria-label="Breadcrumb">
        <Link to="/made-in" className="hover:text-foreground transition-colors">
          Browse by country
        </Link>
        <span> / </span>
        <Link to="/made-in/usa" className="hover:text-foreground transition-colors">
          USA
        </Link>
        <span> / {name}</span>
      </nav>

      <h1 className="text-3xl font-bold text-foreground mt-3">Made in {name}</h1>

      {!agg && !failed && <p className="text-muted-foreground mt-3">Loading the catalog…</p>}
      {failed && (
        <p className="text-muted-foreground mt-3">
          The catalog is unavailable right now — please try again shortly.
        </p>
      )}

      {agg && (
        <>
          <p className="text-lg text-muted-foreground mt-2">
            {count > 0 ? (
              <>
                <span className="font-semibold text-foreground">{count.toLocaleString()}</span>{" "}
                {count === 1 ? "company" : "companies"} in the Tabarnam catalog{" "}
                {mode === "hq"
                  ? <>{count === 1 ? "is" : "are"} headquartered in {name}</>
                  : mode === "both"
                    ? <>manufacture in or are headquartered in {name}</>
                    : <>manufacture in {name}</>}
                {mode === "mfg" && data?.hqCount ? (
                  <> · {data.hqCount.toLocaleString()} {data.hqCount === 1 ? "is" : "are"} headquartered here</>
                ) : null}
                .
              </>
            ) : (
              <>
                {mode === "hq"
                  ? <>No companies in the catalog are headquartered in {name} yet</>
                  : <>We haven't verified any manufacturers in {name} yet</>}
                {" "}— the catalog grows daily.
              </>
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
              to="/made-in/usa"
              className="inline-flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-md border border-border text-foreground hover:bg-muted transition-colors"
            >
              All US manufacturers
            </Link>
          </div>

          {/* The list gets its own inclusive heading: the toggle can show
              manufacturing, headquarters, or both, and "<place> locations"
              stays true for all three — while the page title keeps the
              "Made in ___" identity (and its search keyword). */}
          {toggleCounts && (toggleCounts.mfg > 0 || toggleCounts.hq > 0) && (
            <div className="flex flex-wrap items-center justify-between gap-3 mt-10 pb-2 border-b border-border">
              <h2 className="text-lg font-semibold text-foreground">{name} locations</h2>
              <ViewToggle mode={mode} onChange={setMode} counts={toggleCounts} />
            </div>
          )}

          {count > 0 && (
            <>
              <ul className="mt-5 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 list-none p-0">
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
                    key={s.code}
                    to={`/made-in/usa/${s.slug}`}
                    className="text-sm px-3 py-1.5 rounded-full border border-border text-foreground hover:bg-muted transition-colors"
                  >
                    {s.name} <span className="text-muted-foreground">({s.count.toLocaleString()})</span>
                  </Link>
                ))}
                <Link
                  to="/made-in/usa"
                  className="text-sm px-3 py-1.5 rounded-full border border-border text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                >
                  All states →
                </Link>
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}
