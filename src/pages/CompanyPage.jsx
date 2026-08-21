// /company/:slug — the indexable page for one company.
//
// api/_companyRender.js renders this same page server-side and seeds it into
// #root, so this component must agree with it: same headline, same facts, same
// ordering. Where they disagree the page visibly rewrites itself the moment
// React mounts.
import React, { useEffect, useMemo, useState } from "react";
import { Link, Navigate, useParams } from "react-router-dom";
import { ExternalLink, Search } from "lucide-react";
import useDocumentHead from "@/hooks/useDocumentHead";
import {
  fetchCompanyFacets,
  getCompanyRegistry,
  joinProse,
  manufacturingPlaces,
} from "@/lib/companyPages";
import { getCountryRegistry, getRegionRegistry, flagEmoji } from "@/lib/madeIn";

export default function CompanyPage() {
  const { slug } = useParams();
  const [registry, setRegistry] = useState(null);
  const [countries, setCountries] = useState(null);
  const [facets, setFacets] = useState(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let dead = false;
    getCompanyRegistry().then((r) => !dead && setRegistry(r)).catch(() => !dead && setFailed(true));
    getCountryRegistry().then((c) => !dead && setCountries(c)).catch(() => !dead && setFailed(true));
    return () => {
      dead = true;
    };
  }, []);

  const key = String(slug || "").toLowerCase();
  const entry = registry?.bySlug.get(key) || null;
  const domainMatch = !entry && registry ? registry.byDomain.get(key) : null;

  // Enrichment, fetched once the company is known. Never sets `failed`: the
  // page is complete without industries and products, and the server-rendered
  // version has already shown them.
  useEffect(() => {
    if (!entry?.id) return undefined;
    let dead = false;
    fetchCompanyFacets(entry.id).then((f) => !dead && setFacets(f));
    return () => {
      dead = true;
    };
  }, [entry?.id]);

  const regions = useMemo(() => getRegionRegistry("US"), []);
  const places = useMemo(() => (entry ? manufacturingPlaces(entry) : []), [entry]);

  const name = entry?.name || "";
  const mfgNames = useMemo(
    () =>
      (entry?.mfgCCs || [])
        .map((cc) => countries?.byCC.get(cc)?.displayName)
        .filter(Boolean),
    [entry, countries]
  );
  const hqPlace = entry?.hqLabel || countries?.byCC.get(entry?.hqCC)?.displayName || "";

  const canonical = `https://tabarnam.com/company/${entry?.slug || key}`;
  const title = mfgNames.length
    ? `Where Is ${name} Made? Manufacturing in ${joinProse(mfgNames)} | Tabarnam`
    : `Where Is ${name} Made? Headquarters and Manufacturing | Tabarnam`;
  const description = `${
    hqPlace ? `${name} is headquartered in ${hqPlace}` : name
  }${mfgNames.length ? `${hqPlace ? " and manufactures" : " manufactures"} in ${joinProse(mfgNames)}` : ""}. Headquarters and manufacturing locations from the Tabarnam catalog.`;

  const jsonLd = useMemo(() => {
    if (!entry) return null;
    return {
      "@context": "https://schema.org",
      "@type": "Organization",
      "@id": canonical,
      name,
      url: canonical,
      ...(entry.tagline ? { description: entry.tagline } : {}),
      ...(entry.domain ? { sameAs: [`https://${entry.domain}`] } : {}),
    };
  }, [entry, canonical, name]);

  useDocumentHead({ title, description, canonical, jsonLd, ready: !!entry && !!countries });

  // A pasted website URL is a natural way in; the server 301s these, so match
  // it rather than showing a not-found for a company we can clearly identify.
  if (domainMatch?.slug) return <Navigate to={`/company/${domainMatch.slug}`} replace />;

  if (registry && !entry) {
    return (
      <div className="px-4 pb-12 max-w-3xl mx-auto">
        <h1 className="text-3xl font-bold text-foreground mt-8">Company not found</h1>
        <p className="text-muted-foreground mt-3">
          There's no company at <code className="text-foreground">/company/{key}</code>.
        </p>
        <div className="flex flex-wrap gap-3 mt-6">
          <Link to="/" className="text-sm text-primary hover:underline">Search the catalog</Link>
          <Link to="/made-in" className="text-sm text-primary hover:underline">Browse by country</Link>
        </div>
      </div>
    );
  }

  // Mirrors api/_companyRender.js: a link whose text just repeats the label is
  // dropped, so a country-precision plant reads "China" rather than
  // "China (China)".
  const placeLinks = (cc, region, label) => {
    const out = [];
    const r = region ? regions.byCode.get(region) : null;
    const c = cc ? countries?.byCC.get(cc) : null;
    if (r && r.name !== label) out.push(<Link key="r" to={`/made-in/usa/${r.slug}`} className="hover:text-foreground transition-colors">{r.name}</Link>);
    if (c && c.displayName !== label) out.push(<Link key="c" to={`/made-in/${c.slug}`} className="hover:text-foreground transition-colors">{c.displayName}</Link>);
    return out;
  };

  return (
    <div className="px-4 pb-12 max-w-3xl mx-auto">
      <nav className="text-sm text-muted-foreground mt-6" aria-label="Breadcrumb">
        <Link to="/" className="hover:text-foreground transition-colors">Tabarnam</Link>
        {name && <span> / {name}</span>}
      </nav>

      {!registry && !failed && <p className="text-muted-foreground mt-6">Loading…</p>}
      {failed && (
        <p className="text-muted-foreground mt-6">
          The catalog is unavailable right now — please try again shortly.
        </p>
      )}

      {entry && (
        <>
          <h1 className="text-3xl font-bold text-foreground mt-3">Where is {name} made?</h1>
          {entry.tagline && <p className="text-lg text-muted-foreground mt-2">{entry.tagline}</p>}

          <p className="text-lg text-muted-foreground mt-4">
            {mfgNames.length ? (
              <>
                <span className="text-foreground font-medium">{name}</span> manufactures in{" "}
                {joinProse(mfgNames)}
              </>
            ) : (
              <>The Tabarnam catalog doesn't list a manufacturing location for {name} yet</>
            )}
            {hqPlace && <>, and is headquartered in {hqPlace}</>}.
          </p>

          <dl className="mt-6 grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2 text-sm">
            {hqPlace && (
              <>
                <dt className="text-muted-foreground">Headquarters</dt>
                <dd className="text-foreground">
                  {hqPlace}{" "}
                  {entry.hqCC && <span aria-hidden="true">{flagEmoji(entry.hqCC)}</span>}
                </dd>
              </>
            )}
            {entry.domain && (
              <>
                <dt className="text-muted-foreground">Website</dt>
                <dd>
                  <a
                    href={`https://${entry.domain}`}
                    target="_blank"
                    rel="noopener noreferrer nofollow"
                    className="text-primary hover:underline inline-flex items-center gap-1"
                  >
                    {entry.domain}
                    <ExternalLink size={13} aria-hidden="true" />
                  </a>
                </dd>
              </>
            )}
            {/* facets.industries is deliberately not rendered: it is a search
                retrieval lever an admin edits to make a company match a query,
                not a description of the company. See api/_companyFacets.js. */}
            {/* Only a rating reviews actually back — a bare star count with
                nothing behind it is a number the page can't justify. */}
            {facets?.stars != null && facets.reviews > 0 && (
              <>
                <dt className="text-muted-foreground">Tabarnam rating</dt>
                <dd className="text-foreground">
                  {facets.stars} / 5{" "}
                  <span className="text-muted-foreground">
                    from {facets.reviews} {facets.reviews === 1 ? "review" : "reviews"}
                  </span>
                </dd>
              </>
            )}
          </dl>

          <section className="mt-10 border-t border-border pt-6">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
              Manufacturing locations
            </h2>
            {places.length ? (
              <ul className="mt-3 list-none p-0 flex flex-col gap-2">
                {places.map((p, i) => {
                  const country = p.cc ? countries?.byCC.get(p.cc) : null;
                  const label = p.label || country?.displayName || "Location not specified";
                  const links = placeLinks(p.cc, p.region, label);
                  return (
                    <li key={`${p.label}-${p.cc}-${p.region}-${i}`} className="text-sm">
                      {links.length === 0 && country ? (
                        <Link to={`/made-in/${country.slug}`} className="text-foreground hover:text-primary transition-colors">
                          {label}
                        </Link>
                      ) : (
                        <span className="text-foreground">{label}</span>
                      )}
                      {links.length > 0 && (
                        <span className="text-muted-foreground">
                          {" ("}
                          {links.map((l, j) => (
                            <React.Fragment key={j}>
                              {j > 0 && " · "}
                              {l}
                            </React.Fragment>
                          ))}
                          {")"}
                        </span>
                      )}
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground mt-3">
                The catalog doesn't list a manufacturing location for {name} yet. That means we
                don't have one, not that the company manufactures nowhere.
              </p>
            )}
          </section>

          {/* Product terms are what "<product> made in <place>" searches match
              on. Prose, not a chip wall, and capped upstream at 20 of a
              possible ~90 so the page reads as a description rather than a
              keyword dump. Mirrors api/_companyRender.js. */}
          {facets?.products?.length > 0 && (
            <section className="mt-10 border-t border-border pt-6">
              <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
                What {name} makes
              </h2>
              <p className="text-sm text-foreground mt-3">{facets.products.join(", ")}.</p>
            </section>
          )}

          <section className="mt-10 border-t border-border pt-6">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
              About this listing
            </h2>
            <p className="text-sm text-muted-foreground mt-3">
              Headquarters and manufacturing are recorded separately, because they are often
              different places: a brand headquartered in one country frequently manufactures in
              another. Tabarnam lists what the catalog holds and marks the rest unknown. Entries
              come from public sources and may be incomplete or out of date — production moves.
            </p>
            <div className="flex flex-wrap gap-3 mt-5">
              <Link
                to={`/results?q=${encodeURIComponent(name)}`}
                className="inline-flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-md border border-tabarnam-blue-bold text-tabarnam-blue-dark dark:text-tabarnam-blue-bold hover:bg-muted transition-colors"
              >
                <Search size={15} aria-hidden="true" />
                Search {name} on Tabarnam
              </Link>
              <Link
                to="/made-in"
                className="inline-flex items-center text-sm px-3 py-1.5 rounded-md border border-border text-foreground hover:bg-muted transition-colors"
              >
                Browse by country
              </Link>
            </div>
          </section>
        </>
      )}
    </div>
  );
}
