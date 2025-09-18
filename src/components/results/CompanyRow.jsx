import React, { useMemo, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Copy, MapPin, Factory, Tag, FileText, Star as LucideStar } from "lucide-react";
import { useToast } from "@/components/ui/use-toast";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { calculateDistance, formatDistance } from "@/lib/location";
import { cn } from "@/lib/utils";
import useTranslation from "@/hooks/useTranslation";
import { CompanyStarsBlock } from "@/components/Results/CompanyStarsBlock";
import { calcStars } from "@/lib/stars/calcStars";
import { LogoUploadDialog } from "@/components/admin/LogoUploadDialog";

const TranslatedText = ({ originalText, translation, loading }) => {
  if (loading)
    return (
      <span className="inline-flex items-center">
        <span className="h-4 w-4 animate-spin border-2 border-slate-300 border-t-transparent rounded-full mr-1" />
      </span>
    );
  return translation || originalText;
};

const Keyword = ({ text, onKeywordSearch, language, viewTranslated }) => {
  const { translatedText, loading } = useTranslation(text, language, viewTranslated);
  const displayText = viewTranslated ? translatedText : text;

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            onClick={(e) => {
              e.stopPropagation();
              onKeywordSearch(text);
            }}
            className="bg-gray-100 text-gray-700 text-xs font-medium px-2.5 py-1 rounded-full hover:bg-gray-200 transition-colors truncate"
          >
            {loading && viewTranslated ? (
              <span className="h-3 w-3 animate-spin border-2 border-slate-300 border-t-transparent rounded-full inline-block mr-1" />
            ) : null}
            {displayText}
          </button>
        </TooltipTrigger>
        <TooltipContent className="bg-gray-800 border-gray-700 text-white">
          <p>Search for "{text}"</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
};

function renderDistance(loc, userLocation) {
  if (!loc || !userLocation || !userLocation.latitude || !loc.latitude || !loc.longitude) return null;
  const d = calculateDistance(userLocation.latitude, userLocation.longitude, loc.latitude, loc.longitude);
  return formatDistance(d, userLocation.country);
}

