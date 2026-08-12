import { describe, test, expect, afterEach, vi } from "vitest";
import { render, screen, waitFor, cleanup, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
// vite.config.js sets `setupFiles: []`, so the matchers are imported per-file.
import "@testing-library/jest-dom/vitest";
import ShareButton from "@/components/ShareButton";

// End-to-end guard for the regression that shipped silently: once Chromium
// enabled Web Share on desktop Windows, `navigator.share` was defined in
// desktop Brave/Chrome and every share button handed off to the Windows share
// sheet — which lists only installed apps (Outlook, Teams, Nearby Sharing),
// has no copy-link, and cannot reach Facebook/X. Nothing failed at the time.
// These tests assert the *user-visible* outcome on each platform, so a future
// browser change that flips the gate breaks the build instead.

const COMPANY = {
  company_name: "Dr. Squatch",
  tagline: "FEEL LIKE A MAN, SMELL LIKE A CHAMPION",
  headquarters_location: "Marina del Rey, CA",
};

function setPointer(kind) {
  window.matchMedia = vi.fn((query) => ({
    matches: query.includes(`pointer: ${kind}`),
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}

function setNativeShare(impl) {
  Object.defineProperty(navigator, "share", {
    configurable: true,
    writable: true,
    value: impl,
  });
}

afterEach(() => {
  cleanup();
  delete navigator.share;
  delete window.matchMedia;
  vi.restoreAllMocks();
});

describe("ShareButton on desktop", () => {
  test("opens our dialog instead of the OS sheet, even when Web Share exists", async () => {
    const share = vi.fn(() => Promise.resolve());
    setNativeShare(share);
    setPointer("fine");
    const user = userEvent.setup();

    render(<ShareButton company={COMPANY} />);
    await user.click(screen.getByRole("button", { name: /share dr\. squatch/i }));

    const dialog = await screen.findByRole("dialog");
    expect(share).not.toHaveBeenCalled();

    // The two things the Windows share sheet cannot give you.
    expect(screen.getByLabelText("Share link")).toHaveValue(
      "http://localhost:3000/share?company=Dr.%20Squatch"
    );
    for (const name of ["X", "Facebook", "LinkedIn", "Reddit", "WhatsApp", "Email"]) {
      expect(within(dialog).getByRole("link", { name })).toBeTruthy();
    }
  });

  test("offers the OS sheet as an explicit choice when the browser supports it", async () => {
    setNativeShare(vi.fn(() => Promise.resolve()));
    setPointer("fine");
    const user = userEvent.setup();

    render(<ShareButton company={COMPANY} />);
    await user.click(screen.getByRole("button", { name: /share dr\. squatch/i }));
    await screen.findByRole("dialog");

    const moreApps = screen.getByRole("button", { name: /more apps/i });
    await user.click(moreApps);
    expect(navigator.share).toHaveBeenCalledWith(
      expect.objectContaining({ url: "http://localhost:3000/share?company=Dr.%20Squatch" })
    );
  });

  test("hides the OS hand-off when the browser has no Web Share", async () => {
    setPointer("fine");
    const user = userEvent.setup();

    render(<ShareButton company={COMPANY} />);
    await user.click(screen.getByRole("button", { name: /share dr\. squatch/i }));
    await screen.findByRole("dialog");

    expect(screen.queryByRole("button", { name: /more apps/i })).toBeNull();
  });
});

describe("ShareButton on touch devices", () => {
  test("uses the native sheet directly, with a real url in the payload", async () => {
    const share = vi.fn(() => Promise.resolve());
    setNativeShare(share);
    setPointer("coarse");
    const user = userEvent.setup();

    render(<ShareButton company={COMPANY} />);
    await user.click(screen.getByRole("button", { name: /share dr\. squatch/i }));

    await waitFor(() => expect(share).toHaveBeenCalledTimes(1));
    expect(share).toHaveBeenCalledWith({
      title: "Check out Dr. Squatch on Tabarnam",
      text: "Check out Dr. Squatch on Tabarnam: FEEL LIKE A MAN, SMELL LIKE A CHAMPION. HQ in Marina del Rey, CA.",
      url: "http://localhost:3000/share?company=Dr.%20Squatch",
    });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  test("falls back to the dialog when the native sheet is broken", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    setNativeShare(vi.fn(() => Promise.reject(new Error("no handler"))));
    setPointer("coarse");
    const user = userEvent.setup();

    render(<ShareButton company={COMPANY} />);
    await user.click(screen.getByRole("button", { name: /share dr\. squatch/i }));

    expect(await screen.findByRole("dialog")).toBeTruthy();
  });

  test("stays closed when the user dismisses the native sheet", async () => {
    const err = new Error("cancelled");
    err.name = "AbortError";
    setNativeShare(vi.fn(() => Promise.reject(err)));
    setPointer("coarse");
    const user = userEvent.setup();

    render(<ShareButton company={COMPANY} />);
    await user.click(screen.getByRole("button", { name: /share dr\. squatch/i }));

    await waitFor(() => expect(navigator.share).toHaveBeenCalled());
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("ShareButton with explicit props (search results)", () => {
  test("shares the given url rather than deriving a company link", async () => {
    setPointer("fine");
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
    await screen.findByRole("dialog");

    expect(screen.getByLabelText("Share link")).toHaveValue(
      "http://localhost:3000/results?q=soap"
    );
    expect(screen.getByText("Share search results")).toBeTruthy();
  });
});
