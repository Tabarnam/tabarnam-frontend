import React, { useState, useRef } from "react";
import { Share2, Copy } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { toast } from "@/lib/toast";
import { getCompanyDisplayName } from "@/lib/companyDisplayName";

async function copyToClipboard(text) {
  const value = (text || "").toString();
  if (!value.trim()) return false;
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    try {
      const el = document.createElement("textarea");
      el.value = value;
      el.setAttribute("readonly", "");
      el.style.position = "absolute";
      el.style.left = "-9999px";
      document.body.appendChild(el);
      el.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(el);
      return ok;
    } catch {
      return false;
    }
  }
}

export default function ShareButton({ company, className = "" }) {
  const [modalOpen, setModalOpen] = useState(false);
  const inputRef = useRef(null);

  const companyName = getCompanyDisplayName(company) || "this company";
  const tagline = (company?.tagline || "").trim();
  const hqLocation = (company?.headquarters_location || "").trim();
  const companyUrl = company?.website_url || window.location.href;

  const shareTitle = `Check out ${companyName} on Tabarnam`;
  const shareText = [tagline, hqLocation ? `HQ in ${hqLocation}.` : ""]
    .filter(Boolean)
    .join(". ");
  const shareFullText = `${shareTitle}: ${shareText} More at ${companyUrl}`;

  const handleShare = async (e) => {
    e.preventDefault();
    e.stopPropagation();

    if (navigator.share) {
      try {
        await navigator.share({
          title: shareTitle,
          text: shareText,
          url: companyUrl,
        });
      } catch (error) {
        if (error.name !== "AbortError") {
          console.error("Share failed:", error);
        }
      }
    } else {
      setModalOpen(true);
    }
  };

  const handleCopy = async (e) => {
    e.stopPropagation();
    const ok = await copyToClipboard(shareFullText);
    if (ok) {
      toast.success({ title: "Copied!", description: "Share text copied to clipboard." });
    } else {
      toast.error("Failed to copy");
    }
  };

  const twitterUrl = `https://twitter.com/intent/tweet?text=${encodeURIComponent(
    `Check out ${companyName}: ${shareText}`
  )}&url=${encodeURIComponent(companyUrl)}`;

  const facebookUrl = `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(
    companyUrl
  )}`;

  return (
    <>
      <button
        type="button"
        onClick={handleShare}
        className={`inline-flex items-center justify-center w-11 h-11 min-w-[44px] min-h-[44px] rounded-full text-gray-500 hover:text-[#649BA0] hover:bg-gray-100 transition-colors focus:outline-none focus:ring-2 focus:ring-[#649BA0] focus:ring-offset-1 ${className}`}
        aria-label={`Share ${companyName} details`}
        title="Share this company"
      >
        <Share2 className="w-4 h-4" />
      </button>

      <Dialog open={modalOpen} onOpenChange={setModalOpen}>
        <DialogContent
          className="sm:max-w-md"
          onClick={(e) => e.stopPropagation()}
        >
          <DialogHeader>
            <DialogTitle>Share this company</DialogTitle>
            <DialogDescription>
              Copy the link below or share on social media.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 mt-2">
            <div className="flex items-center gap-2">
              <input
                ref={inputRef}
                type="text"
                readOnly
                value={shareFullText}
                className="flex-1 rounded-md border border-gray-300 px-3 py-2 text-sm bg-gray-50 text-gray-800 focus:outline-none focus:ring-2 focus:ring-[#649BA0]"
                onFocus={(e) => e.target.select()}
                onClick={(e) => e.stopPropagation()}
              />
              <button
                type="button"
                onClick={handleCopy}
                className="inline-flex items-center justify-center gap-1.5 rounded-md bg-[#649BA0] px-3 py-2 text-sm font-medium text-white hover:bg-[#4e8388] transition-colors focus:outline-none focus:ring-2 focus:ring-[#649BA0] focus:ring-offset-1"
                aria-label="Copy share text"
              >
                <Copy className="w-4 h-4" />
                Copy
              </button>
            </div>

            <div className="flex items-center gap-3">
              <a
                href={twitterUrl}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => e.stopPropagation()}
                className="inline-flex items-center gap-2 rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors"
              >
                Share on X
              </a>
              <a
                href={facebookUrl}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => e.stopPropagation()}
                className="inline-flex items-center gap-2 rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors"
              >
                Share on Facebook
              </a>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