const CompanyRow = ({
  company,
  userLocation,
  isExpanded,
  onToggle,
  onKeywordSearch,
  language,
  viewTranslated,
  dynamicOrder = ["star_rating", "hq_distance", "mfg_distance"],
  isAdmin = false,
}) => {
  const { toast } = useToast();

  const { translatedText: translatedName, loading: nameLoading } = useTranslation(
    company.name,
    language,
    viewTranslated,
    company.id,
    "name"
  );
  const { translatedText: translatedTagline, loading: taglineLoading } = useTranslation(
    company.tagline,
    language,
    viewTranslated,
    company.id,
    "tagline"
  );
  const { translatedText: translatedNotes, loading: notesLoading } = useTranslation(
    company.notes,
    language,
    viewTranslated,
    company.id,
    "notes"
  );

  const [logoUrl, setLogoUrl] = useState(company.logo_url || "");
  const [showLogoDialog, setShowLogoDialog] = useState(false);

  const hqs = company.headquarters || [];
  const mfgs = company.manufacturing_sites || [];
  const hq1 = hqs[0],
    hq2 = hqs[1];
  const mfg1 = mfgs[0],
    mfg2 = mfgs[1];

  const starBundle = useMemo(
    () =>
      calcStars({
        hqEligible: !!(hqs && hqs.length),
        manufacturingEligible: !!(mfgs && mfgs.length),
        approvedUserReviews: company.review_count_approved || 0,
        approvedEditorialReviews: company.editorial_review_count || 0,
        overrides: company.star_overrides ?? null,
        manualExtra: company.admin_manual_extra ?? 0,
        notes: company.star_notes ?? [],
      }),
    [company, hqs, mfgs]
  );

  const copyToClipboard = (text) => {
    navigator.clipboard.writeText(text);
    toast({ title: "Copied!", description: "Link copied to clipboard." });
  };

  return (
    <>
      <tr
        onClick={onToggle}
        className={cn(
          "cursor-pointer transition-colors",
          isExpanded ? "bg-[#B1DDE3] border-2 border-[#3A7D8A] rounded-lg" : "hover:bg-gray-50"
        )}
      >
        {/* Company column */}
        <td className="p-4 align-top">
          <p className="font-bold text-lg text-gray-800 truncate">
            <TranslatedText
              originalText={company.name}
              translation={translatedName}
              loading={nameLoading && viewTranslated}
            />
          </p>
        </td>

        {/* Logo column with admin Add button if missing */}
        <td className="p-4 align-top">
          {logoUrl ? (
            <img
              src={logoUrl}
              alt={`${company.name || "Company"} logo`}
              className="w-16 h-16 md:w-20 md:h-20 rounded-md object-contain bg-gray-100"
              loading="lazy"
              decoding="async"
              onClick={(e) => e.stopPropagation()}
            />
          ) : (
            <div className="w-16 h-16 md:w-20 md:h-20 rounded-md bg-gray-100 flex items-center justify-center text-xs text-gray-400 relative">
              No logo
              {isAdmin && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setShowLogoDialog(true);
                  }}
                  className="absolute -bottom-2 left-1/2 -translate-x-1/2 rounded-md bg-white border border-slate-300 px-2 py-0.5 text-[11px] text-slate-700 shadow-sm hover:bg-slate-50"
                  title="Add logo"
                >
                  Add logo
                </button>
              )}
            </div>
          )}
        </td>

        {/* Dynamic columns */}
        {dynamicOrder.map((colKey) => {
          if (colKey === "star_rating") {
            return (
              <td key={colKey} className="p-4 align-top text-right">
                <CompanyStarsBlock company={{ ...company, logo_url: logoUrl }} />
              </td>
            );
          } else if (colKey === "hq_distance") {
            return (
              <td key={colKey} className="p-4 align-top">
                {hq1 ? (
                  <div className="text-sm">
                    <div className="flex items-start gap-2">
                      <MapPin size={16} className="text-gray-500 mt-0.5" />
                      <div>
                        <div className="text-gray-800">
                          {hq1.city}
                          {hq1.state ? `, ${hq1.state}` : hq1.country ? `, ${hq1.country}` : ""}
                        </div>
                        <div className="text-xs text-gray-500 mt-0.5">{renderDistance(hq1, userLocation)}</div>
                      </div>
                    </div>
                  </div>
                ) : (
                  <span className="text-gray-400 text-sm">N/A</span>
                )}
              </td>
            );
          } else if (colKey === "mfg_distance") {
            return (
              <td key={colKey} className="p-4 align-top">
                {mfg1 ? (
                  <div className="text-sm">
                    <div className="flex items-start gap-2">
                      <Factory size={16} className="text-gray-500 mt-0.5" />
                      <div>
                        <div className="text-gray-800">
                          {mfg1.city}
                          {mfg1.state ? `, ${mfg1.state}` : mfg1.country ? `, ${mfg1.country}` : ""}
                        </div>
                        <div className="text-xs text-gray-500 mt-0.5">{renderDistance(mfg1, userLocation)}</div>
                      </div>
                    </div>
                  </div>
                ) : (
                  <span className="text-gray-400 text-sm">N/A</span>
                )}
              </td>
            );
          }
          return (
            <td key={colKey} className="p-4 align-top" />
          );
        })}
      </tr>

      {/* Expanded grid */}
      <AnimatePresence>
        {isExpanded && (
          <motion.tr
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.25 }}
            className="bg-transparent"
            onClick={(e) => e.stopPropagation()}
          >
            <td colSpan={5} className="px-4 pb-4">
              <div className="grid grid-cols-[minmax(0,_2fr)_96px_minmax(0,_1fr)_minmax(0,_1fr)_minmax(0,_1fr)] gap-x-6 gap-y-2">
                {/* Row 1 */}
                <div className="col-[1] row-[1] font-semibold text-gray-900 text-base">
                  <TranslatedText
                    originalText={company.name}
                    translation={translatedName}
                    loading={nameLoading && viewTranslated}
                  />
                </div>
                <div className="col-[2] row-[1]/row-[span_3] flex items-start">
                  {logoUrl ? (
                    <img
                      src={logoUrl}
                      alt={`${company.name || "Company"} logo`}
                      className="w-20 h-20 rounded-md object-contain bg-gray-100"
                      loading="lazy"
                    />
                  ) : (
                    <div className="w-20 h-20 rounded-md bg-gray-100 flex items-center justify-center text-xs text-gray-400 relative">
                      No logo
                      {isAdmin && (
                        <button
                          onClick={() => setShowLogoDialog(true)}
                          className="absolute -bottom-2 left-1/2 -translate-x-1/2 rounded-md bg-white border border-slate-300 px-2 py-0.5 text-[11px] text-slate-700 shadow-sm hover:bg-slate-50"
                        >
                          Add logo
                        </button>
                      )}
                    </div>
                  )}
                </div>
                <div className="col-[3] row-[1]">
                  {hq1 ? (
                    <div className="text-sm">
                      <div className="font-medium">Home/HQ 1</div>
                      <div>
                        {hq1.full_address ||
                          `${hq1.city || ""}${hq1.state ? ", " + hq1.state : ""}${hq1.country ? ", " + hq1.country : ""}`}
                      </div>
                    </div>
                  ) : (
                    <span className="text-gray-400 text-sm">N/A</span>
                  )}
                </div>
                <div className="col-[4] row-[1]">
                  {mfg1 ? (
                    <div className="text-sm">
                      <div className="font-medium">Manufacturing 1</div>
                      <div>
                        {mfg1.full_address ||
                          `${mfg1.city || ""}${mfg1.state ? ", " + mfg1.state : ""}${mfg1.country ? ", " + mfg1.country : ""}`}
                      </div>
                    </div>
                  ) : (
                    <span className="text-gray-400 text-sm">N/A</span>
                  )}
                </div>
                <div className="col-[5] row-[1]"></div>

                {/* Row 2 */}
                <div className="col-[1] row-[2]">
                  {company.website_url && (
                    <div className="flex items-center gap-2 text-sm text-blue-600">
                      <a
                        href={company.website_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="hover:underline truncate"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {company.website_url}
                      </a>
                      <TooltipProvider>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                copyToClipboard(company.website_url);
                              }}
                              className="text-xs text-gray-500 underline"
                            >
                              Copy
                            </button>
                          </TooltipTrigger>
                          <TooltipContent>Copy full URL</TooltipContent>
                        </Tooltip>
                      </TooltipProvider>
                    </div>
                  )}
                </div>
                <div className="col-[2] row-[2]"></div>
                <div className="col-[3] row-[2]">
                  {hq1 && <div className="text-xs text-gray-500">{renderDistance(hq1, userLocation)}</div>}
                </div>
                <div className="col-[4] row-[2]">
                  {mfg1 && <div className="text-xs text-gray-500">{renderDistance(mfg1, userLocation)}</div>}
                </div>
                <div className="col-[5] row-[2] flex justify-end">
                  <CompanyStarsBlock company={{ ...company, logo_url: logoUrl }} />
                </div>

                {/* Row 3 */}
                <div className="col-[1] row-[3]">
                  {company.amazon_store_url && (
                    <div className="flex items-center gap-2 text-sm">
                      <TooltipProvider>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <a
                              href={company.amazon_store_url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-blue-600 hover:underline"
                              onClick={(e) => e.stopPropagation()}
                            >
                              Amazon Store
                            </a>
                          </TooltipTrigger>
                          <TooltipContent className="max-w-xs break-words">
                            {company.amazon_store_url}
                          </TooltipContent>
                        </Tooltip>
                      </TooltipProvider>
                      <button
                        className="text-xs text-gray-500 underline"
                        onClick={(e) => {
                          e.stopPropagation();
                          copyToClipboard(company.amazon_store_url);
                        }}
                      >
                        Copy
                      </button>
                    </div>
                  )}
                </div>
                <div className="col-[2] row-[3]"></div>
                <div className="col-[3] row-[3]">
                  {hq2 ? (
                    <div className="text-sm">
                      <div className="font-medium">Home/HQ 2</div>
                      <div>
                        {hq2.full_address ||
                          `${hq2.city || ""}${hq2.state ? ", " + hq2.state : ""}${hq2.country ? ", " + hq2.country : ""}`}
                      </div>
                    </div>
                  ) : null}
                </div>
                <div className="col-[4] row-[3]">
                  {mfg2 ? (
                    <div className="text-sm">
                      <div className="font-medium">Manufacturing 2</div>
                      <div>
                        {mfg2.full_address ||
                          `${mfg2.city || ""}${mfg2.state ? ", " + mfg2.state : ""}${mfg2.country ? ", " + mfg2.country : ""}`}
                      </div>
                    </div>
                  ) : null}
                </div>
                <div className="col-[5] row-[3]"></div>

                {/* Row 4 */}
                <div className="col-[1]/col-[span_2] row-[4]">
                  {(viewTranslated ? translatedTagline : company.tagline) && (
                    <div className="text-sm text-gray-700">
                      <TranslatedText
                        originalText={company.tagline}
                        translation={translatedTagline}
                        loading={taglineLoading && viewTranslated}
                      />
                    </div>
                  )}
                  {(viewTranslated ? translatedNotes : company.notes) && (
                    <div className="text-sm text-gray-600 whitespace-pre-wrap mt-1">
                      <TranslatedText
                        originalText={company.notes}
                        translation={translatedNotes}
                        loading={notesLoading && viewTranslated}
                      />
                    </div>
                  )}
                </div>
                <div className="col-[3] row-[4]">
                  {hq2 && <div className="text-xs text-gray-500">{renderDistance(hq2, userLocation)}</div>}
                  {hqs.length > 2 && (
                    <TooltipProvider>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <button className="text-xs text-blue-600 underline mt-1">More…</button>
                        </TooltipTrigger>
                        <TooltipContent className="max-w-sm">
                          <ul className="text-xs text-gray-800 space-y-1">
                            {hqs.slice(2).map((loc, i) => (
                              <li key={i}>
                                {loc.full_address ||
                                  `${loc.city || ""}${loc.state ? ", " + loc.state : ""}${loc.country ? ", " + loc.country : ""}`}
                              </li>
                            ))}
                          </ul>
                        </TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                  )}
                </div>
                <div className="col-[4] row-[4]">
                  {mfg2 && <div className="text-xs text-gray-500">{renderDistance(mfg2, userLocation)}</div>}
                  {mfgs.length > 2 && (
                    <TooltipProvider>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <button className="text-xs text-blue-600 underline mt-1">More…</button>
                        </TooltipTrigger>
                        <TooltipContent className="max-w-sm">
                          <ul className="text-xs text-gray-800 space-y-1">
                            {mfgs.slice(2).map((loc, i) => (
                              <li key={i}>
                                {loc.full_address ||
                                  `${loc.city || ""}${loc.state ? ", " + loc.state : ""}${loc.country ? ", " + loc.country : ""}`}
                              </li>
                            ))}
                          </ul>
                        </TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                  )}
                </div>
                <div className="col-[5] row-[4]"></div>
              </div>
            </td>
          </motion.tr>
        )}
      </AnimatePresence>

      {showLogoDialog && (
        <LogoUploadDialog
          companyId={company.id}
          onClose={() => setShowLogoDialog(false)}
          onSaved={(newUrl) => setLogoUrl(newUrl)}
        />
      )}
    </>
  );
};

export default CompanyRow;
