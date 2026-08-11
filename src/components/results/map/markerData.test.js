import { describe, it, expect } from "vitest";
import { buildMarkers, decodePinsPayload, buildIndexMarkers, buildPlaceMarkers } from "./markerData";

const company = (over = {}) => ({ company_id: "c1", display_name: "Acme", ...over });

describe("buildMarkers", () => {
  it("uses precomputed _hqDists/_manuDists when present", () => {
    const c = company({
      _hqDists: [{ lat: 33.6, lng: -117.9, dist: 4.2, formatted: "Newport Beach, CA, USA" }],
      _manuDists: [{ lat: 34.05, lng: -118.24, dist: 40.1, formatted: "Los Angeles, CA, USA" }],
      // raw fields present too — must NOT double-plot
      hq_lat: 33.6,
      hq_lng: -117.9,
      manufacturing_geocodes: [{ lat: 34.05, lng: -118.24 }],
    });
    const markers = buildMarkers([c]);
    expect(markers).toHaveLength(2);
    expect(markers.find((m) => m.kind === "hq")).toMatchObject({
      companyId: "c1",
      lat: 33.6,
      lng: -117.9,
      dist: 4.2,
      label: "Newport Beach, CA, USA",
    });
    expect(markers.find((m) => m.kind === "mfg").dist).toBe(40.1);
  });

  it("falls back to raw fields when the distance arrays are empty (no user location)", () => {
    const c = company({
      _hqDists: [],
      _manuDists: [],
      hq_lat: 33.6,
      hq_lng: -117.9,
      headquarters_location: "Newport Beach, CA, USA",
      manufacturing_geocodes: [
        { lat: 41.9, lng: 12.5, formatted: "Rome, Italy", geocode_status: "ok" },
      ],
    });
    const markers = buildMarkers([c]);
    expect(markers).toHaveLength(2);
    const hq = markers.find((m) => m.kind === "hq");
    expect(hq).toMatchObject({ lat: 33.6, lng: -117.9, dist: null, label: "Newport Beach, CA, USA" });
    expect(markers.find((m) => m.kind === "mfg").label).toBe("Rome, Italy");
  });

  it("prefers headquarters_locations over hq_lat/hq_lng in the fallback path", () => {
    const c = company({
      headquarters_locations: [{ lat: 1, lng: 2, formatted: "A" }, { lat: 3, lng: 4, formatted: "B" }],
      hq_lat: 9,
      hq_lng: 9,
    });
    const markers = buildMarkers([c], "hq");
    expect(markers.map((m) => m.label)).toEqual(["A", "B"]);
  });

  it("skips entries with a present non-ok geocode_status but keeps legacy no-status entries", () => {
    const c = company({
      manufacturing_geocodes: [
        { lat: 1, lng: 1, geocode_status: "failed" },
        { lat: 2, lng: 2, geocode_status: "error" },
        { lat: 3, lng: 3 }, // legacy: no status, finite coords → keep
        { lat: 4, lng: 4, geocode_status: "ok" },
      ],
    });
    const markers = buildMarkers([c], "mfg");
    expect(markers.map((m) => m.lat)).toEqual([3, 4]);
  });

  it("skips non-finite and missing coordinates", () => {
    const c = company({
      manufacturing_geocodes: [
        { lat: NaN, lng: 5 },
        { lat: "not-a-number", lng: "5" },
        { formatted: "No coords at all" },
        { lat: "12.5", lng: "-70.1" }, // numeric strings are fine
      ],
    });
    const markers = buildMarkers([c], "mfg");
    expect(markers).toHaveLength(1);
    expect(markers[0]).toMatchObject({ lat: 12.5, lng: -70.1 });
  });

  it("reads nested {location:{lat,lng}} and {latitude,longitude} shapes", () => {
    const c = company({
      manufacturing_geocodes: [
        { location: { lat: 7, lng: 8 } },
        { latitude: 9, longitude: 10 },
      ],
    });
    const markers = buildMarkers([c], "mfg");
    expect(markers.map((m) => [m.lat, m.lng])).toEqual([[7, 8], [9, 10]]);
  });

  it("skips the Phase-4.31 sentinel string in any casing", () => {
    const c = company({
      manufacturing_locations: [
        { lat: 1, lng: 1, formatted: "Real Place" },
        "Other unknown locations",
        "  OTHER UNKNOWN LOCATIONS  ",
      ],
    });
    const markers = buildMarkers([c], "mfg");
    expect(markers).toHaveLength(1);
    expect(markers[0].label).toBe("Real Place");
  });

  it("skips entries whose resolved label is the sentinel even when coords exist", () => {
    const c = company({
      manufacturing_geocodes: [{ lat: 1, lng: 1, formatted: "Other unknown locations" }],
    });
    expect(buildMarkers([c], "mfg")).toHaveLength(0);
  });

  it("dedupes identical (company, kind, lat, lng) but keeps distinct kinds at one coord", () => {
    const c = company({
      _hqDists: [{ lat: 5, lng: 5 }],
      _manuDists: [
        { lat: 5, lng: 5 },
        { lat: 5, lng: 5 },
      ],
    });
    const markers = buildMarkers([c]);
    expect(markers).toHaveLength(2);
    expect(markers.map((m) => m.kind).sort()).toEqual(["hq", "mfg"]);
  });

  it("flags low precision from geocode_precision or geocode_source", () => {
    const c = company({
      manufacturing_geocodes: [
        { lat: 1, lng: 1, geocode_precision: "country" },
        { lat: 2, lng: 2, geocode_precision: "administrative_area" },
        { lat: 3, lng: 3, geocode_source: "country_center" },
        { lat: 4, lng: 4, geocode_source: "state_center" },
        { lat: 5, lng: 5, geocode_precision: "locality", geocode_source: "google" },
      ],
    });
    const markers = buildMarkers([c], "mfg");
    expect(markers.map((m) => m.lowPrecision)).toEqual([true, true, true, true, false]);
  });

  it("applies the pin filter", () => {
    const c = company({ _hqDists: [{ lat: 1, lng: 1 }], _manuDists: [{ lat: 2, lng: 2 }] });
    expect(buildMarkers([c], "both")).toHaveLength(2);
    expect(buildMarkers([c], "hq").every((m) => m.kind === "hq")).toBe(true);
    expect(buildMarkers([c], "mfg").every((m) => m.kind === "mfg")).toBe(true);
  });

  it("skips companies without an id and tolerates junk input", () => {
    expect(buildMarkers(null)).toEqual([]);
    expect(buildMarkers([null, {}, { _hqDists: [{ lat: 1, lng: 1 }] }])).toEqual([]);
  });

  it("accepts id fallback when company_id is absent", () => {
    const markers = buildMarkers([{ id: 42, _hqDists: [{ lat: 1, lng: 1 }] }]);
    expect(markers).toHaveLength(1);
    expect(markers[0].companyId).toBe("42");
  });
});

