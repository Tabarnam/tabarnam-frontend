import React, { useState } from "react";
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
// vite.config.js sets `setupFiles: []`, so the matchers are imported per-file.
import "@testing-library/jest-dom/vitest";
import AddressesEditor from "./AddressesEditor";

// WHIRLWIND Parts, verbatim from production: ONE address, typed hq, and the
// company has no manufacturing location on file at all. This is the record
// that exposed the original bug — an admin looking for the manufacturing
// address flipped the Type dropdown, saw the street fields sit still, and
// concluded the HQ address had "persisted". It had in fact just been
// reclassified.
const WHIRLWIND = [
  {
    street: "2127 Boone Trail Road",
    locality: "Sanford",
    region: "NC",
    postal_code: "27330",
    country: "USA",
    type: "hq",
    source_url: "https://www.whirlwindparts.com/aboutus.asp",
    fetched_at: "2026-08-19T16:35:32.782Z",
    is_public: false,
  },
];

/** Wrapper that holds the value, so edits behave as they do in the dashboard. */
function Harness({ initial = [], hqLocation = "", manufacturingLocations = [] }) {
  const [value, setValue] = useState(initial);
  return (
    <AddressesEditor
      value={value}
      onChange={setValue}
      hqLocation={hqLocation}
      manufacturingLocations={manufacturingLocations}
    />
  );
}

describe("AddressesEditor", () => {
  it("shows both roles as sections, even when one is empty", () => {
    render(<Harness initial={WHIRLWIND} hqLocation="Sanford, NC, USA" />);
    expect(screen.getByText("Headquarters")).toBeInTheDocument();
    expect(screen.getByText("Manufacturing")).toBeInTheDocument();
    expect(screen.getByText(/No manufacturing address captured/i)).toBeInTheDocument();
  });

  it("says so when the company has no manufacturing location on file either", () => {
    render(<Harness initial={WHIRLWIND} hqLocation="Sanford, NC, USA" manufacturingLocations={[]} />);
    expect(
      screen.getByText(/no manufacturing location on file either/i)
    ).toBeInTheDocument();
  });

  it("does NOT offer a type dropdown that could be mistaken for a view switch", () => {
    const { container } = render(<Harness initial={WHIRLWIND} hqLocation="Sanford, NC, USA" />);
    expect(container.querySelector("select")).toBeNull();
  });

  it("moves an address between sections by a named action, and it visibly moves", async () => {
    const user = userEvent.setup();
    render(<Harness initial={WHIRLWIND} hqLocation="Sanford, NC, USA" />);

    // Before: the street sits under Headquarters, Manufacturing is empty.
    expect(screen.getByText("2127 Boone Trail Road")).toBeInTheDocument();
    expect(screen.getByText(/No manufacturing address captured/i)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Move to Manufacturing/i }));

    // After: the card is gone from HQ (that section is now the empty one) and
    // the address is still on screen — under the other role.
    expect(screen.getByText(/No headquarters address captured/i)).toBeInTheDocument();
    expect(screen.getByText("2127 Boone Trail Road")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Move to Headquarters/i })).toBeInTheDocument();
  });

  it("confirms the address agrees with the normalized location field", () => {
    render(<Harness initial={WHIRLWIND} hqLocation="Sanford, NC, USA" />);
    expect(screen.getByText(/agrees with Headquarters location/i)).toBeInTheDocument();
  });

  it("warns when the street address lands somewhere the normalized field doesn't claim", () => {
    render(<Harness initial={WHIRLWIND} hqLocation="Raleigh, NC, USA" />);
    expect(screen.getByText(/Headquarters location says “Raleigh, NC, USA”/i)).toBeInTheDocument();
  });

  it("warns when there is no normalized field to check against", () => {
    render(<Harness initial={WHIRLWIND} hqLocation="" />);
    expect(
      screen.getByText(/no Headquarters location on file to check against/i)
    ).toBeInTheDocument();
  });

  it("marks a building filed under both roles instead of looking like a duplicate", () => {
    const dual = [
      { ...WHIRLWIND[0] },
      { ...WHIRLWIND[0], type: "manufacturing" },
    ];
    render(<Harness initial={dual} hqLocation="Sanford, NC, USA" manufacturingLocations={["Sanford, NC, USA"]} />);
    expect(screen.getAllByText(/also filed under/i)).toHaveLength(2);
  });

  it("shows the address read-only until Edit is pressed", async () => {
    const user = userEvent.setup();
    render(<Harness initial={WHIRLWIND} hqLocation="Sanford, NC, USA" />);

    expect(screen.queryByPlaceholderText(/^Street/)).toBeNull();
    await user.click(screen.getByRole("button", { name: /^Edit$/i }));
    expect(screen.getByPlaceholderText(/^Street/)).toHaveValue("2127 Boone Trail Road");
  });

  it("adds a new address into the section its button belongs to", async () => {
    const user = userEvent.setup();
    render(<Harness initial={WHIRLWIND} hqLocation="Sanford, NC, USA" />);

    await user.click(screen.getByRole("button", { name: /Add manufacturing address/i }));

    // The manufacturing section now holds an editable blank row.
    expect(screen.queryByText(/No manufacturing address captured/i)).toBeNull();
    expect(screen.getByPlaceholderText(/^Street/)).toHaveValue("");
  });

  it("renders nothing alarming for a company with no addresses at all", () => {
    render(<Harness initial={[]} hqLocation="Sanford, NC, USA" />);
    expect(screen.getByText(/No headquarters address captured/i)).toBeInTheDocument();
    expect(screen.getByText(/No manufacturing address captured/i)).toBeInTheDocument();
  });

  it("does not repeat the section's own title or tally inside the panel", () => {
    // Both live on the CollapsibleSection header in CompanyDashboard, so
    // seeing either here means the heading is being rendered twice.
    render(<Harness initial={WHIRLWIND} hqLocation="Sanford, NC, USA" />);
    expect(screen.queryByText("Addresses")).toBeNull();
    expect(screen.queryByText(/captured ·/)).toBeNull();
  });
});
