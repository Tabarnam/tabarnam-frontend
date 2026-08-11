import { describe, it, expect } from "vitest";
import { promoteExpanded } from "./promoteExpanded";

const list = [
  { company_id: "a", name: "A" },
  { company_id: "b", name: "B" },
  { id: 3, name: "C" }, // legacy numeric id, no company_id
  { company_id: "d", name: "D" },
];

describe("promoteExpanded", () => {
  it("floats the match to the top and preserves the tail order", () => {
    const { list: out, promotedId } = promoteExpanded(list, "3");
    expect(promotedId).toBe("3");
    expect(out.map((c) => c.name)).toEqual(["C", "A", "B", "D"]);
  });

  it("coerces numeric ids and falls back from company_id to id", () => {
    const { promotedId } = promoteExpanded(list, "3");
    expect(promotedId).toBe("3");
  });

  it("no-ops (same reference) when the id is missing from the list", () => {
    const { list: out, promotedId } = promoteExpanded(list, "zzz");
    expect(out).toBe(list);
    expect(promotedId).toBeNull();
  });

  it("no-ops on an empty or blank id", () => {
    expect(promoteExpanded(list, "").promotedId).toBeNull();
    expect(promoteExpanded(list, "   ").promotedId).toBeNull();
    expect(promoteExpanded(list, undefined).promotedId).toBeNull();
    expect(promoteExpanded(list, "").list).toBe(list);
  });

  it("keeps the list reference when the match is already first, but still reports promotedId", () => {
    const { list: out, promotedId } = promoteExpanded(list, "a");
    expect(out).toBe(list);
    expect(promotedId).toBe("a");
  });

  it("tolerates junk input", () => {
    expect(promoteExpanded(null, "a")).toEqual({ list: [], promotedId: null });
    expect(promoteExpanded([null, undefined], "a").promotedId).toBeNull();
  });
});
