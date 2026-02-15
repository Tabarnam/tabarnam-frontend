import React, { useState } from "react";
import { Check, Copy, Share } from "lucide-react";
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
  const [copied, setCopied] = useState(false);

  const companyName = getCompanyDisplayName(company) || "this company";
  const companyUrl = `${window.location.origin}/results?q=${encodeURIComponent(companyName)}`;

  const handleShare = async (e) => {
    e.preventDefault();
    e.stopPropagation();

    const ok = await copyToClipboard(companyUrl);
    if (ok) {
      setCopied(true);
      toast.success({ title: "Link copied!", description: companyUrl });
      setTimeout(() => setCopied(false), 2000);
    } else {
      // Fallback: show modal with manual copy field
      setModalOpen(true);
    }
  };

  const handleModalCopy = async (e) => {
    e.stopPropagation();
    const ok = await copyToClipboard(companyUrl);
    if (ok) {
      setCopied(true);
      toast.success({ title: "Link copied!", description: companyUrl });
      setTimeout(() => {
        setCopied(false);
        setModalOpen(false);
      }, 1500);
    } else {
      toast.error("Failed to copy — please copy manually from the field above");
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={handleShare}
        className={`inline-flex items-center justify-center w-11 h-11 min-w-[44px] min-h-[44px] rounded-full hover:bg-accent transition-colors focus:outline-none focus:ring-2 focus:ring-[#3F97A2] focus:ring-offset-1 ${className}`}
        aria-label={`Copy link for ${companyName}`}
        title="Copy share link"
      >
        {copied ? (
          <Check className="w-[18px] h-[18px] text-green-600" aria-hidden="true" />
        ) : (
          <Share className="w-[18px] h-[18px] text-[#3F97A2]" aria-hidden="true" />
        )}
      </button>

      <Dialog open={modalOpen} onOpenChange={setModalOpen}>
        <DialogContent
          className="sm:max-w-md"
          onClick={(e) => e.stopPropagation()}
        >
          <DialogHeader>
            <DialogTitle>Share this company</DialogTitle>
            <DialogDescription>
              Copy the link below to share.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 mt-2">
            <div className="flex items-center gap-2">
              <input
                type="text"
                readOnly
                value={companyUrl}
                className="flex-1 rounded-md border border-input px-3 py-2 text-sm bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-[#3F97A2]"
                onFocus={(e) => e.target.select()}
                onClick={(e) => e.stopPropagation()}
              />
              <button
                type="button"
                onClick={handleModalCopy}
                className="inline-flex items-center justify-center gap-1.5 rounded-md bg-[#3F97A2] px-3 py-2 text-sm font-medium text-white hover:bg-[#4e8388] transition-colors focus:outline-none focus:ring-2 focus:ring-[#3F97A2] focus:ring-offset-1"
                aria-label="Copy link"
              >
                {copied ? (
                  <>
                    <Check className="w-4 h-4" />
                    Copied
                  </>
                ) : (
                  <>
                    <Copy className="w-4 h-4" />
                    Copy
                  </>
                )}
              </button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
