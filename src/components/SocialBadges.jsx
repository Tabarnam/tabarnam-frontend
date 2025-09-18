// src/components/SocialBadges.jsx
import React from "react";
import { Linkedin, Facebook, Instagram, Twitter, Youtube } from "lucide-react";

// Inline TikTok logo (monochrome, uses currentColor)
function TikTokIcon({ size = 14, style = {}, className = "" }) {
  return (
    <svg
      viewBox="0 0 256 256"
      width={size}
      height={size}
      role="img"
      aria-hidden="true"
      className={className}
      style={style}
    >
      <path
        fill="currentColor"
        d="M196.85 0v48.2a109.33 109.33 0 0 1-63.14-21.5v95.1a74.2 74.2 0 1 1-63.24-73.33v37.5a37 37 0 1 0 26.17 35.4V0zm40.01 67.5a72.45 72.45 0 0 1-32.31-12.72 72.12 72.12 0 0 1-27.35-32.06A72.23 72.23 0 0 1 173.56 0h23.29A109.3 109.3 0 0 0 260 21.5v43.5a72.43 72.43 0 0 1-23.14 2.5z"
      />
    </svg>
  );
}

const BRANDS = {
  linkedin: { label: "LinkedIn", color: "#0A66C2", Icon: Linkedin },
  facebook: { label: "Facebook", color: "#1877F2", Icon: Facebook },
  instagram: { label: "Instagram", color: "#E4405F", Icon: Instagram },
  // Prefer "x" if present; fall back to twitter
  x: { label: "X (Twitter)", color: "#111111", Icon: Twitter },
  twitter: { label: "Twitter", color: "#1DA1F2", Icon: Twitter },
  youtube: { label: "YouTube", color: "#FF0000", Icon: Youtube },
  tiktok: { label: "TikTok", color: "#000000", Icon: TikTokIcon },
};

function normalizeUrl(u) {
  if (typeof u !== "string" || !u.trim()) return "";
  const s = u.trim();
  if (/^https?:\/\//i.test(s)) return s;
  return `https://${s.replace(/^\/+/, "")}`;
}

function BrandButton({ brandKey, href, brandColors, variant }) {
  const b = BRANDS[brandKey];
  if (!b) return null;
  const url = normalizeUrl(href);
  if (!url) return null;

  const isSolid = variant === "solid";
  const base =
    "inline-flex items-center justify-center w-6 h-6 rounded border transition-opacity duration-150 hover:opacity-85";
  let style = {};
  let iconStyle = {};

  if (brandColors) {
    if (isSolid) {
      style = { backgroundColor: b.color, borderColor: b.color, color: "#fff" };
      iconStyle = { color: "#fff" };
    } else {
      // ghost
      style = {
        backgroundColor: "transparent",
        borderColor: b.color,
        color: b.color,
      };
      iconStyle = { color: b.color };
    }
  }

  const Icon = b.Icon;
  return (
    <a
      href={url}
      title={b.label}
      aria-label={b.label}
      target="_blank"
      rel="noopener noreferrer"
      className={base}
      style={style}
    >
      {/* lucide icons use strokes; TikTokIcon is filled but honors currentColor */}
      <Icon size={14} strokeWidth={2} style={iconStyle} />
    </a>
  );
}

export default function SocialBadges({
  links,
  className = "",
  brandColors = false,
  variant = "ghost", // "solid" | "ghost"
}) {
  if (!links || typeof links !== "object") return null;

  // Prefer links.x over links.twitter if both present
  const items = [
    links.linkedin && { key: "linkedin", href: links.linkedin },
    links.facebook && { key: "facebook", href: links.facebook },
    links.instagram && { key: "instagram", href: links.instagram },
    (links.x || links.twitter) && {
      key: links.x ? "x" : "twitter",
      href: links.x || links.twitter,
    },
    links.youtube && { key: "youtube", href: links.youtube },
    links.tiktok && { key: "tiktok", href: links.tiktok },
  ].filter(Boolean);

  if (!items.length) return null;

  return (
    <div className={`flex items-center gap-2 ${className}`}>
      {items.map(({ key, href }) => (
        <BrandButton
          key={key}
          brandKey={key}
          href={href}
          brandColors={brandColors}
          variant={variant}
        />
      ))}
    </div>
  );
}
