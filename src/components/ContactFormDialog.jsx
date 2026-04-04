// src/components/ContactFormDialog.jsx
import React, { useState } from "react";
import { useForm, Controller } from "react-hook-form";
import { toast } from "sonner";
import { Mail, Loader2, Copy, ExternalLink } from "lucide-react";

import {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { API_BASE, join } from "@/lib/api";

const SUBJECT_OPTIONS = [
  { value: "propose-company", label: "Propose a company" },
  { value: "site-improvement", label: "Site improvement idea" },
  { value: "report-issue", label: "Report an issue / Bug" },
  { value: "general-inquiry", label: "General inquiry" },
  { value: "other", label: "Other" },
];

export default function ContactFormDialog() {
  const [open, setOpen] = useState(false);

  const {
    register,
    handleSubmit,
    control,
    watch,
    reset,
    formState: { errors, isSubmitting },
  } = useForm({
    defaultValues: {
      name: "",
      email: "",
      subject: "",
      customSubject: "",
      message: "",
      _phone: "",
    },
  });


  const selectedSubject = watch("subject");

  const onSubmit = async (data) => {
    try {
      const res = await fetch(join(API_BASE, "contact-send"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });

      const result = await res.json().catch(() => ({}));

      if (res.ok && result.ok) {
        toast.success("Message sent! We'll get back to you soon.");
        reset();
        setOpen(false);
      } else {
        toast.error(
          result.error ||
            "Something went wrong. Please try again or email duh@tabarnam.com directly."
        );
      }
    } catch {
      toast.error(
        "Something went wrong. Please try again or email duh@tabarnam.com directly."
      );
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <button className="fixed top-3 right-3 z-50 bg-card/90 backdrop-blur border border-border rounded-full px-3 py-1.5 shadow flex items-center gap-2 hover:bg-accent transition-colors">
          <Mail size={16} className="text-primary" />
          <span className="text-sm font-medium text-foreground">Contact Us</span>
        </button>
      </DialogTrigger>

      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Contact Us</DialogTitle>
          <DialogDescription>
            We'd love to hear from you. Fill out the form below and we'll get
            back to you as soon as possible.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit(onSubmit)} className="grid gap-4">
          {/* Honeypot - hidden from real users */}
          <input
            {...register("_phone")}
            type="text"
            tabIndex={-1}
            autoComplete="off"
            aria-hidden="true"
            style={{ position: "absolute", left: "-9999px", opacity: 0 }}
          />

          <div className="grid gap-2">
            <Label htmlFor="name">Name</Label>
            <Input
              id="name"
              placeholder="Your name (optional)"
              {...register("name")}
            />
          </div>

          <div className="grid gap-2">
            <Label htmlFor="email">
              Email <span className="text-destructive">*</span>
            </Label>
            <Input
              id="email"
              type="email"
              placeholder="you@example.com"
              {...register("email", {
                required: "Email is required",
                pattern: {
                  value: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
                  message: "Please enter a valid email address",
                },
              })}
            />
            {errors.email && (
              <p className="text-sm text-destructive">{errors.email.message}</p>
            )}
          </div>

          <div className="grid gap-2">
            <Label htmlFor="subject">
              Subject <span className="text-destructive">*</span>
            </Label>
            <Controller
              name="subject"
              control={control}
              rules={{ required: "Please select a subject" }}
              render={({ field }) => (
                <Select
                  value={field.value}
                  onValueChange={field.onChange}
                >
                  <SelectTrigger id="subject">
                    <SelectValue placeholder="Select a reason..." />
                  </SelectTrigger>
                  <SelectContent className="z-[200]">
                    {SUBJECT_OPTIONS.map((opt) => (
                      <SelectItem key={opt.value} value={opt.value}>
                        {opt.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            />
            {errors.subject && (
              <p className="text-sm text-destructive">
                {errors.subject.message}
              </p>
            )}
          </div>

          {selectedSubject === "other" && (
            <div className="grid gap-2">
              <Label htmlFor="customSubject">
                Your subject <span className="text-destructive">*</span>
              </Label>
              <Input
                id="customSubject"
                placeholder="What is this about?"
                {...register("customSubject", {
                  required:
                    selectedSubject === "other"
                      ? "Please enter your subject"
                      : false,
                })}
              />
              {errors.customSubject && (
                <p className="text-sm text-destructive">
                  {errors.customSubject.message}
                </p>
              )}
            </div>
          )}

          <div className="grid gap-2">
            <Label htmlFor="message">
              Message <span className="text-destructive">*</span>
            </Label>
            <Textarea
              id="message"
              placeholder="Tell us more..."
              rows={5}
              {...register("message", {
                required: "Message is required",
                minLength: {
                  value: 10,
                  message: "Message must be at least 10 characters",
                },
              })}
            />
            {errors.message && (
              <p className="text-sm text-destructive">
                {errors.message.message}
              </p>
            )}
          </div>

          <DialogFooter>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Sending...
                </>
              ) : (
                "Send Message"
              )}
            </Button>
          </DialogFooter>
        </form>

        <div className="border-t border-border pt-3 mt-1 text-center text-sm text-muted-foreground">
          <span>You can also email us at{" "}</span>
          <span className="inline-flex items-center gap-1">
            <a
              href="mailto:duh@tabarnam.com"
              className="text-primary hover:underline"
            >
              duh@tabarnam.com
            </a>
            <button
              type="button"
              onClick={() => {
                navigator.clipboard.writeText("duh@tabarnam.com");
                toast.success("Email address copied!");
              }}
              className="inline-flex items-center justify-center rounded p-1 hover:bg-accent transition-colors"
              aria-label="Copy email address"
            >
              <Copy size={14} />
            </button>
            <a
              href="mailto:duh@tabarnam.com"
              className="inline-flex items-center justify-center rounded p-1 hover:bg-accent transition-colors"
              aria-label="Open in email client"
            >
              <ExternalLink size={14} />
            </a>
          </span>
        </div>
      </DialogContent>
    </Dialog>
  );
}
