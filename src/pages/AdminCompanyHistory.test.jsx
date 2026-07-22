import React from "react";
import { describe, expect, test } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
// vite.config.js sets `setupFiles: []`, so the matchers are imported per-file.
import "@testing-library/jest-dom/vitest";

import { EntryCard } from "./AdminCompanyHistory";

// A realistic entry: an admin approved the Amazon link and wrote a tagline, and
// the server rewrote its derived bookkeeping in the same save.
const ENTRY = {
  id: "audit_1",
  created_at: new Date().toISOString(),
  action: "update",
  actor_email: "jon@tabarnam.com",
  source: "admin-ui",
  changed_fields: ["amazon_url", "amazon_url_approved", "tagline", "search_tokens", "issues_count"],
  diff: {
    amazon_url: { before: "", after: "https://www.amazon.com/stores/stinkbug" },
    amazon_url_approved: { before: false, after: true },
    tagline: { before: "", after: "Hand-poured soap" },
    search_tokens: { before: ["a"], after: ["a", "b"] },
    issues_count: { before: 3, after: 1 },
  },
};

describe("EntryCard", () => {
  test("headlines what happened, and who did it", () => {
    render(<EntryCard entry={ENTRY} />);
    expect(screen.getByText(/Edited amazon store link, amazon link, tagline/i)).toBeInTheDocument();
    expect(screen.getByText(/by jon@tabarnam\.com/i)).toBeInTheDocument();
    expect(screen.getByText("Admin editor")).toBeInTheDocument();
  });

  test("renders each change as a sentence, not a field name", () => {
    render(<EntryCard entry={ENTRY} />);
    expect(screen.getByText("Approved the Amazon store link")).toBeInTheDocument();
    expect(screen.getByText("Set to amazon.com/stores/stinkbug")).toBeInTheDocument();
    expect(screen.getByText("“Hand-poured soap”", { exact: false })).toBeInTheDocument();
    // the raw schema key must never be the thing an admin reads
    expect(screen.queryByText("amazon_url_approved")).not.toBeInTheDocument();
  });

  test("derived updates are folded away behind a count", () => {
    render(<EntryCard entry={ENTRY} />);
    expect(screen.queryByText("Search tokens")).not.toBeInTheDocument();
    const toggle = screen.getByText(/2 automatic updates/i);
    fireEvent.click(toggle);
    expect(screen.getByText("Search tokens")).toBeInTheDocument();
    expect(screen.getByText("2 removed (3 → 1)")).toBeInTheDocument();
  });

  test("raw before/after values are available on demand", () => {
    render(<EntryCard entry={ENTRY} />);
    expect(screen.queryByText("Before")).not.toBeInTheDocument();
    fireEvent.click(screen.getAllByText("Values")[0]);
    expect(screen.getAllByText("Before").length).toBeGreaterThan(0);
    expect(screen.getAllByText("After").length).toBeGreaterThan(0);
  });

  test("an added field whose `before` is undefined renders instead of crashing", () => {
    const added = {
      id: "audit_2",
      created_at: new Date().toISOString(),
      action: "update",
      diff: { tagline: { after: "Brand new" } },
    };
    expect(() => render(<EntryCard entry={added} />)).not.toThrow();
    expect(screen.getByText(/Set to “Brand new”/)).toBeInTheDocument();
  });

  test("an entry with no diff detail says so rather than rendering blank", () => {
    render(<EntryCard entry={{ id: "audit_3", created_at: new Date().toISOString(), action: "update", diff: {} }} />);
    expect(screen.getByText(/No field-level detail/i)).toBeInTheDocument();
  });
});
