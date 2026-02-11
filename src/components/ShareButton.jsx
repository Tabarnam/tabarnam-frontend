import React, { useState } from "react";
import { Copy } from "lucide-react";
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

  const companyName = getCompanyDisplayName(company) || "this company";
  const tagline = (company?.tagline || "").trim();
  const hqLocation = (company?.headquarters_location || "").trim();
  const companyUrl = `${window.location.origin}/results?q=${encodeURIComponent(companyName)}`;

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
        className={`inline-flex items-center justify-center w-11 h-11 min-w-[44px] min-h-[44px] rounded-full hover:bg-accent transition-colors focus:outline-none focus:ring-2 focus:ring-[#3F97A2] focus:ring-offset-1 ${className}`}
        aria-label={`Share ${companyName} details`}
        title="Share this company"
      >
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="#3F97A2"
          xmlns="http://www.w3.org/2000/svg"
          aria-hidden="true"
        >
          <path d="M13.47 2.47a.75.75 0 0 1 1.06 0l4 4a.75.75 0 0 1 0 1.06l-4 4a.75.75 0 1 1-1.06-1.06l2.72-2.72H12c-2.35 0-4.3.8-5.64 2.2C5.02 11.31 4.25 13.3 4.25 15.5v2.25a.75.75 0 0 1-1.5 0V15.5c0-2.55.88-4.94 2.52-6.65C6.9 7.15 9.2 6.25 12 6.25h4.19l-2.72-2.72a.75.75 0 0 1 0-1.06Z" />
        </svg>
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
                type="text"
                readOnly
                value={shareFullText}
                className="flex-1 rounded-md border border-input px-3 py-2 text-sm bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-[#3F97A2]"
                onFocus={(e) => e.target.select()}
                onClick={(e) => e.stopPropagation()}
              />
              <button
                type="button"
                onClick={handleCopy}
                className="inline-flex items-center justify-center gap-1.5 rounded-md bg-[#3F97A2] px-3 py-2 text-sm font-medium text-white hover:bg-[#4e8388] transition-colors focus:outline-none focus:ring-2 focus:ring-[#3F97A2] focus:ring-offset-1"
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
                className="inline-flex items-center gap-2 rounded-md border border-border px-4 py-2 text-sm font-medium text-foreground hover:bg-accent transition-colors"
              >
                Share on X
              </a>
              <a
                href={facebookUrl}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => e.stopPropagation()}
                className="inline-flex items-center gap-2 rounded-md border border-border px-4 py-2 text-sm font-medium text-foreground hover:bg-accent transition-colors"
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
