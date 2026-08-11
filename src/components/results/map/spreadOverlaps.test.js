import { describe, it, expect } from "vitest";
import { coordKey, groupByCoord, spiderfyOffsets } from "./spreadOverlaps";

describe("coordKey", () => {
  it("rounds to 4 decimals so exact centroid collisions share a key", () => {
    expect(coordKey(35.86166, 104.195397)).toBe(coordKey(35.86166, 104.195397));
    expect(coordKey(35.86164999, 104.19540001)).toBe("35.8616,104.1954");
  });

  it("keeps genuinely different coords apart", () => {
    expect(coordKey(35.8616, 104.1954)).not.toBe(coordKey(35.8617, 104.1954));
  });
});

describe("groupByCoord", () => {
  it("groups stacked markers and leaves singletons alone", () => {
    const markers = [
      { id: "a", lat: 35.86166, lng: 104.195397 },
      { id: "b", lat: 35.86166, lng: 104.195397 },
      { id: "c", lat: 48.8566, lng: 2.3522 },
    ];
    const groups = groupByCoord(markers);
    expect(groups).toHaveLength(2);
    const stack = groups.find((g) => g.markers.length === 2);
    expect(stack.markers.map((m) => m.id)).toEqual(["a", "b"]);
    expect(groups.find((g) => g.markers.length === 1).markers[0].id).toBe("c");
  });

  it("handles empty/junk input", () => {
    expect(groupByCoord([])).toEqual([]);
    expect(groupByCoord(null)).toEqual([]);
  });
});

describe("spiderfyOffsets", () => {
  it("returns one offset per member, preserving count", () => {
    for (const n of [2, 3, 8, 25]) {
      expect(spiderfyOffsets(n)).toHaveLength(n);
    }
  });

  it("places all members on a ring of equal radius", () => {
    const offsets = spiderfyOffsets(6);
    const radii = offsets.map((o) => Math.hypot(o.x, o.y));
    for (const r of radii) expect(r).toBeCloseTo(radii[0], 1);
    expect(radii[0]).toBeCloseTo(24 + 6 * 6, 1);
  });

  it("caps the radius for huge stacks", () => {
    const offsets = spiderfyOffsets(50);
    expect(Math.hypot(offsets[0].x, offsets[0].y)).toBeCloseTo(120, 1);
  });

  it("returns a zero offset for singletons and [] for junk", () => {
    expect(spiderfyOffsets(1)).toEqual([{ x: 0, y: 0 }]);
    expect(spiderfyOffsets(0)).toEqual([]);
    expect(spiderfyOffsets(-3)).toEqual([]);
    expect(spiderfyOffsets(2.5)).toEqual([]);
  });
});
