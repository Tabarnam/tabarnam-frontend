// L.divIcon factories for the results map. All pins are inline SVG using
// currentColor, so theming (incl. dark "Deep Ocean") comes from CSS classes in
// map.css — no image assets, no unpkg hotlinks, no Leaflet default-icon
// URL patching needed.
import L from "leaflet";

// Geometry lives here as bare path data so the map pins and the map's legend
// are drawn from the SAME source. A legend that quietly drifts from the pins
// it explains is worse than no legend.
//
// Glyph geometry uses INTEGER coordinates and ≥3px features — sub-pixel
// details smear when Leaflet positions markers at fractional pixels.

// HQ / Home: classic teardrop, tip at bottom center, viewBox 30x38.
export const HQ_VIEWBOX = "0 0 30 38";
export const HQ_SHAPE_D =
  "M15 1C7.8 1 2 6.8 2 14c0 9.8 13 23 13 23s13-13.2 13-23C28 6.8 22.2 1 15 1z";
/** A house: roof spanning the full glyph width, then the body beneath it. */
export const HQ_GLYPH_D = "M15 6l9 8h-3v8H9v-8H6z";

// MFG: diamond, bottom vertex is the anchor, viewBox 32x36 — distinct from HQ
// by shape AND colour (see map.css for the pairing).
export const MFG_VIEWBOX = "0 0 32 36";
export const MFG_SHAPE_D = "M16 1L31 16L16 35L1 16Z";
/**
 * A hex bolt head, seen from above. A wrench was tried first and lost too much
 * at 12px — a spanner is mostly thin diagonal shaft, which is exactly what
 * disappears at that size. Six straight edges and a round hole survive it,
 * and read as "made" just as immediately.
 */
export const MFG_GLYPH_D = "M16 9L22 12.5V19.5L16 23L10 19.5V12.5Z";

// The search origin: a plain red teardrop, no glyph — the one marker
// convention everybody already reads as "you are here".
export const HOME_VIEWBOX = "0 0 26 34";
export const HOME_SHAPE_D =
  "M13 1C6.9 1 2 5.9 2 12c0 8.4 11 21 11 21s11-12.6 11-21C24 5.9 19.1 1 13 1z";

const HQ_SVG = `<svg width="30" height="38" viewBox="${HQ_VIEWBOX}" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <path class="tab-pin__shape" d="${HQ_SHAPE_D}"/>
  <path class="tab-pin__glyph" d="${HQ_GLYPH_D}"/>
  <rect class="tab-pin__glyph-cut" x="13" y="16" width="4" height="6" shape-rendering="crispEdges"/>
</svg>`;

const MFG_SVG = `<svg width="32" height="36" viewBox="${MFG_VIEWBOX}" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <path class="tab-pin__shape" d="${MFG_SHAPE_D}"/>
  <path class="tab-pin__glyph" d="${MFG_GLYPH_D}"/>
  <circle class="tab-pin__glyph-cut" cx="16" cy="16" r="3"/>
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
 *
 * A red map pin, which is the one marker convention everybody already reads as
 * "you are here". It can't be confused with a company: HQ pins are the theme
 * colour and manufacturing pins are teal, and neither is ever red.
 */
export function makeUserIcon() {
  const key = "user";
  const cached = cache.get(key);
  if (cached) return cached;
  const icon = L.divIcon({
    className: "tab-pin-anchor",
    html: `<div class="tab-home" title="Your search location — distances are measured from here">
      <svg width="26" height="34" viewBox="${HOME_VIEWBOX}" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
        <path class="tab-home__pin" d="${HOME_SHAPE_D}"/>
        <circle class="tab-home__hole" cx="13" cy="12" r="4"/>
      </svg>
    </div>`,
    // Anchored at the tip, not the middle: a pin points at its location.
    iconSize: [26, 34],
    iconAnchor: [13, 34],
  });
  cache.set(key, icon);
  return icon;
}
