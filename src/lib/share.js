export async function copyToClipboard(text) {
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

export const canNativeShare = () =>
  typeof navigator !== "undefined" && typeof navigator.share === "function";

// Chromium enabled Web Share on desktop Windows, so `navigator.share` alone no
// longer means "the OS sheet is the better UI". On desktop it opens the Windows
// share sheet, which lists only installed apps (Outlook, Teams, Nearby Sharing)
// and has no copy-link — Facebook/X/etc. are simply not reachable from it. On a
// phone the same sheet is genuinely the best option, so gate on the pointer:
// coarse primary pointer = touch device. A touchscreen laptop still reports
// `fine` because the media query describes the *primary* pointer.
export function prefersNativeShare() {
  if (!canNativeShare()) return false;
  try {
    return window.matchMedia("(pointer: coarse)").matches;
  } catch {
    return false;
  }
}

// Returns "ok" | "abort" | "fail" so callers can distinguish a user-cancelled
// sheet (do nothing) from a broken one (fall back to the dialog).
export async function nativeShare({ title, text, url }) {
  try {
    await navigator.share({ title, text, url });
    return "ok";
  } catch (error) {
    if (error?.name === "AbortError") return "abort";
    console.error("Share failed:", error);
    return "fail";
  }
}

// Callers that pass the same string as both title and text (the search-result
// buttons do) shouldn't get it echoed twice in the copied message.
export function buildShareMessage(title, text) {
  return text && text !== title ? `${title}: ${text}` : title || "";
}

export function buildShareTargets({ title, message, url }) {
  const encodedUrl = encodeURIComponent(url);
  const encodedMessage = encodeURIComponent(message);
  const messageWithUrl = encodeURIComponent(`${message} ${url}`);

  return [
    {
      name: "X",
      href: `https://twitter.com/intent/tweet?text=${encodedMessage}&url=${encodedUrl}`,
      color: "#000000",
    },
    {
      name: "Facebook",
      href: `https://www.facebook.com/sharer/sharer.php?u=${encodedUrl}`,
      color: "#1877F2",
    },
    {
      name: "LinkedIn",
      href: `https://www.linkedin.com/sharing/share-offsite/?url=${encodedUrl}`,
      color: "#0A66C2",
    },
    {
      name: "Threads",
      href: `https://www.threads.net/intent/post?text=${messageWithUrl}`,
      color: "#333333",
    },
    {
      name: "Bluesky",
      href: `https://bsky.app/intent/compose?text=${messageWithUrl}`,
      color: "#0285FF",
    },
    {
      name: "Reddit",
      href: `https://www.reddit.com/submit?url=${encodedUrl}&title=${encodeURIComponent(title)}`,
      color: "#FF4500",
    },
    {
      name: "WhatsApp",
      href: `https://wa.me/?text=${messageWithUrl}`,
      color: "#25D366",
    },
    {
      name: "Email",
      href: `mailto:?subject=${encodeURIComponent(title)}&body=${encodeURIComponent(
        `${message}\n\n${url}`
      )}`,
      color: "#64748B",
    },
  ];
}
