import React from 'react';
import { motion } from 'framer-motion';
import { Building2, Globe, Tag } from 'lucide-react';
import { RatingDots, RatingHearts } from "@/components/Stars";
import { withAmazonAffiliate } from "@/lib/amazonAffiliate";
import { getCompanyDisplayName } from "@/lib/companyDisplayName";
import { getQQDefaultIconType, getQQFilledCount, getQQScore, hasQQRating } from "@/lib/stars/qqRating";

const CompanyCard = ({ company, index }) => {
  const cardVariants = {
    hidden: { opacity: 0, y: 50 },
    visible: { opacity: 1, y: 0, transition: { delay: index * 0.1 } },
  };

  const displayName = getCompanyDisplayName(company);

  const primaryUrl = company.website_url || company.amazon_url || company.amazon_store_url || "";
  const primaryLabel = company.website_url ? "Visit Website" : primaryUrl ? "View on Amazon" : "Visit Website";

  return (
    <motion.div
      variants={cardVariants}
      initial="hidden"
      animate="visible"
      whileHover={{ y: -5, scale: 1.02,
        boxShadow: "0px 15px 30px -5px rgba(148, 106, 226, 0.3)" 
      }}
      className="bg-white/10 backdrop-blur-lg rounded-2xl p-6 border border-white/20 hover:border-purple-400 transition-all duration-300 flex flex-col justify-between h-full"
    >
      <div>
        <div className="flex items-center gap-4 mb-4">
          <div className="p-3 bg-gradient-to-r from-purple-500 to-pink-500 rounded-xl">
            <Building2 className="w-6 h-6 text-white" />
          </div>
          <h2 className="text-xl font-bold text-white truncate">{displayName}</h2>
        </div>

        <p className="text-gray-300 text-sm mb-4 line-clamp-3 min-h-[60px]">{company.about || 'No description available.'}</p>
        
        {company.industries && company.industries.length > 0 && (
          <div className="flex items-center gap-2 mb-4">
            <Tag className="w-4 h-4 text-purple-400" />
            <div className="flex flex-wrap gap-2">
              {company.industries.slice(0, 3).map((industry, i) => (
                <span key={i} className="bg-purple-500/20 text-purple-300 text-xs font-medium px-2.5 py-1 rounded-full">
                  {industry}
                </span>
              ))}
            </div>
          </div>
        )}

        <div className="flex items-center gap-2 mb-4 text-sm text-gray-400">
          {hasQQRating(company) ? (
            <>
              {getQQDefaultIconType(company) === "heart" ? (
                <RatingHearts value={getQQFilledCount(company)} size={14} />
              ) : (
                <RatingDots value={getQQScore(company)} size={14} />
              )}
              <span className="text-[#649BA0]">{getQQScore(company).toFixed(1)}/5.0</span>
            </>
          ) : (
            <span>No rating</span>
          )}
        </div>
      </div>

      <div>
        <a
          href={primaryUrl ? withAmazonAffiliate(primaryUrl) : "#"}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => !primaryUrl && e.preventDefault()}
          className={`flex items-center justify-center gap-2 w-full text-center px-4 py-2 rounded-lg font-semibold transition-all duration-300 ${primaryUrl ? 'bg-gradient-to-r from-purple-500 to-pink-500 hover:from-purple-600 hover:to-pink-600 text-white' : 'bg-gray-600 text-gray-400 cursor-not-allowed'}`}
        >
          <Globe className="w-4 h-4" />
          {primaryLabel}
        </a>
      </div>
    </motion.div>
  );
};

export default CompanyCard;