describe("decodePinsPayload", () => {
  const payload = {
    version: 1,
    companies: [
      ["c1", "Acme", "Great soap", "acme.com", 33.6, -117.9, [[41.9, 12.5, 0], [35.8616, 104.1954, 1]]],
      ["c2", "NoCoords", "", "", null, null, []],
      ["", "MissingId", "", "", 1, 2, []],
      "junk",
    ],
  };

  it("decodes compact rows into an id-keyed Map", () => {
    const byId = decodePinsPayload(payload);
    expect(byId.size).toBe(2);
    expect(byId.get("c1")).toMatchObject({ name: "Acme", domain: "acme.com", hqLat: 33.6, hqLng: -117.9 });
    expect(byId.get("c1").mfg).toHaveLength(2);
    expect(byId.get("c2").hqLat).toBeNull();
  });

  it("tolerates junk payloads", () => {
    expect(decodePinsPayload(null).size).toBe(0);
    expect(decodePinsPayload({}).size).toBe(0);
  });
});

describe("buildIndexMarkers", () => {
  const byId = decodePinsPayload({
    companies: [
      ["c1", "Acme", "Great soap", "acme.com", 33.6, -117.9, [[41.9, 12.5, 0]]],
      ["c2", "Bmax", "", "", 10, 20, [[30, 40, 1]]],
    ],
  });

  it("plots matched ids that are not on the page, flagged index:true", () => {
    const markers = buildIndexMarkers(byId, ["c1", "c2"], new Set(["c1"]), "both");
    expect(markers.every((m) => m.index)).toBe(true);
    expect(markers.every((m) => m.companyId === "c2")).toBe(true);
    expect(markers.map((m) => m.kind).sort()).toEqual(["hq", "mfg"]);
    expect(markers.find((m) => m.kind === "mfg").lowPrecision).toBe(true);
  });

  it("carries a synthetic company object with the card fields", () => {
    const markers = buildIndexMarkers(byId, ["c1"], new Set(), "hq");
    expect(markers[0].company).toMatchObject({
      company_id: "c1",
      display_name: "Acme",
      tagline: "Great soap",
      normalized_domain: "acme.com",
    });
  });

  it("respects the pin filter and skips unknown ids", () => {
    expect(buildIndexMarkers(byId, ["c2", "ghost"], new Set(), "hq")).toHaveLength(1);
    expect(buildIndexMarkers(byId, ["c2"], new Set(), "mfg")[0].kind).toBe("mfg");
  });

  it("tolerates junk input", () => {
    expect(buildIndexMarkers(null, ["c1"], new Set())).toEqual([]);
    expect(buildIndexMarkers(byId, null, new Set())).toEqual([]);
  });
});

