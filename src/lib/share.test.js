import { describe, test, expect, afterEach, vi } from "vitest";
import {
  buildShareMessage,
  buildShareTargets,
  canNativeShare,
  nativeShare,
} from "@/lib/share";

// The OS share sheet is the preferred UI wherever it exists. It only looked
// barren before because the payload omitted `url` — Windows filters targets by
// data type, so a text-only payload was never offered to the link-handling apps
// and got no copy-link or QR affordance. The `nativeShare` tests below pin that
// payload; the dialog is the fallback for browsers without Web Share.

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
  vi.restoreAllMocks();
});

describe("canNativeShare", () => {
  test("true when the browser exposes Web Share", () => {
    setNativeShare(() => Promise.resolve());
    expect(canNativeShare()).toBe(true);
  });

  test("false when it does not, so callers fall back to the dialog", () => {
    clearNativeShare();
    expect(canNativeShare()).toBe(false);
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
