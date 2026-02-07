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

const SHARE_COLOR = "hsl(187, 47%, 45%)";

function ShareIcon({ size = 20, className = "" }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={SHARE_COLOR}
      strokeWidth={2.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      {/* Arrow pointing up */}
      <line x1="12" y1="3" x2="12" y2="15" />
      <polyline points="7 8 12 3 17 8" />
      {/* Box open at top */}
      <path d="M20 11v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-8" />
    </svg>
  );
}

async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const el = document.createElement("textarea");
      el.value = text;
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

function buildShareText(company) {
  const name =
    company.display_name?.trim() ||
    company.company_name?.trim() ||
    company.name?.trim() ||
    "";
  const parts = [name];
  if (company.tagline) parts.push(company.tagline);
  if (company.headquarters_location) parts.push(`HQ: ${company.headquarters_location}`);
  const url =
    company.website_url ||
    (company.normalized_domain ? `https://${company.normalized_domain}` : "");
  if (url) parts.push(url);
  return parts.filter(Boolean).join("\n");
}

function getCompanyName(company) {
  return (
    company.display_name?.trim() ||
    company.company_name?.trim() ||
    company.name?.trim() ||
    "this company"
  );
}

export default function ShareButton({ company, variant = "default", className = "" }) {
  const [modalOpen, setModalOpen] = useState(false);

  const companyName = getCompanyName(company);
  const shareText = buildShareText(company);
  const shareUrl =
    company.website_url ||
    (company.normalized_domain ? `https://${company.normalized_domain}` : window.location.href);

  async function handleClick(e) {
    e.stopPropagation();
    e.preventDefault();

    if (navigator.share) {
      try {
        await navigator.share({
          title: companyName,
          text: shareText,
          url: shareUrl,
        });
        return;
      } catch (err) {
        if (err.name === "AbortError") return;
      }
    }

    setModalOpen(true);
  }

  async function handleCopy(e) {
    e.stopPropagation();
    const ok = await copyToClipboard(shareText);
    if (ok) {
      toast({ title: "Copied", description: "Company details copied to clipboard." });
    } else {
      toast.error("Copy failed");
    }
  }

  const twitterUrl = `https://x.com/intent/tweet?text=${encodeURIComponent(shareText)}`;
  const facebookUrl = `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(shareUrl)}`;

  return (
    <>
      <button
        type="button"
        onClick={handleClick}
        className={`inline-flex items-center justify-center rounded-md transition-opacity hover:opacity-70 ${className}`}
        style={{ minWidth: 44, minHeight: 44 }}
        aria-label={`Share ${companyName} details`}
        title="Share this company"
      >
        <ShareIcon size={variant === "card" ? 18 : 20} />
      </button>

      <Dialog open={modalOpen} onOpenChange={setModalOpen}>
        <DialogContent className="sm:max-w-md" onClick={(e) => e.stopPropagation()}>
          <DialogHeader>
            <DialogTitle>Share {companyName}</DialogTitle>
            <DialogDescription>
              Copy the details below or share on social media.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="flex items-center gap-2">
              <input
                readOnly
                value={shareText}
                className="flex-1 rounded-md border border-gray-300 bg-gray-50 px-3 py-2 text-sm text-gray-700"
                onClick={(e) => {
                  e.stopPropagation();
                  e.target.select();
                }}
              />
              <button
                type="button"
                onClick={handleCopy}
                className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-gray-300 bg-white text-gray-600 hover:bg-gray-50 transition-colors"
                aria-label="Copy to clipboard"
              >
                <Copy className="h-4 w-4" />
              </button>
            </div>

            <div className="flex gap-3">
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
