import { describe, test, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, waitFor, cleanup, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
// vite.config.js sets `setupFiles: []`, so the matchers are imported per-file.
import "@testing-library/jest-dom/vitest";
import ShareButton from "@/components/ShareButton";

// The share buttons regressed silently once: the payload passed only `text`,
// with no `url`. Windows filters share targets by data type, so a text-only
// payload was never offered to the link-handling apps — the sheet showed just
// Outlook/Teams/Nearby Sharing, with no copy-link and no QR. Sending a real
// url restores Gmail, X, WhatsApp, Facebook, LinkedIn, Discord and the rest.
// The url assertion below is the guard; losing it degrades the sheet again
// without anything visibly breaking.

const COMPANY = {
  company_name: "Dr. Squatch",
  tagline: "FEEL LIKE A MAN, SMELL LIKE A CHAMPION",
  headquarters_location: "Marina del Rey, CA",
};

const COMPANY_URL = "http://localhost:3000/share?company=Dr.%20Squatch";

function setNativeShare(impl) {
  Object.defineProperty(navigator, "share", {
    configurable: true,
    writable: true,
    value: impl,
  });
}

beforeEach(() => {
  // jsdom has no matchMedia; Radix's dialog internals expect one to exist.
  window.matchMedia = vi.fn((query) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
});

afterEach(() => {
  cleanup();
  delete navigator.share;
  delete window.matchMedia;
  vi.restoreAllMocks();
});

describe("ShareButton where the browser has Web Share", () => {
  test("opens the OS sheet directly, with a real url in the payload", async () => {
    const share = vi.fn(() => Promise.resolve());
    setNativeShare(share);
    const user = userEvent.setup();

    render(<ShareButton company={COMPANY} />);
    await user.click(screen.getByRole("button", { name: /share dr\. squatch/i }));

    await waitFor(() => expect(share).toHaveBeenCalledTimes(1));
    expect(share).toHaveBeenCalledWith({
      title: "Check out Dr. Squatch on Tabarnam",
      text: "Check out Dr. Squatch on Tabarnam: FEEL LIKE A MAN, SMELL LIKE A CHAMPION. HQ in Marina del Rey, CA.",
      url: COMPANY_URL,
    });
    // No interstitial of our own between the click and the sheet.
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  test("shares the given url when callers pass one (search results)", async () => {
    const share = vi.fn(() => Promise.resolve());
    setNativeShare(share);
    const user = userEvent.setup();

    render(
      <ShareButton
        title={'Search results for "soap" on Tabarnam'}
        text={'Search results for "soap" on Tabarnam'}
        url="http://localhost:3000/results?q=soap"
        label="Share these search results"
        dialogTitle="Share search results"
      />
    );
    await user.click(screen.getByRole("button", { name: "Share these search results" }));

    await waitFor(() => expect(share).toHaveBeenCalledTimes(1));
    expect(share).toHaveBeenCalledWith({
      // Title and text are deduped rather than echoed twice.
      title: 'Search results for "soap" on Tabarnam',
      text: 'Search results for "soap" on Tabarnam',
      url: "http://localhost:3000/results?q=soap",
    });
  });

  test("stays closed when the user dismisses the sheet", async () => {
    const err = new Error("cancelled");
    err.name = "AbortError";
    setNativeShare(vi.fn(() => Promise.reject(err)));
    const user = userEvent.setup();

    render(<ShareButton company={COMPANY} />);
    await user.click(screen.getByRole("button", { name: /share dr\. squatch/i }));

    await waitFor(() => expect(navigator.share).toHaveBeenCalled());
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  test("falls back to the dialog when the sheet is broken", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    setNativeShare(vi.fn(() => Promise.reject(new Error("no handler"))));
    const user = userEvent.setup();

    render(<ShareButton company={COMPANY} />);
    await user.click(screen.getByRole("button", { name: /share dr\. squatch/i }));

    expect(await screen.findByRole("dialog")).toBeTruthy();
  });
});

describe("ShareButton where the browser has no Web Share", () => {
  test("falls back to our dialog, with a copyable link and social targets", async () => {
    // Desktop Firefox, for example. Nothing to hand off to, so the link and
    // the intent URLs are the only way to share at all.
    const user = userEvent.setup();

    render(<ShareButton company={COMPANY} />);
    await user.click(screen.getByRole("button", { name: /share dr\. squatch/i }));

    const dialog = await screen.findByRole("dialog");
    expect(screen.getByLabelText("Share link")).toHaveValue(COMPANY_URL);
    for (const name of ["X", "Facebook", "LinkedIn", "Reddit", "WhatsApp", "Email"]) {
      expect(within(dialog).getByRole("link", { name })).toBeTruthy();
    }
  });

  test("does not offer an OS hand-off it cannot perform", async () => {
    const user = userEvent.setup();

    render(<ShareButton company={COMPANY} />);
    await user.click(screen.getByRole("button", { name: /share dr\. squatch/i }));
    await screen.findByRole("dialog");

    expect(screen.queryByRole("button", { name: /more apps/i })).toBeNull();
  });
});
