// src/components/ReviewFormDialog.jsx
//
// Community review submission. Reuses the Contact Us dialog pattern
// (react-hook-form + honeypot + sonner toast) but posts to /submit-review.
// The review is stored pending until an admin approves it in the Review Queue.
//
// Controlled by the parent via `open` / `onOpenChange` so the trigger button
// can live next to the "Features & Reviews" header.
//
// Note: there is intentionally NO numeric score field. The company score is
// derived from the review TEXT (not an averaged star), so a score input would
// mislead reviewers into thinking their number moves the score.

import React, { useState, useRef } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { Loader2, ImagePlus, X } from "lucide-react";

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { apiFetch } from "@/lib/api";
import { compressImageToDataUrl } from "@/lib/compressImage";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_TEXT = 10;
const MAX_IMAGES = 3;
const DEFAULT_SOURCE = "Tabarnam Transparency Advocate";

export default function ReviewFormDialog({ open, onOpenChange, companyId, companyName, displayName }) {
  const {
    register,
    handleSubmit,
    watch,
    reset,
    formState: { errors, isSubmitting },
  } = useForm({
    defaultValues: {
      subject: "",
      name: "",
      email: "",
      show_email: false,
      source_name: DEFAULT_SOURCE,
      text: "",
      hp_field: "",
    },
  });

  // The min-length warning is shown only after the user leaves the Review field
  // (blur) with the requirement unmet — not while they're still typing.
  const [reviewTouched, setReviewTouched] = useState(false);

  // Attached photos (client-compressed data URLs, max 3). Kept outside RHF.
  const [images, setImages] = useState([]);
  const [imgBusy, setImgBusy] = useState(false);
  const fileRef = useRef(null);

  const textLen = String(watch("text") || "").trim().length;
  const showTooShort = reviewTouched && textLen < MIN_TEXT;

  const titleName = String(displayName || companyName || "").trim();

  const removeImage = (idx) => setImages((prev) => prev.filter((_, i) => i !== idx));

  const onPickFiles = async (e) => {
    const files = Array.from(e.target.files || []);
    e.target.value = "";
    if (!files.length) return;

    const room = MAX_IMAGES - images.length;
    if (room <= 0) {
      toast.error(`You can add up to ${MAX_IMAGES} photos.`);
      return;
    }
    if (files.length > room) toast.error(`Only ${MAX_IMAGES} photos allowed — extra ones were skipped.`);

    setImgBusy(true);
    try {
      const added = [];
      for (const f of files.slice(0, room)) {
        if (f.size > 15 * 1024 * 1024) {
          toast.error(`"${f.name}" is too large (max 15 MB).`);
          continue;
        }
        const url = await compressImageToDataUrl(f);
        if (url) added.push(url);
        else toast.error(`Couldn't process "${f.name}".`);
      }
      if (added.length) setImages((prev) => [...prev, ...added].slice(0, MAX_IMAGES));
    } finally {
      setImgBusy(false);
    }
  };

  const closeAndReset = () => {
    reset();
    setReviewTouched(false);
    setImages([]);
    onOpenChange?.(false);
  };

  const onSubmit = async (data) => {
    // Honeypot is NOT dropped client-side — we forward its value so the server
    // can FLAG (store pending) rather than silently discard, so a real user
    // whose field got autofilled never loses their review.
    const hasEmail = Boolean(data.email && data.email.trim());

    try {
      const r = await apiFetch("/submit-review", {
        method: "POST",
        body: {
          company_id: companyId || undefined,
          company_name: companyName,
          subject: data.subject?.trim() || undefined,
          source_name: data.source_name?.trim() || undefined,
          text: data.text.trim(),
          user_name: data.name?.trim() || null,
          user_email: hasEmail ? data.email.trim() : null,
          show_email: hasEmail ? Boolean(data.show_email) : false,
          images: images.length ? images : undefined,
          hp_field: data.hp_field || undefined,
        },
      });
      const result = await r.json().catch(() => ({}));

      if (r.ok && result.ok) {
        toast.success(
          hasEmail
            ? "Thanks! Your review was submitted and is pending approval. Check your email for a confirmation."
            : "Thanks! Your review was submitted and is pending approval."
        );
        closeAndReset();
      } else {
        toast.error(result.error || "Something went wrong. Please try again.");
      }
    } catch {
      toast.error("Something went wrong. Please try again.");
    }
  };

  // Fired when the user hits Submit but client-side validation fails.
  const onInvalid = (formErrors) => {
    const msg =
      formErrors?.text?.message ||
      formErrors?.email?.message ||
      "Please fix the highlighted fields before submitting.";
    toast.error(msg);
  };

  const textReg = register("text", {
    required: "Please write a review",
    minLength: { value: MIN_TEXT, message: `Review must be at least ${MIN_TEXT} characters` },
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-lg"
        aria-describedby={undefined}
        // Don't discard an in-progress review on an accidental outside click.
        onInteractOutside={(e) => e.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>{titleName ? `Review ${titleName}` : "Submit a review"}</DialogTitle>
        </DialogHeader>

        <form onSubmit={handleSubmit(onSubmit, onInvalid)} className="grid gap-4">
          {/* Honeypot - hidden from real users. readOnly-until-focus blocks
              autofill from writing to it; a fill-everything bot sets .value and
              still trips it (flagged, not dropped). */}
          <input
            {...register("hp_field")}
            type="text"
            readOnly
            onFocus={(e) => e.currentTarget.removeAttribute("readonly")}
            tabIndex={-1}
            autoComplete="off"
            aria-hidden="true"
            data-lpignore="true"
            data-1p-ignore="true"
            data-form-type="other"
            style={{ position: "absolute", left: "-9999px", opacity: 0, height: 0, width: 0 }}
          />

          <div className="grid gap-2">
            <Label htmlFor="review-subject">Subject</Label>
            <Input id="review-subject" {...register("subject")} />
          </div>

          <div className="grid gap-2">
            <div className="flex items-baseline gap-2 flex-wrap">
              <Label htmlFor="review-name">Name</Label>
              <span className="text-xs text-muted-foreground">Optional. Shown to the Tabarnam community.</span>
            </div>
            <Input id="review-name" {...register("name")} />
          </div>

          <div className="grid gap-2">
            <div className="flex items-baseline gap-2 flex-wrap">
              <Label htmlFor="review-email">Email</Label>
              <span className="text-xs text-muted-foreground">Private by default. Add to be emailed review status.</span>
            </div>
            <Input
              id="review-email"
              type="email"
              {...register("email", {
                validate: (v) => !v || EMAIL_RE.test(v) || "Please enter a valid email address",
              })}
            />
            {errors.email && <p className="text-sm text-destructive">{errors.email.message}</p>}
            <label htmlFor="review-show-email" className="mt-1 flex items-center gap-2 text-sm text-muted-foreground">
              <input
                id="review-show-email"
                type="checkbox"
                className="h-4 w-4 rounded border-border accent-primary"
                {...register("show_email")}
              />
              Show my email address to Tabarnam community.
            </label>
          </div>

          <div className="grid gap-2">
            <Label htmlFor="review-source-name">Who are you in relation to this company?</Label>
            <p className="text-xs text-muted-foreground">
              Describe your relationship (e.g. customer, employee, founder)
            </p>
            <Input id="review-source-name" {...register("source_name")} />
          </div>

          <div className="grid gap-2">
            <div className="flex items-baseline gap-2 flex-wrap">
              <Label htmlFor="review-text">
                Review <span className="text-destructive">*</span>
              </Label>
              <span className="text-xs text-muted-foreground">Impacts company score.</span>
            </div>
            <Textarea
              id="review-text"
              rows={5}
              {...textReg}
              onBlur={(e) => {
                textReg.onBlur(e);
                setReviewTouched(true);
              }}
            />
            {showTooShort && (
              <p className="text-xs text-destructive">
                At least {MIN_TEXT} characters needed ({textLen}/{MIN_TEXT}).
              </p>
            )}
          </div>

          <div className="grid gap-2">
            <div className="flex items-baseline gap-2 flex-wrap">
              <Label>Photos</Label>
              <span className="text-xs text-muted-foreground">Optional. Up to {MAX_IMAGES}.</span>
            </div>
            {images.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {images.map((src, idx) => (
                  <div key={idx} className="relative h-16 w-20">
                    <img src={src} alt={`Attachment ${idx + 1}`} className="h-16 w-20 rounded border border-border object-cover" />
                    <button
                      type="button"
                      onClick={() => removeImage(idx)}
                      aria-label="Remove photo"
                      className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-slate-800 text-white hover:bg-slate-700"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </div>
                ))}
              </div>
            )}
            {images.length < MAX_IMAGES && (
              <div>
                <input ref={fileRef} type="file" accept="image/*" multiple className="hidden" onChange={onPickFiles} />
                <button
                  type="button"
                  onClick={() => fileRef.current?.click()}
                  disabled={imgBusy}
                  className="inline-flex items-center gap-1.5 rounded-md border border-border bg-transparent px-3 py-1.5 text-sm font-medium text-foreground hover:bg-foreground/5 transition-colors disabled:opacity-60"
                >
                  {imgBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ImagePlus className="h-4 w-4" />}
                  Add photo
                </button>
              </div>
            )}
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={closeAndReset} disabled={isSubmitting}>
              Cancel
            </Button>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Submitting...
                </>
              ) : (
                "Submit Review"
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
