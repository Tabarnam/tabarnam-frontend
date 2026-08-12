import { describe, test, expect, afterEach, vi } from "vitest";
import {
  buildShareMessage,
  buildShareTargets,
  canNativeShare,
  nativeShare,
  prefersNativeShare,
} from "@/lib/share";

// The share buttons regressed silently once: Chromium shipped Web Share on
// desktop Windows, `navigator.share` became defined in desktop Brave/Chrome,
// and every share button started handing off to the Windows share sheet —
// which lists only installed apps and has no copy-link, so Facebook/X/etc.
// became unreachable. Nothing failed, because the old gate was just
// "does navigator.share exist". These tests pin the replacement gate so the
// next browser change can't flip the behaviour unnoticed.

function setPointer(kind) {
  window.matchMedia = vi.fn((query) => ({
    matches: query.includes(`pointer: ${kind}`),
    media: query,
  }));
}

function setNativeShare(impl) {
  Object.defineProperty(navigator, "share", {
    configurable: true,
    writable: true,
    value: impl,
  });
}

function clearNativeShare() {
  delete navigator.share;
}

afterEach(() => {
  clearNativeShare();
  delete window.matchMedia;
  vi.restoreAllMocks();
});

describe("prefersNativeShare", () => {
  test("false on desktop even when the browser supports Web Share", () => {
    // The exact regression: desktop Brave/Chrome on Windows. The OS sheet is
    // available but is the wrong UI, so we must fall through to our dialog.
    setNativeShare(() => Promise.resolve());
    setPointer("fine");
    expect(canNativeShare()).toBe(true);
    expect(prefersNativeShare()).toBe(false);
  });

  test("true on touch devices, where the native sheet is the better UI", () => {
    setNativeShare(() => Promise.resolve());
    setPointer("coarse");
    expect(prefersNativeShare()).toBe(true);
  });

  test("false when the browser has no Web Share at all", () => {
    clearNativeShare();
    setPointer("coarse");
    expect(canNativeShare()).toBe(false);
    expect(prefersNativeShare()).toBe(false);
  });

  test("false when matchMedia is unavailable or throws", () => {
    setNativeShare(() => Promise.resolve());
    window.matchMedia = () => {
      throw new Error("not implemented");
    };
    expect(prefersNativeShare()).toBe(false);
  });
});

describe("nativeShare", () => {
  test("passes title, text and url through to the OS sheet", async () => {
    // `url` was previously omitted, so native targets received a mashed
    // string instead of a real link (no preview card, nothing to open).
    const share = vi.fn(() => Promise.resolve());
    setNativeShare(share);
    const payload = {
      title: "Check out Dr. Squatch on Tabarnam",
      text: "Check out Dr. Squatch on Tabarnam: soap",
      url: "https://tabarnam.com/share?company=Dr.%20Squatch",
    };

    await expect(nativeShare(payload)).resolves.toBe("ok");
    expect(share).toHaveBeenCalledWith(payload);
  });

  test('"abort" when the user dismisses the sheet', async () => {
    const err = new Error("cancelled");
    err.name = "AbortError";
    setNativeShare(() => Promise.reject(err));

    // Callers must not fall back to the dialog here — the user said no.
    await expect(nativeShare({ url: "https://tabarnam.com" })).resolves.toBe("abort");
  });

  test('"fail" when the sheet is broken, so callers can fall back', async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    setNativeShare(() => Promise.reject(new Error("no handler")));

    await expect(nativeShare({ url: "https://tabarnam.com" })).resolves.toBe("fail");
  });
});

describe("buildShareMessage", () => {
  test("joins a distinct title and description", () => {
    expect(buildShareMessage("Check out Obrilo on Tabarnam", "Zero calories")).toBe(
      "Check out Obrilo on Tabarnam: Zero calories"
    );
  });

  test("does not echo the title when callers pass it as both", () => {
    // The search-result buttons pass the same string as title and text.
    const title = 'Search results for "soap" on Tabarnam';
    expect(buildShareMessage(title, title)).toBe(title);
  });

  test("tolerates a missing description", () => {
    expect(buildShareMessage("Only a title", "")).toBe("Only a title");
  });
});

describe("buildShareTargets", () => {
  const args = {
    title: 'My "Soap Picks" list on Tabarnam',
    message: 'My "Soap Picks" list on Tabarnam',
    url: "https://tabarnam.com/?bookmarks=z%3Aabc-_",
  };

  test("offers the social apps the OS sheet cannot reach", () => {
    const names = buildShareTargets(args).map((t) => t.name);
    expect(names).toEqual([
      "X",
      "Facebook",
      "LinkedIn",
      "Threads",
      "Bluesky",
      "Reddit",
      "WhatsApp",
      "Email",
    ]);
  });

  test("every target carries the share url, correctly encoded", () => {
    const encoded = encodeURIComponent(args.url);
    for (const target of buildShareTargets(args)) {
      expect(target.href, `${target.name} is missing the url`).toContain(encoded);
      // A raw "?" or "&" from the url would truncate the intent's own query.
      expect(target.href).not.toContain(args.url);
    }
  });

  test("builds the X and Facebook intents", () => {
    const targets = buildShareTargets(args);
    const byName = Object.fromEntries(targets.map((t) => [t.name, t.href]));

    expect(byName.X).toBe(
      `https://twitter.com/intent/tweet?text=${encodeURIComponent(
        args.message
      )}&url=${encodeURIComponent(args.url)}`
    );
    expect(byName.Facebook).toBe(
      `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(args.url)}`
    );
  });

  test("every target has a name, href and colour", () => {
    for (const target of buildShareTargets(args)) {
      expect(target.name).toBeTruthy();
      expect(target.href).toBeTruthy();
      expect(target.color).toMatch(/^#[0-9A-Fa-f]{6}$/);
    }
  });
});
