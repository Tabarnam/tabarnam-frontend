import React, { useState } from "react";
import { Share } from "lucide-react";
import ShareDialog from "@/components/ShareDialog";
import { buildShareMessage, nativeShare, prefersNativeShare } from "@/lib/share";
import { getCompanyDisplayName } from "@/lib/companyDisplayName";

export default function ShareButton({ company, title: titleProp, text: textProp, url: urlProp, label: labelProp, dialogTitle: dialogTitleProp, className = "" }) {
  const [modalOpen, setModalOpen] = useState(false);

  // Derive share data from company (legacy) or explicit props
  const companyName = company ? (getCompanyDisplayName(company) || "this company") : "";
  let shareTitle, shareText, shareUrl;

  if (titleProp || textProp || urlProp) {
    shareTitle = titleProp || "";
    shareText = textProp || "";
    shareUrl = urlProp || window.location.href;
  } else {
    const tagline = (company?.tagline || "").trim();
    const hqLocation = (company?.headquarters_location || "").trim();
    shareUrl = `${window.location.origin}/share?company=${encodeURIComponent(companyName)}`;
    shareTitle = `Check out ${companyName} on Tabarnam`;
    shareText = [tagline, hqLocation ? `HQ in ${hqLocation}.` : ""]
      .filter(Boolean)
      .join(". ");
  }

  const shareMessage = buildShareMessage(shareTitle, shareText);
  const buttonLabel = labelProp || `Share ${companyName} details`;
  const buttonTitle = dialogTitleProp || (company ? "Share this company" : "Share");

  const handleShare = async (e) => {
    e.preventDefault();
    e.stopPropagation();

    if (prefersNativeShare()) {
      const result = await nativeShare({
        title: shareTitle,
        text: shareMessage,
        url: shareUrl,
      });
      if (result !== "fail") return;
    }
    setModalOpen(true);
  };

  return (
    <>
      <button
        type="button"
        onClick={handleShare}
        className={`inline-flex items-center justify-center w-11 h-11 min-w-[44px] min-h-[44px] rounded-full hover:bg-accent transition-colors focus:outline-none focus:ring-2 focus:ring-[#3F97A2] focus:ring-offset-1 ${className}`}
        aria-label={buttonLabel}
        title={buttonTitle}
      >
        <Share className="w-[18px] h-[18px] text-[#3F97A2]" aria-hidden="true" />
      </button>

      <ShareDialog
        open={modalOpen}
        onOpenChange={setModalOpen}
        dialogTitle={buttonTitle}
        shareTitle={shareTitle}
        shareMessage={shareMessage}
        shareUrl={shareUrl}
      />
    </>
  );
}
