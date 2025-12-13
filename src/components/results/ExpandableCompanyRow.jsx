import React, { useState } from "react";
import ReviewsWidget from "@/components/ReviewsWidget";
import { withAmazonAffiliate } from "@/lib/amazonAffiliate";
import { RatingDots, RatingHearts } from "@/components/Stars";
import { getQQDefaultIconType, getQQFilledCount } from "@/lib/stars/qqRating";

function toFiniteNumber(v) {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim()) {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function normalizeAffiliateLinks(company) {
  if (!company) return [];
  const links = [];

  if (Array.isArray(company.affiliate_links)) {
    for (const entry of company.affiliate_links) {
      if (!entry) continue;
      if (typeof entry === "string") {
        links.push({ label: "", url: entry });
      } else if (typeof entry === "object" && entry.url) {
        links.push({ label: entry.label || "", url: entry.url });
      }
    }
  }

  if (Array.isArray(company.affiliate_link_urls)) {
    for (const url of company.affiliate_link_urls) {
      if (url) links.push({ label: "", url });
    }
  }

  for (let i = 1; i <= 5; i += 1) {
    const url =
      company[`affiliate_link_${i}`] ||
      company[`affiliate_link_${i}_url`] ||
      company[`affiliate${i}_url`];
    if (url) links.push({ label: "", url });
  }

  const seen = new Set();
  const deduped = [];
  for (const link of links) {
    const key = (link.url || "").trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    deduped.push(link);
    if (deduped.length >= 5) break;
  }
  return deduped;
}

function inferAffiliateLabel(link, fallbackPrefix = "Affiliate") {
  const explicit = (link?.label || "").trim();
  if (explicit) return explicit;
  const rawUrl = (link?.url || "").trim();
  if (!rawUrl) return fallbackPrefix;
  try {
    const u = new URL(rawUrl.startsWith("http") ? rawUrl : `https://${rawUrl}`);
    const host = u.hostname.replace(/^www\./i, "");
    return host || fallbackPrefix;
  } catch {
    return rawUrl || fallbackPrefix;
  }
}

export default function ExpandableCompanyRow({
  company,
  sortBy,
  unit,
  onKeywordSearch,
  rightColsOrder,
}) {
  const [isExpanded, setIsExpanded] = useState(false);


  const affiliateLinks = normalizeAffiliateLinks(company);
  const amazonLink = company.amazon_url || company.amazon_store_url || "";

  const websiteUrl =
    company.website_url ||
    (company.normalized_domain ? `https://${company.normalized_domain}` : "");

  const websiteLabel =
    company.company_name && websiteUrl
      ? company.company_name
      : websiteUrl.replace(/^https?:\/\//, "");


  const truncateText = (text, length = 60) => {
    if (!text) return "—";
    return text.length > length ? text.substring(0, length) + "…" : text;
  };

  const DISTANCE_COLOR = "hsl(187, 47%, 32%)";

  const formatDistance = (dist, unitLabel) => {
    return typeof dist === "number" ? `${dist.toFixed(1)} ${unitLabel}` : "—";
  };

  const formatLocationDisplayName = (loc) => {
    if (typeof loc === "string") {
      const s = loc.trim();
      return s ? s : "—";
    }

    if (!loc || typeof loc !== "object") return "—";

    const formatted = typeof loc.formatted === "string" ? loc.formatted.trim() : "";
    if (formatted) return formatted;

    const address =
      (typeof loc.full_address === "string" && loc.full_address.trim()) ||
      (typeof loc.address === "string" && loc.address.trim()) ||
      "";
    if (address) return address;

    const parts = [];
    if (typeof loc.city === "string" && loc.city.trim()) parts.push(loc.city.trim());
    if (typeof loc.state === "string" && loc.state.trim()) parts.push(loc.state.trim());
    if (typeof loc.country === "string" && loc.country.trim()) parts.push(loc.country.trim());

    return parts.length > 0 ? parts.join(", ") : "—";
  };

  const getLocationsList = (locations, geocodes, distances = [], isManu = false) => {
    if (isManu && Array.isArray(distances) && distances.length > 0) {
      return distances.slice(0, 5).map((loc) => ({
        formatted: formatLocationDisplayName(loc),
        distance: typeof loc?.dist === "number" ? loc.dist : null,
        geocode_status: typeof loc?.geocode_status === "string" ? loc.geocode_status : null,
      }));
    }

    const sourceArray =
      Array.isArray(geocodes) && geocodes.length > 0
        ? geocodes
        : Array.isArray(locations) && locations.length > 0
          ? locations
          : [];

    return sourceArray.slice(0, 5).map((loc) => ({
      formatted: formatLocationDisplayName(loc),
      distance: null,
      geocode_status: loc && typeof loc === "object" && typeof loc.geocode_status === "string" ? loc.geocode_status : null,
    }));
  };

  const manuLocations = getLocationsList(
    company.manufacturing_locations,
    company.manufacturing_geocodes,
    company._manuDists || [],
    true
  );

  const hqLocations = Array.isArray(company._hqDists) && company._hqDists.length > 0
    ? company._hqDists.slice(0, 5).map((hq) => ({
        formatted: formatLocationDisplayName(hq),
        distance: typeof hq.dist === "number" ? hq.dist : null,
        geocode_status: typeof hq?.geocode_status === "string" ? hq.geocode_status : null,
      }))
    : Array.isArray(company.headquarters) && company.headquarters.length > 0
      ? company.headquarters.slice(0, 5).map((hq) => ({
          formatted: formatLocationDisplayName(hq),
          distance: null,
          geocode_status: typeof hq?.geocode_status === "string" ? hq.geocode_status : null,
        }))
      : typeof company.headquarters_location === "string" && company.headquarters_location.trim()
        ? [{ formatted: company.headquarters_location.trim(), distance: null, geocode_status: null }]
        : [];

  const hqLocation = hqLocations;

  const getReviewsPreviews = () => {
    if (!company._reviews) return [];
    return company._reviews.slice(0, 3);
  };

  const normalizeReview = (r) => {
    if (!r || typeof r !== "object") return null;
    const sourceName = (r.source_name || r.source || "").toString().trim();
    const sourceUrl = (r.source_url || r.url || "").toString().trim();
    const text = (r.text || r.abstract || r.excerpt || "").toString().trim();

    return {
      sourceName: sourceName || "Unknown Source",
      sourceUrl: sourceUrl || "",
      text,
    };
  };

  const renderRightColumn = (colKey) => {
    if (colKey === "manu") {
      return (
        <div className="space-y-2">
          {manuLocations.map((loc, idx) => (
            <div key={idx} className="text-sm flex items-start gap-1">
              {loc.formatted !== "—" && (
                <div className="text-xs font-semibold whitespace-nowrap pt-0.5" style={{ color: DISTANCE_COLOR }}>
                  {typeof loc.distance === "number" ? formatDistance(loc.distance, unit) : "Distance unavailable"}
                </div>
              )}
              <div className="text-gray-900">{loc.formatted}</div>
            </div>
          ))}
          {manuLocations.length === 0 && <div className="text-sm text-gray-500">—</div>}
        </div>
      );
    }

    if (colKey === "hq") {
      return (
        <div className="space-y-2">
          {hqLocation.map((loc, idx) => (
            <div key={idx} className="text-sm flex items-start gap-1">
              {loc.formatted !== "—" && (
                <div className="text-xs font-semibold whitespace-nowrap pt-0.5" style={{ color: DISTANCE_COLOR }}>
                  {typeof loc.distance === "number" ? formatDistance(loc.distance, unit) : "Distance unavailable"}
                </div>
              )}
              <div className="text-gray-900">{loc.formatted}</div>
            </div>
          ))}
          {hqLocation.length === 0 && <div className="text-sm text-gray-500">—</div>}
        </div>
      );
    }

    if (colKey === "manu-expanded") {
      return (
        <div className="space-y-2">
          {manuLocations.map((loc, idx) => (
            <div key={idx} className="text-sm flex items-start gap-1">
              {loc.formatted !== "—" && (
                <div className="text-xs font-semibold whitespace-nowrap pt-0.5" style={{ color: DISTANCE_COLOR }}>
                  {typeof loc.distance === "number" ? formatDistance(loc.distance, unit) : "Distance unavailable"}
                </div>
              )}
              <div className="text-gray-900">{loc.formatted}</div>
            </div>
          ))}
          {manuLocations.length === 0 && <div className="text-sm text-gray-500">—</div>}
        </div>
      );
    }

    if (colKey === "stars") {
      const showReviewPreview = !isExpanded;
      const reviews = showReviewPreview
        ? getReviewsPreviews().map(normalizeReview).filter(Boolean)
        : [];
      const filled = getQQFilledCount(company);
      const iconType = getQQDefaultIconType(company);

      return (
        <div className="space-y-2">
          <div className="flex items-center">
            {iconType === "heart" ? (
              <RatingHearts value={filled} size={18} />
            ) : (
              <RatingDots value={filled} size={18} />
            )}
          </div>

          {showReviewPreview && (
            <>
              <div className="text-xs font-semibold text-gray-700">Reviews</div>

              {reviews.length > 0 ? (
                <div className="space-y-2">
                  {reviews.map((r, idx) => (
                    <div key={idx} className="text-xs text-gray-600">
                      <div className="line-clamp-2">{r.text || "—"}</div>
                      {r.sourceUrl ? (
                        <a
                          href={withAmazonAffiliate(r.sourceUrl)}
                          target="_blank"
                          rel="noreferrer"
                          className="text-blue-600 hover:underline"
                          onClick={(e) => e.stopPropagation()}
                          title={withAmazonAffiliate(r.sourceUrl)}
                        >
                          Source: {r.sourceName}
                        </a>
                      ) : (
                        <div className="text-gray-500">Source: {r.sourceName}</div>
                      )}
                    </div>
                  ))}
                </div>
              ) : typeof company.reviews_count === "number" && company.reviews_count > 0 ? (
                <div className="text-xs text-gray-500">
                  {company.reviews_count} review{company.reviews_count === 1 ? "" : "s"} available
                </div>
              ) : (
                <div className="text-xs text-gray-400">No reviews available</div>
              )}
            </>
          )}
        </div>
      );
    }

    return null;
  };

  const handleRowClick = () => {
    setIsExpanded(!isExpanded);
  };

  const handleExpandedClick = (e) => {
    if (e.target.closest("a, button")) return;
    setIsExpanded(false);
  };

  if (isExpanded) {
    return (
      <div
        onClick={handleExpandedClick}
        className="border-2 rounded-lg mb-4 p-6 bg-white cursor-pointer"
        style={{ borderColor: "#B1DDE3", borderWidth: "2px" }}
      >
        <div className="grid grid-cols-5 gap-4 mb-6 pb-6 border-b">
          <div className="col-span-2">
            <h2 className="font-bold text-lg text-gray-900">
              {websiteUrl ? (
                <a
                  href={withAmazonAffiliate(websiteUrl)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-blue-700 hover:underline"
                >
                  {websiteLabel}
                </a>
              ) : (
                <span className="text-gray-900">{company.company_name}</span>
              )}
            </h2>
            {company.tagline && (
              <div className="text-sm text-gray-600 mt-1">{company.tagline}</div>
            )}

            {(affiliateLinks.length > 0 || amazonLink) && (
              <div className="mt-3 space-y-1">
                {affiliateLinks.map((link, idx) => (
                  <div key={link.url || idx} className="text-sm">
                    <a
                      href={withAmazonAffiliate(link.url)}
                      target="_blank"
                      rel="noreferrer"
                      className="text-blue-600 hover:underline"
                      onClick={(e) => e.stopPropagation()}
                    >
                      {inferAffiliateLabel(link, `Affiliate ${idx + 1}`)}
                    </a>
                  </div>
                ))}
                {amazonLink && (
                  <div className="text-sm">
                    <a
                      href={withAmazonAffiliate(amazonLink)}
                      target="_blank"
                      rel="noreferrer"
                      className="text-blue-600 hover:underline"
                      onClick={(e) => e.stopPropagation()}
                    >
                      Amazon
                    </a>
                  </div>
                )}
              </div>
            )}

            <div className="text-sm font-semibold text-gray-700 mt-3">Industries</div>
            <div className="text-sm text-gray-600 mt-1 flex flex-wrap gap-1">
              {Array.isArray(company.industries) &&
                company.industries.map((ind, idx) => (
                  <button
                    key={idx}
                    onClick={(e) => {
                      e.stopPropagation();
                      onKeywordSearch(ind);
                    }}
                    className="text-blue-600 hover:underline"
                  >
                    {ind}
                    {idx < company.industries.length - 1 && ","}
                  </button>
                ))}
            </div>
          </div>

          <div>
            {company.logo_url ? (
              <img
                src={company.logo_url}
                alt={company.company_name}
                className="w-full h-24 object-contain mb-3"
                onError={(e) => {
                  e.target.style.display = "none";
                }}
              />
            ) : (
              <div className="w-full h-24 mb-3 bg-gray-100 rounded flex items-center justify-center text-gray-700 font-bold text-2xl">
                {company.company_name
                  .split(" ")
                  .map((w) => w[0])
                  .join("")
                  .substring(0, 2)
                  .toUpperCase()}
              </div>
            )}
            <div className="text-sm font-semibold text-gray-700">Keywords</div>
            <div className="text-sm text-gray-600 mt-1 flex flex-wrap gap-1">
              {Array.isArray(company.keywords) && company.keywords.length > 0
                ? company.keywords.map((kw, idx) => (
                    <button
                      key={idx}
                      onClick={(e) => {
                        e.stopPropagation();
                        onKeywordSearch(kw);
                      }}
                      className="text-blue-600 hover:underline text-xs"
                    >
                      {kw}
                    </button>
                  ))
                : String(company.product_keywords || "")
                    .split(",")
                    .map((kw) => kw.trim())
                    .filter(Boolean)
                    .map((kw, idx) => (
                      <button
                        key={idx}
                        onClick={(e) => {
                          e.stopPropagation();
                          onKeywordSearch(kw);
                        }}
                        className="text-blue-600 hover:underline text-xs"
                      >
                        {kw}
                      </button>
                    ))}
            </div>
          </div>

          {rightColsOrder.map((colKey) => (
            <div key={colKey}>
              <div className="text-sm font-semibold text-gray-700 mb-2">
                {colKey === "manu" ? "Manufacturing" : colKey === "hq" ? "Home/HQ" : "QQ"}
              </div>
              {renderRightColumn(colKey)}
            </div>
          ))}
        </div>

        <div className="mt-6 col-span-5">
          <ReviewsWidget companyId={company.id || company.company_id} companyName={company.company_name} />
        </div>

        <div className="text-xs text-gray-500 mt-4 text-center">Click anywhere to collapse</div>
      </div>
    );
  }

  return (
    <div
      onClick={handleRowClick}
      className="grid grid-cols-12 lg:grid-cols-[minmax(0,_2fr)_minmax(0,_2fr)_minmax(0,_2.6667fr)_minmax(0,_2.6667fr)_minmax(0,_2.6667fr)] gap-3 border rounded-lg p-2 bg-white hover:bg-gray-50 cursor-pointer mb-3 transition-colors"
      style={{ borderColor: "#649BA0" }}
    >
      <div className="col-span-4 lg:col-span-1">
        <h2 className="font-bold text-gray-900">
          {websiteUrl ? (
            <a
              href={withAmazonAffiliate(websiteUrl)}
              target="_blank"
              rel="noopener noreferrer"
              className="font-semibold text-sm text-blue-700 hover:underline"
            >
              {websiteLabel}
            </a>
          ) : (
            <span className="font-semibold text-sm">{company.company_name}</span>
          )}
        </h2>
        {company.tagline && (
          <div className="text-xs text-gray-600 mt-1">{company.tagline}</div>
        )}

        {(affiliateLinks.length > 0 || amazonLink) && (
          <div className="mt-2 space-y-0.5 text-xs">
            {affiliateLinks.map((link, idx) => (
              <div key={link.url || idx} className="truncate">
                <span className="font-semibold text-gray-700 mr-1">Aff.</span>
                <span className="text-blue-600 hover:underline">
                  {inferAffiliateLabel(link, `Affiliate ${idx + 1}`)}
                </span>
              </div>
            ))}
            {amazonLink && (
              <div className="truncate">
                <span className="font-semibold text-gray-700 mr-1">Aff.</span>
                <span className="text-blue-600 hover:underline">Amazon</span>
              </div>
            )}
          </div>
        )}

        <div className="text-xs font-semibold text-gray-700 mt-2">Industries</div>
        <div className="flex flex-wrap gap-1 mt-1">
          {Array.isArray(company.industries) &&
            company.industries.slice(0, 3).map((ind, idx) => (
              <button
                key={idx}
                onClick={(e) => {
                  e.stopPropagation();
                  onKeywordSearch(ind);
                }}
                className="text-xs text-blue-600 hover:underline"
              >
                {ind}
              </button>
            ))}
          {company.industries?.length > 3 && (
            <span className="text-xs text-gray-500">+{company.industries.length - 3}</span>
          )}
        </div>
      </div>

      <div className="col-span-2 lg:col-span-1">
        {company.logo_url ? (
          <img
            src={company.logo_url}
            alt={company.company_name}
            className="w-full h-20 object-contain mb-2"
            onError={(e) => {
              e.target.style.display = "none";
            }}
          />
        ) : (
          <div className="w-full h-20 mb-2 bg-gray-100 rounded flex items-center justify-center text-gray-700 font-bold text-lg">
            {company.company_name
              .split(" ")
              .map((w) => w[0])
              .join("")
              .substring(0, 2)
              .toUpperCase()}
          </div>
        )}
        <div className="text-xs font-semibold text-gray-700">Keywords</div>
        <div className="flex flex-wrap gap-1 mt-1">
          {Array.isArray(company.keywords) && company.keywords.length > 0
            ? company.keywords.slice(0, 4).map((kw, idx) => (
                <button
                  key={idx}
                  onClick={(e) => {
                    e.stopPropagation();
                    onKeywordSearch(kw);
                  }}
                  className="text-xs text-blue-600 hover:underline bg-gray-100 px-1 py-0.5 rounded"
                >
                  {kw}
                </button>
              ))
            : String(company.product_keywords || "")
                .split(",")
                .map((kw) => kw.trim())
                .filter(Boolean)
                .slice(0, 4)
                .map((kw, idx) => (
                  <button
                    key={idx}
                    onClick={(e) => {
                      e.stopPropagation();
                      onKeywordSearch(kw);
                    }}
                    className="text-xs text-blue-600 hover:underline bg-gray-100 px-1 py-0.5 rounded"
                  >
                    {kw}
                  </button>
                ))}
        </div>
      </div>

      {rightColsOrder.map((colKey, colIdx) => (
        <div key={colKey} className="col-span-2 lg:col-span-1">
          <div className="text-xs font-semibold text-gray-700 flex items-center gap-1 mb-2">
            {colKey === "manu" ? "Manufacturing" : colKey === "hq" ? "Home/HQ" : "QQ"}
          </div>
          {renderRightColumn(colKey)}
        </div>
      ))}

      {/* Location Sources Section */}
      {company.show_location_sources_to_users && Array.isArray(company.location_sources) && company.location_sources.length > 0 && (
        <div className="col-span-12 lg:col-span-5 border-t pt-4 mt-4">
          <div className="text-xs font-semibold text-gray-700 mb-3">📍 Location Sources</div>
          <div className="grid grid-cols-2 gap-3 text-xs">
            {company.location_sources.map((source, idx) => (
              <div key={idx} className="border rounded p-2 bg-gray-50">
                <div className="font-medium text-gray-700">{source.location}</div>
                <div className="text-gray-600 text-xs mt-1">
                  Type: <span className="font-medium capitalize">{source.location_type}</span>
                </div>
                {source.source_url && (
                  <div className="mt-2">
                    <a
                      href={withAmazonAffiliate(source.source_url)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-blue-600 hover:underline text-xs"
                      onClick={(e) => e.stopPropagation()}
                    >
                      View source ({source.source_type})
                    </a>
                  </div>
                )}
                {!source.source_url && (
                  <div className="text-gray-500 text-xs mt-2">Source: {source.source_type}</div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
