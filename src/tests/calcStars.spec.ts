/// <reference types="vitest" />

import { describe, it, expect } from "vitest";
import { calcStars, buildTooltipLines } from "../lib/stars/calcStars";

describe("calcStars", () => {
  it("awards all three auto points when eligible", () => {
    const res = calcStars({
      hqEligible: true,
      manufacturingEligible: true,
      approvedUserReviews: 1,
      approvedEditorialReviews: 0,
    });
    expect(res.autoSubtotal).toBe(3);
    expect(res.final).toBe(3);
    expect(res.reasons).toContain("hq");
    expect(res.reasons).toContain("manufacturing");
    expect(res.reasons).toContain("review");
  });

  it("suppresses review point when override is suppress", () => {
    const res = calcStars({
      hqEligible: true,
      manufacturingEligible: true,
      approvedUserReviews: 2,
      overrides: { review: "suppress" },
    });
    expect(res.autoSubtotal).toBe(2); // review removed
    expect(res.reasons).not.toContain("review");
  });

  it("forces review point even with zero reviews", () => {
    const res = calcStars({
      hqEligible: false,
      manufacturingEligible: false,
      approvedUserReviews: 0,
      approvedEditorialReviews: 0,
      overrides: { review: "force" },
    });
    expect(res.autoSubtotal).toBe(1);
    expect(res.reasons).toContain("review");
  });

  it("caps manualExtra at 2 and final at 5", () => {
    const res = calcStars({
      hqEligible: true,
      manufacturingEligible: true,
      approvedUserReviews: 1,
      manualExtra: 10, // clamp to 2
    });
    expect(res.autoSubtotal).toBe(3);
    expect(res.manualExtra).toBe(2);
    expect(res.final).toBe(5);
  });

  it("clamps negative manualExtra to 0", () => {
    const res = calcStars({
      hqEligible: true,
      manufacturingEligible: false,
      approvedUserReviews: 0,
      manualExtra: -1,
    });
    expect(res.manualExtra).toBe(0);
    expect(res.final).toBe(1);
  });

  it("resolves missing overrides to nulls", () => {
    const res = calcStars({
      hqEligible: true,
      manufacturingEligible: false,
      approvedUserReviews: 0,
      overrides: {},
    });
    expect(res.overrides.hq).toBeNull();
    expect(res.overrides.manufacturing).toBeNull();
    expect(res.overrides.review).toBeNull();
  });

  it("includes admin notes as reasons and only public notes in tooltip", () => {
    const nowIso = new Date().toISOString();
    const res = calcStars({
      hqEligible: true,
      manufacturingEligible: false,
      approvedUserReviews: 0,
      notes: [
        { text: "Force for legacy vendor", public: false, by: "admin@x", at: nowIso },
        { text: "Shown in tooltip", public: true, by: "admin@y", at: nowIso },
      ],
    });
    // reasons contain admin: ... entries
    expect(res.reasons.some((r: string) => r.startsWith("admin:"))).toBe(true);

    const lines = buildTooltipLines(res, [
      { text: "Force for legacy vendor", public: false, by: "admin@x", at: nowIso },
      { text: "Shown in tooltip", public: true, by: "admin@y", at: nowIso },
    ]);
    expect(lines.join("\n")).toContain("Shown in tooltip");
    expect(lines.join("\n")).not.toContain("Force for legacy vendor");
  });
});