describe("buildPlaceMarkers", () => {
  // Acme manufactures in California AND Italy, HQ in California.
  // Bmax manufactures in Texas only, HQ in New York.
  const pins = decodePinsPayload({
    version: 4,
    companies: [
      ["a", "Acme", "soap", "acme.com", 33.6, -117.9, [
        [34.05, -118.24, 0, "US", "US-CA"],
        [41.9, 12.5, 0, "IT", null],
      ], "US", ["US", "IT"], "US-CA", ["US-CA"]],
      ["b", "Bmax", "", "b.com", 40.7, -74.0, [
        [30.2, -97.7, 0, "US", "US-TX"],
      ], "US", ["US"], "US-NY", ["US-TX"]],
    ],
  });

  it("plots only the pins actually inside the region", () => {
    const ca = buildPlaceMarkers(pins, { region: "US-CA", mode: "mfg" });
    expect(ca).toHaveLength(1);
    expect(ca[0]).toMatchObject({ companyId: "a", kind: "mfg", lat: 34.05 });
    // Acme's Italy pin must NOT appear on a California page
    expect(ca.some((m) => m.lng === 12.5)).toBe(false);
  });

  it("scopes by country too, keeping every in-country pin", () => {
    const us = buildPlaceMarkers(pins, { cc: "US", mode: "mfg" });
    expect(us.map((m) => m.companyId).sort()).toEqual(["a", "b"]);
    const it = buildPlaceMarkers(pins, { cc: "IT", mode: "mfg" });
    expect(it).toHaveLength(1);
    expect(it[0].companyId).toBe("a");
  });

  it("matches HQ pins on the entry's own hq codes", () => {
    const caHq = buildPlaceMarkers(pins, { region: "US-CA", mode: "hq" });
    expect(caHq).toHaveLength(1);
    expect(caHq[0]).toMatchObject({ companyId: "a", kind: "hq" });
    // Bmax is HQ'd in New York, not Texas
    expect(buildPlaceMarkers(pins, { region: "US-TX", mode: "hq" })).toHaveLength(0);
    expect(buildPlaceMarkers(pins, { region: "US-NY", mode: "hq" })[0].companyId).toBe("b");
  });

  it("both mode returns hq and mfg pins together", () => {
    const both = buildPlaceMarkers(pins, { region: "US-CA", mode: "both" });
    expect(both.map((m) => m.kind).sort()).toEqual(["hq", "mfg"]);
  });

  it("carries the hover-card company fields and tolerates junk", () => {
    const [m] = buildPlaceMarkers(pins, { region: "US-CA", mode: "mfg" });
    expect(m.company).toMatchObject({ display_name: "Acme", tagline: "soap", normalized_domain: "acme.com" });
    expect(m.index).toBe(true);
    expect(buildPlaceMarkers(null, { cc: "US" })).toEqual([]);
  });
});
