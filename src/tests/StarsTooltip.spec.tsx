/* @vitest-environment jsdom */
/// <reference types="vitest" />

import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";
import { StarsTooltip } from "@/components/Stars/StarsTooltip";
import type { StarBundle } from "@/pages/types/stars";
import { describe, it, expect } from "vitest";

function makeBundle(reasons: string[]): StarBundle {
  return {
    autoSubtotal: 3,
    manualExtra: 0,
    final: 3,
    reasons,
    overrides: { hq: null, manufacturing: null, review: null },
  };
}

describe("StarsTooltip truncation", () => {
  it("shows at most 6 lines by default and expands on click", async () => {
    // 3 reason lines (HQ/Manufacturing/Reviews) + 6 public notes = 9 total
    const bundle = makeBundle(["hq", "manufacturing", "review"]);
    const notes = Array.from({ length: 6 }).map((_, i) => ({
      text: `Public note #${i + 1}`,
      public: true,
      by: "admin@test",
      at: new Date().toISOString(),
    }));

    render(<StarsTooltip bundle={bundle} notes={notes} />);

    // Expect only 6 lines visible initially
    const tooltip = screen.getByRole("tooltip");
    const items = tooltip.querySelectorAll("li");
    expect(items.length).toBe(6);

    // Show more button should indicate overflow count (+3)
    const button = screen.getByRole("button", { name: /Show more/ });
    expect(button).toHaveTextContent("(+3)");

    // Click to expand
    await userEvent.click(button);

    // Now all 9 lines visible
    const expandedItems = tooltip.querySelectorAll("li");
    expect(expandedItems.length).toBe(9);

    // Button toggles to Show less
    expect(screen.getByRole("button", { name: /Show less/ })).toBeInTheDocument();
  });
});
