import { describe, it, expect } from "vitest";
import { deselectEditedFields } from "./deselectEditedFields";

const FIELDS = [
  { key: "headquarters_locations" },
  { key: "manufacturing_locations" },
  { key: "tagline" },
];

// The report this exists for: Leacock's had two HQ locations, Montreal and
// Funchal. An admin deleted Montreal and saved; it came back, because a
// proposal from an earlier bulk paste still had "HQ locations" ticked and
// overwrote the draft at write time.
const MONTREAL = { address: "Montreal, Quebec, Canada" };
const FUNCHAL = { address: "Funchal, Madeira, Portugal" };

describe("deselectEditedFields", () => {
  it("unticks a row the admin has edited by hand", () => {
    const patch = deselectEditedFields({
      fields: FIELDS,
      selection: { headquarters_locations: true },
      baseline: { headquarters_locations: [MONTREAL, FUNCHAL] },
      draft: { headquarters_locations: [FUNCHAL] }, // Montreal deleted
    });
    expect(patch).toEqual({ headquarters_locations: false });
  });

  it("leaves untouched fields selected", () => {
    const patch = deselectEditedFields({
      fields: FIELDS,
      selection: { headquarters_locations: true, tagline: true },
      baseline: { headquarters_locations: [MONTREAL], tagline: "Madeira since 1741" },
      draft: { headquarters_locations: [MONTREAL], tagline: "Madeira since 1741" },
    });
    expect(patch).toBeNull();
  });

  it("only unticks the edited field, not its neighbours", () => {
    const patch = deselectEditedFields({
      fields: FIELDS,
      selection: { headquarters_locations: true, tagline: true },
      baseline: { headquarters_locations: [MONTREAL], tagline: "before" },
      draft: { headquarters_locations: [MONTREAL], tagline: "after" },
    });
    expect(patch).toEqual({ tagline: false });
  });

  it("ignores rows the admin already unticked", () => {
    const patch = deselectEditedFields({
      fields: FIELDS,
      selection: { headquarters_locations: false },
      baseline: { headquarters_locations: [MONTREAL, FUNCHAL] },
      draft: { headquarters_locations: [FUNCHAL] },
    });
    expect(patch).toBeNull();
  });

  it("uses the caller's normalizer, so cosmetic differences don't untick", () => {
    const normalize = (key, v) =>
      Array.isArray(v) ? v.map((e) => String(e?.address || "").trim().toLowerCase()) : v;
    const patch = deselectEditedFields({
      fields: FIELDS,
      selection: { headquarters_locations: true },
      baseline: { headquarters_locations: [{ address: "Funchal, Madeira, Portugal" }] },
      // Same place, re-geocoded — extra fields, same address.
      draft: { headquarters_locations: [{ address: " funchal, madeira, portugal ", lat: 32.65 }] },
      normalize,
    });
    expect(patch).toBeNull();
  });

  it("treats a field going from absent to present as an edit", () => {
    const patch = deselectEditedFields({
      fields: FIELDS,
      selection: { tagline: true },
      baseline: {},
      draft: { tagline: "typed by hand" },
    });
    expect(patch).toEqual({ tagline: false });
  });

  it("returns null when there is no baseline to compare against", () => {
    expect(
      deselectEditedFields({
        fields: FIELDS,
        selection: { tagline: true },
        baseline: null,
        draft: { tagline: "x" },
      })
    ).toBeNull();
  });

  it("survives values that cannot be serialized", () => {
    const cyclic = {};
    cyclic.self = cyclic;
    const patch = deselectEditedFields({
      fields: FIELDS,
      selection: { tagline: true },
      baseline: { tagline: cyclic },
      draft: { tagline: cyclic },
    });
    expect(patch).toBeNull();
  });
});
