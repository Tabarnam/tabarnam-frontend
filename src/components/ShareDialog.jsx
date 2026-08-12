import React, { useState } from "react";
import { Check, Copy } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { toast } from "@/lib/toast";
import { buildShareTargets, copyToClipboard } from "@/lib/share";

/**
 * Fallback share sheet for browsers without Web Share (desktop Firefox), and
 * for the rare case where the OS sheet fails to open. Everywhere else the
 * native sheet is used instead — see canNativeShare in @/lib/share. Payload is
 * fully controlled by the caller so it can be computed at click time (bookmark
 * lists encode their companies into the URL asynchronously).
 */
export default function ShareDialog({
  open,
  onOpenChange,
  dialogTitle = "Share",
  shareTitle = "",
  shareMessage = "",
  shareUrl = "",
}) {
  const [copied, setCopied] = useState(false);

  const shareFullText = `${shareMessage} More at ${shareUrl}`;
  const targets = buildShareTargets({
    title: shareTitle,
    message: shareMessage,
    url: shareUrl,
  });

  const handleCopy = async (e, value, description) => {
    e.stopPropagation();
    const ok = await copyToClipboard(value);
    if (ok) {
      setCopied(true);
      toast.success({ title: "Copied!", description });
      setTimeout(() => setCopied(false), 2000);
    } else {
      toast.error("Failed to copy");
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md" onClick={(e) => e.stopPropagation()}>
        <DialogHeader>
          <DialogTitle>{dialogTitle}</DialogTitle>
          <DialogDescription>
            Copy the link below or share it straight to an app.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 mt-2">
          <div className="flex items-center gap-2">
            <input
              type="text"
              readOnly
              value={shareUrl}
              aria-label="Share link"
              className="flex-1 min-w-0 rounded-md border border-input px-3 py-2 text-sm bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-[#3F97A2]"
              onFocus={(e) => e.target.select()}
              onClick={(e) => e.stopPropagation()}
            />
            <button
              type="button"
              onClick={(e) => handleCopy(e, shareUrl, "Link copied to clipboard.")}
              className="shrink-0 inline-flex items-center justify-center gap-1.5 rounded-md bg-[#3F97A2] px-3 py-2 text-sm font-medium text-white hover:bg-[#4e8388] transition-colors focus:outline-none focus:ring-2 focus:ring-[#3F97A2] focus:ring-offset-1"
              aria-label="Copy share link"
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

          <div className="grid grid-cols-2 gap-2">
            {targets.map((t) => (
              <a
                key={t.name}
                href={t.href}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => e.stopPropagation()}
                style={{ backgroundColor: t.color }}
                className="inline-flex items-center justify-center rounded-md px-3 py-2 text-sm font-medium text-white hover:opacity-90 transition-opacity focus:outline-none focus:ring-2 focus:ring-[#3F97A2] focus:ring-offset-1"
              >
                {t.name}
              </a>
            ))}
          </div>

          <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
            {/* Instagram has no web share intent — there is no URL that opens a
                composer — so copy-and-paste is the only honest desktop path. */}
            <span>Instagram: copy the link and paste it into a story or bio.</span>
            <button
              type="button"
              onClick={(e) =>
                handleCopy(e, shareFullText, "Message and link copied to clipboard.")
              }
              className="shrink-0 underline underline-offset-2 hover:text-foreground transition-colors focus:outline-none focus:ring-2 focus:ring-[#3F97A2] rounded"
            >
              Copy with description
            </button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
