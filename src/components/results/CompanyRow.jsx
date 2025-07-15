import React, { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Copy, Star, MapPin, Factory, Tag, FileText, ChevronDown, Globe, Loader2 } from 'lucide-react';
import { useToast } from '@/components/ui/use-toast';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { calculateDistance, formatDistance } from '@/lib/location';
import { cn } from '@/lib/utils';
import useTranslation from '@/hooks/useTranslation';

// Small component for translated text with loading state
const TranslatedText = ({ originalText, translation, loading }) => {
    if (loading) {
        return <Loader2 className="h-4 w-4 animate-spin text-gray-400" />
    }
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
                        onClick={(e) => { e.stopPropagation(); onKeywordSearch(text); }} 
                        className="bg-gray-100 text-gray-700 text-xs font-medium px-2.5 py-1 rounded-full hover:bg-gray-200 transition-colors truncate"
                    >
                         {loading && viewTranslated ? <Loader2 className="h-3 w-3 animate-spin inline-block mr-1" /> : ''}
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

const CompanyRow = ({ company, userLocation, isExpanded, onToggle, onKeywordSearch, language, viewTranslated }) => {
    const { toast } = useToast();

    // Use translation hook for relevant fields
    const { translatedText: translatedName, loading: nameLoading } = useTranslation(company.name, language, viewTranslated, company.id, 'name');
    const { translatedText: translatedTagline, loading: taglineLoading } = useTranslation(company.tagline, language, viewTranslated, company.id, 'tagline');
    const { translatedText: translatedStarExplanation, loading: starExplanationLoading } = useTranslation(company.star_explanation, language, viewTranslated, company.id, 'star_explanation');
    const { translatedText: translatedNotes, loading: notesLoading } = useTranslation(company.notes, language, viewTranslated, company.id, 'notes');

    const copyToClipboard = (text) => {
        navigator.clipboard.writeText(text);
        toast({ title: "Copied!", description: "Website URL copied to clipboard." });
    };

    const getClosestLocation = (locations) => {
        if (!locations || locations.length === 0 || !userLocation || !userLocation.latitude) return null;
        
        return locations.reduce((closest, loc) => {
            if (!loc || !loc.latitude || !loc.longitude) return closest;
            const distance = calculateDistance(userLocation.latitude, userLocation.longitude, loc.latitude, loc.longitude);
            if (distance < closest.distance) {
                return { ...loc, distance };
            }
            return closest;
        }, { distance: Infinity });
    };
    
    const closestHq = getClosestLocation(company.headquarters);
    const closestMfg = getClosestLocation(company.manufacturing_sites);

    const renderLocationDesktop = (loc) => {
        if (!loc || loc.distance === Infinity) return <span className="text-gray-400">N/A</span>;
        
        const formattedDist = formatDistance(loc.distance, userLocation.country);

        return (
            <div className="flex items-center gap-2">
                <MapPin size={16} className="text-gray-400" />
                <div>
                    <p className="text-gray-800">{loc.city}, {loc.state || loc.country}</p>
                    {formattedDist && <p className="text-xs text-gray-500">{formattedDist}</p>}
                </div>
            </div>
        );
    };

    const renderStars = () => {
        const rating = company.star_rating;
        // Strict rule: Only render stars if rating is 4 or higher.
        if (!rating || rating < 4) {
            return null;
        }

        const explanation = viewTranslated ? translatedStarExplanation : company.star_explanation;
        const isLoading = viewTranslated && starExplanationLoading;

        return (
             <TooltipProvider>
                <Tooltip>
                    <TooltipTrigger asChild>
                        <div className="flex items-center gap-1">
                            {Array.from({ length: 5 }, (_, i) => (
                                <Star
                                    key={i}
                                    className={cn(
                                        "w-4 h-4 text-tabarnam-blue transition-colors",
                                        i < Math.floor(rating) ? 'fill-tabarnam-blue' : 'fill-none stroke-current'
                                    )}
                                    style={{height: '1em', width: '1em'}}
                                />
                            ))}
                        </div>
                    </TooltipTrigger>
                    {explanation && (
                        <TooltipContent className="bg-gray-800 border-gray-700 text-white max-w-xs">
                           {isLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <p>{explanation}</p>}
                        </TooltipContent>
                    )}
                </Tooltip>
            </TooltipProvider>
        );
    };

    const allKeywords = [...(company.product_keywords || []), ...(company.industries || [])];
    const uniqueKeywords = Array.from(new Set(allKeywords.map(k => k.keyword || k.name || k))).filter(Boolean);

    return (
        <>
            <tr onClick={onToggle} className={cn("cursor-pointer hover:bg-gray-50 transition-colors", isExpanded && "bg-[#B1DDE3] border-2 border-[#3A7D8A] rounded-lg")}>
                <td colSpan="4" className={cn("p-0", isExpanded ? "rounded-lg" : "")}>
                    <div className="p-4">
                        <div className="grid grid-cols-[minmax(0,_2fr)_minmax(0,_1fr)_minmax(0,_1fr)_max-content] gap-6 items-start">
                            {/* Column 1: Company Info */}
                            <div className="flex items-start gap-4 flex-grow min-w-0">
                                <motion.div whileHover={{ scale: 1.1 }} className="flex-shrink-0">
                                    <a href={company.website_url || '#'} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()}>
                                        <img-replace src={company.logo_url} alt={`${company.name} logo`} className="w-12 h-12 rounded-md object-contain bg-gray-100" />
                                    </a>
                                </motion.div>
                                <div className="flex-grow min-w-0">
                                    <p className="font-bold text-lg text-gray-800 truncate">
                                        <TranslatedText originalText={company.name} translation={translatedName} loading={nameLoading && viewTranslated}/>
                                    </p>
                                    {company.website_url && (
                                        <div className="flex items-center gap-2 text-sm text-blue-600">
                                            <a href={company.website_url} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()} className="hover:underline truncate max-w-[200px]">{company.website_url.replace(/^(https?:\/\/)?(www\.)?/, '')}</a>
                                            <TooltipProvider><Tooltip><TooltipTrigger asChild>
                                                <Copy size={14} className="cursor-pointer text-gray-400 hover:text-gray-800 transition-colors flex-shrink-0" onClick={(e) => { e.stopPropagation(); copyToClipboard(company.website_url); }} />
                                            </TooltipTrigger><TooltipContent><p>Copy URL</p></TooltipContent></Tooltip></TooltipProvider>
                                        </div>
                                    )}
                                    <p className="text-sm text-gray-600 mt-1 truncate">
                                        <TranslatedText originalText={company.tagline} translation={translatedTagline} loading={taglineLoading && viewTranslated}/>
                                    </p>
                                    <div className="flex flex-wrap gap-1.5 mt-2">
                                        {uniqueKeywords.slice(0, 4).map((kw, i) => (
                                            <Keyword key={i} text={kw} onKeywordSearch={onKeywordSearch} language={language} viewTranslated={viewTranslated} />
                                        ))}
                                    </div>
                                </div>
                            </div>
                            
                            {/* Column 2: HQ Location */}
                            <div className="hidden md:flex items-start text-sm">
                                {renderLocationDesktop(closestHq)}
                            </div>
                            
                            {/* Column 3: Mfg Location */}
                            <div className="hidden md:flex items-start text-sm">
                                {renderLocationDesktop(closestMfg)}
                            </div>
                            
                            {/* Column 4: Stars */}
                            <div className="hidden md:flex items-start justify-end">
                                <div className="w-24 text-right">{renderStars()}</div>
                            </div>

                        </div>
                    </div>

                    <AnimatePresence>
                        {isExpanded && (
                            <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.3, ease: "easeInOut" }} className="overflow-hidden">
                                <div className="p-4 pt-0">
                                    <div className="p-4 bg-transparent rounded-lg">
                                        <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-4">
                                            <div className="md:hidden space-y-3">
                                                {closestHq && closestHq.distance !== Infinity && <div className="flex items-center gap-2 text-sm"><MapPin size={16} className="text-gray-500"/> <div><span className="font-semibold">HQ:</span> {closestHq.city}, {closestHq.state} {formatDistance(closestHq.distance, userLocation.country)}</div></div>}
                                                {closestMfg && closestMfg.distance !== Infinity && <div className="flex items-center gap-2 text-sm"><Factory size={16} className="text-gray-500"/> <div><span className="font-semibold">Mfg:</span> {closestMfg.city}, {closestMfg.state} {formatDistance(closestMfg.distance, userLocation.country)}</div></div>}
                                                {company.star_rating >= 4 && <div className="flex items-center gap-2 text-sm"><Star size={16} className="text-gray-500"/> <div><span className="font-semibold">Rating:</span> {renderStars()}</div></div>}
                                            </div>
                                            <div>
                                                <h4 className="font-bold text-gray-800 mb-2 flex items-center gap-2"><Tag size={16} /> Keywords & Industries</h4>
                                                <div className="flex flex-wrap gap-2">
                                                    {uniqueKeywords.map((kw, i) => (
                                                        <Keyword key={i} text={kw} onKeywordSearch={onKeywordSearch} language={language} viewTranslated={viewTranslated} />
                                                    ))}
                                                </div>
                                            </div>
                                            {company.headquarters && company.headquarters.length > 0 && <div>
                                                <h4 className="font-bold text-gray-800 mb-2 flex items-center gap-2"><MapPin size={16} /> All Headquarters</h4>
                                                <ul className="space-y-1 text-sm text-gray-600">{company.headquarters.map((loc, i) => <li key={i}>{loc.full_address}</li>)}</ul>
                                            </div>}
                                            {company.manufacturing_sites && company.manufacturing_sites.length > 0 && <div>
                                                <h4 className="font-bold text-gray-800 mb-2 flex items-center gap-2"><Factory size={16} /> All Manufacturing</h4>
                                                <ul className="space-y-1 text-sm text-gray-600">{company.manufacturing_sites.map((loc, i) => <li key={i}>{loc.full_address}</li>)}</ul>
                                            </div>}
                                            {(viewTranslated ? translatedStarExplanation : company.star_explanation) && (
                                                <div className="md:col-span-2">
                                                    <h4 className="font-bold text-gray-800 mb-2 flex items-center gap-2"><Star size={16} /> Rating Explanation</h4>
                                                    <p className="text-sm text-gray-600"><TranslatedText originalText={company.star_explanation} translation={translatedStarExplanation} loading={starExplanationLoading && viewTranslated} /></p>
                                                </div>
                                            )}
                                            {(viewTranslated ? translatedNotes : company.notes) && (
                                                <div className="md:col-span-2">
                                                    <h4 className="font-bold text-gray-800 mb-2 flex items-center gap-2"><FileText size={16} /> Notes</h4>
                                                    <p className="text-sm text-gray-600 whitespace-pre-wrap"><TranslatedText originalText={company.notes} translation={translatedNotes} loading={notesLoading && viewTranslated} /></p>
                                                </div>
                                            )}
                                        </div>
                                    </div>
                                </div>
                            </motion.div>
                        )}
                    </AnimatePresence>
                </td>
            </tr>
        </>
    );
};

export default CompanyRow;