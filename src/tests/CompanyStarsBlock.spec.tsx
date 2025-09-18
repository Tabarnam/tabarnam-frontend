/* @vitest-environment jsdom */
/// <reference types="vitest" />

import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import React from "react";
import { describe, it, expect } from "vitest";

// NOTE: path uses lowercase "results" to match your folder name
import { CompanyStarsBlock } from "@/components/results/CompanyStarsBlock";

describe("CompanyStarsBlock", () => {
  it("renders the final score text and accessible star label", () => {
    const company = {
      name: "Test Co",
      hqVerified: true,
      mfgVerified: true,
      review_count_approved: 1,
      editorial_review_count: 0,
      star_overrides: null,
      admin_manual_extra: 0,
      star_notes: [],
    };

    render(<CompanyStarsBlock company={company as any} />);

    // shows numeric label like "3/5"
    expect(screen.getByText(/\/5$/)).toBeInTheDocument();

    // Stars button contains sr-only text "X out of 5 stars"
    const control = screen.getByRole("button");
    expect(control.querySelector(".sr-only")?.textContent).toMatch(/out of 5 stars/);
  });
});
