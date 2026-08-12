// L.divIcon factories for the results map. All pins are inline SVG using
// currentColor, so theming (incl. dark "Deep Ocean") comes from CSS classes in
// map.css — no image assets, no unpkg hotlinks, no Leaflet default-icon
// URL patching needed.
import L from "leaflet";

// HQ: classic teardrop pin with a building glyph. 30x38, tip at bottom center.
// Glyph geometry uses INTEGER coordinates and ≥3px features — sub-pixel
// details smear when Leaflet positions markers at fractional pixels.
const HQ_SVG = `<svg width="30" height="38" viewBox="0 0 30 38" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <path class="tab-pin__shape" d="M15 1C7.8 1 2 6.8 2 14c0 9.8 13 23 13 23s13-13.2 13-23C28 6.8 22.2 1 15 1z"/>
  <g shape-rendering="crispEdges">
    <rect class="tab-pin__glyph" x="9" y="8" width="12" height="12" rx="1"/>
    <rect class="tab-pin__glyph-cut" x="11" y="10" width="3" height="3"/>
    <rect class="tab-pin__glyph-cut" x="16" y="10" width="3" height="3"/>
    <rect class="tab-pin__glyph-cut" x="11" y="15" width="3" height="3"/>
    <rect class="tab-pin__glyph-cut" x="16" y="15" width="3" height="3"/>
  </g>
</svg>`;

// MFG: diamond pin with a factory glyph. 32x36, bottom vertex is the anchor —
// distinct from HQ by shape AND color (colorblind-safe pairing).
const MFG_SVG = `<svg width="32" height="36" viewBox="0 0 32 36" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <path class="tab-pin__shape" d="M16 1L31 16L16 35L1 16Z"/>
  <path class="tab-pin__glyph" d="M9 23v-9h3v3l5-3v3l5-3v9H9z"/>
</svg>`;

const SIZES = {
  hq: { w: 30, h: 38 },
  mfg: { w: 32, h: 36 },
};

// Icon cache — hundreds of markers re-render on hover/filter changes; reuse
// the same L.divIcon instance per style so Leaflet never touches the DOM for
// unchanged markers.
const cache = new Map();

/**
 * @param {object} opts
 * @param {"hq"|"mfg"} opts.kind
 * @param {boolean} [opts.lowPrecision] - hollow/dashed "approximate" styling
 * @param {boolean} [opts.active] - hover-synced halo + scale
 * @param {number|null} [opts.delayMs] - cascade animation delay; null = no cascade
 * @param {number} [opts.count] - stack badge count (coordinate pile-ups)
 */
export function makePinIcon({
  kind,
  lowPrecision = false,
  active = false,
  delayMs = null,
  count = 0,
  index = false,
  inScope = false,
}) {
  const key = `${kind}|${lowPrecision ? 1 : 0}|${active ? 1 : 0}|${delayMs ?? "x"}|${count}|${index ? 1 : 0}|${inScope ? 1 : 0}`;
  const cached = cache.get(key);
  if (cached) return cached;

  const { w, h } = SIZES[kind] || SIZES.hq;
  const classes = [
    "tab-pin",
    `tab-pin--${kind}`,
    lowPrecision && "tab-pin--approx",
    active && "tab-pin--active",
    delayMs != null && "tab-pin--cascade",
    index && "tab-pin--index",
    inScope && "tab-pin--in-scope",
  ]
    .filter(Boolean)
    .join(" ");
  const style = delayMs != null ? ` style="--pin-delay:${Math.round(delayMs)}ms"` : "";
  const badge = count > 1 ? `<span class="tab-pin__count">${count}</span>` : "";
  const svg = kind === "mfg" ? MFG_SVG : HQ_SVG;

  const icon = L.divIcon({
    className: "tab-pin-anchor",
    html: `<div class="${classes}"${style}>${svg}${badge}</div>`,
    iconSize: [w, h],
    iconAnchor: [w / 2, h],
  });
  cache.set(key, icon);
  return icon;
}

/**
 * The search origin — the point every distance on the page is measured from.
 * A house glyph rather than a dot, because a bare dot read as "some other
 * company" next to the company pins.
 */
export function makeUserIcon() {
  const key = "user";
  const cached = cache.get(key);
  if (cached) return cached;
  const icon = L.divIcon({
    className: "tab-pin-anchor",
    html: `<div class="tab-home" title="Your search location — distances are measured from here">
      <svg width="26" height="26" viewBox="0 0 26 26" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
        <circle class="tab-home__disc" cx="13" cy="13" r="11"/>
        <path class="tab-home__glyph" d="M13 6l7 6h-2v7h-4v-4h-2v4H8v-7H6z"/>
      </svg>
    </div>`,
    iconSize: [26, 26],
    iconAnchor: [13, 13],
  });
  cache.set(key, icon);
  return icon;
}
