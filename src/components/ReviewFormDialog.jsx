// src/components/ReviewFormDialog.jsx
//
// Community review submission. Reuses the Contact Us dialog pattern
// (react-hook-form + honeypot + sonner toast) but posts to /submit-review.
// The review is stored pending until an admin approves it in the Review Queue.
//
// Controlled by the parent (ReviewsWidget) via `open` / `onOpenChange` so the
// trigger button can live next to the "Features & Reviews" header.

import React from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { RatingDots } from "@/components/Stars";
import { apiFetch } from "@/lib/api";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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
      rating: "",
      text: "",
      source_name: "Tabarnam Transparency Advocate",
      name: "",
      email: "",
      show_email: false,
      hp_field: "",
    },
  });

  const ratingWatch = watch("rating");
  const ratingPreview = (() => {
    const n = Number(ratingWatch);
    return Number.isFinite(n) && ratingWatch !== "" ? Math.max(0, Math.min(5, n)) : null;
  })();

  const MIN_TEXT = 10;
  const textLen = String(watch("text") || "").trim().length;
  const emailFilled = Boolean(String(watch("email") || "").trim());

  const titleName = String(displayName || companyName || "").trim();

  const onSubmit = async (data) => {
    // Honeypot — bots fill this hidden field. Named neutrally (not "phone"/
    // "email"/"name") so browser autofill won't populate it for real users.
    if (data.hp_field) {
      onOpenChange?.(false);
      return;
    }

    const hasEmail = Boolean(data.email && data.email.trim());
    const ratingStr = String(data.rating ?? "").trim();

    try {
      const r = await apiFetch("/submit-review", {
        method: "POST",
        body: {
          company_id: companyId || undefined,
          company_name: companyName,
          subject: data.subject?.trim() || undefined,
          source_name: data.source_name?.trim() || undefined,
          rating: ratingStr === "" ? null : Number(ratingStr),
          text: data.text.trim(),
          user_name: data.name?.trim() || null,
          user_email: hasEmail ? data.email.trim() : null,
          show_email: hasEmail ? Boolean(data.show_email) : false,
        },
      });
      const result = await r.json().catch(() => ({}));

      if (r.ok && result.ok) {
        toast.success(
          hasEmail
            ? "Thanks! Your review was submitted and is pending approval. Check your email for a confirmation."
            : "Thanks! Your review was submitted and is pending approval."
        );
        reset();
        onOpenChange?.(false);
      } else {
        toast.error(result.error || "Something went wrong. Please try again.");
      }
    } catch {
      toast.error("Something went wrong. Please try again.");
    }
  };

  // Fired when the user hits Submit but client-side validation fails (e.g. the
  // review is too short). Surface a toast so the reason isn't easy to miss.
  const onInvalid = (formErrors) => {
    const msg =
      formErrors?.text?.message ||
      formErrors?.rating?.message ||
      formErrors?.email?.message ||
      "Please fix the highlighted fields before submitting.";
    toast.error(msg);
  };

  const handleCancel = () => {
    reset();
    onOpenChange?.(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-lg"
        // Don't discard an in-progress review on an accidental outside click.
        // Dismissal is intentional only: the Cancel button, or the X.
        onInteractOutside={(e) => e.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>{titleName ? `Review ${titleName}` : "Submit a review"}</DialogTitle>
          <DialogDescription>
            Share your experience. Submissions are reviewed by our team before they appear.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit(onSubmit, onInvalid)} className="grid gap-4">
          {/* Honeypot - hidden from real users. Neutral name + ignore hints so
              browser/password-manager autofill leaves it empty (a filled value
              means a bot). */}
          <input
            {...register("hp_field")}
            type="text"
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
            <Input id="review-subject" placeholder="A short headline (optional)" {...register("subject")} />
          </div>

          <div className="grid gap-2">
            <Label htmlFor="review-rating">Score (optional)</Label>
            <div className="flex items-center gap-3">
              <Input
                id="review-rating"
                type="number"
                inputMode="decimal"
                min={0}
                max={5}
                step={0.1}
                placeholder="0–5"
                className="w-28"
                {...register("rating", {
                  validate: (v) =>
                    v === "" ||
                    v == null ||
                    (Number.isFinite(Number(v)) && Number(v) >= 0 && Number(v) <= 5) ||
                    "Score must be a number between 0 and 5",
                })}
              />
              {ratingPreview != null && (
                <div className="flex items-center gap-2">
                  <RatingDots value={ratingPreview} size={16} />
                  <span className="text-sm text-muted-foreground">{ratingPreview}/5</span>
                </div>
              )}
            </div>
            {errors.rating && <p className="text-sm text-destructive">{errors.rating.message}</p>}
            <p className="text-xs text-muted-foreground">Any number 0–5, tenths allowed (e.g. 4.3).</p>
          </div>

          <div className="grid gap-2">
            <Label htmlFor="review-text">
              Review <span className="text-destructive">*</span>
            </Label>
            <Textarea
              id="review-text"
              placeholder="What was your experience?"
              rows={5}
              {...register("text", {
                required: "Please write a review",
                minLength: { value: MIN_TEXT, message: `Review must be at least ${MIN_TEXT} characters` },
              })}
            />
            <p className={`text-xs ${textLen > 0 && textLen < MIN_TEXT ? "text-destructive" : "text-muted-foreground"}`}>
              {textLen < MIN_TEXT
                ? `At least ${MIN_TEXT} characters needed (${textLen}/${MIN_TEXT}).`
                : `${textLen} characters`}
            </p>
          </div>

          <div className="grid gap-2">
            <Label htmlFor="review-source-name">Source name</Label>
            <Input id="review-source-name" placeholder="Tabarnam Transparency Advocate" {...register("source_name")} />
            <p className="text-xs text-muted-foreground">
              How your review is credited. Defaults to “Tabarnam Transparency Advocate” — change it if you'd like.
            </p>
          </div>

          <div className="grid gap-2">
            <Label htmlFor="review-name">Name</Label>
            <Input id="review-name" placeholder="Your name (optional)" {...register("name")} />
            <p className="text-xs text-muted-foreground">
              Optional. The name you provide will be shown to the Tabarnam community.
            </p>
          </div>

          <div className="grid gap-2">
            <Label htmlFor="review-email">Email</Label>
            <Input
              id="review-email"
              type="email"
              placeholder="you@example.com (optional — for updates on your review)"
              {...register("email", {
                validate: (v) => !v || EMAIL_RE.test(v) || "Please enter a valid email address",
              })}
            />
            {errors.email && <p className="text-sm text-destructive">{errors.email.message}</p>}
            {emailFilled && (
              <label htmlFor="review-show-email" className="mt-1 flex items-center gap-2 text-sm text-muted-foreground">
                <input
                  id="review-show-email"
                  type="checkbox"
                  className="h-4 w-4 rounded border-border accent-primary"
                  {...register("show_email")}
                />
                Show my email address to Tabarnam community.
              </label>
            )}
            <p className="text-xs text-muted-foreground">
              Your email is private by default and only used to update you on your review.
            </p>
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={handleCancel} disabled={isSubmitting}>
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
