// L.divIcon factories for the results map. All pins are inline SVG using
// currentColor, so theming (incl. dark "Deep Ocean") comes from CSS classes in
// map.css — no image assets, no unpkg hotlinks, no Leaflet default-icon
// URL patching needed.
import L from "leaflet";

// HQ: classic teardrop pin with a building glyph. 28x36, tip at bottom center.
const HQ_SVG = `<svg width="28" height="36" viewBox="0 0 28 36" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <path class="tab-pin__shape" d="M14 1C6.8 1 1 6.8 1 14c0 9.6 13 21 13 21s13-11.4 13-21C27 6.8 21.2 1 14 1z"/>
  <g class="tab-pin__glyph">
    <rect x="9" y="9" width="10" height="10" rx="1"/>
    <rect class="tab-pin__glyph-cut" x="11" y="11.5" width="2.2" height="2.2"/>
    <rect class="tab-pin__glyph-cut" x="14.8" y="11.5" width="2.2" height="2.2"/>
    <rect class="tab-pin__glyph-cut" x="11" y="15" width="2.2" height="2.2"/>
    <rect class="tab-pin__glyph-cut" x="14.8" y="15" width="2.2" height="2.2"/>
  </g>
</svg>`;

// MFG: diamond pin with a factory glyph. 30x34, bottom vertex is the anchor —
// distinct from HQ by shape AND color (colorblind-safe pairing).
const MFG_SVG = `<svg width="30" height="34" viewBox="0 0 30 34" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <path class="tab-pin__shape" d="M15 1L29 15L15 33L1 15Z"/>
  <path class="tab-pin__glyph" d="M9 20v-7l4 2.6V13l4 2.6V13l4 2.5V20H9z"/>
</svg>`;

const SIZES = {
  hq: { w: 28, h: 36 },
  mfg: { w: 30, h: 34 },
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
export function makePinIcon({ kind, lowPrecision = false, active = false, delayMs = null, count = 0 }) {
  const key = `${kind}|${lowPrecision ? 1 : 0}|${active ? 1 : 0}|${delayMs ?? "x"}|${count}`;
  const cached = cache.get(key);
  if (cached) return cached;

  const { w, h } = SIZES[kind] || SIZES.hq;
  const classes = [
    "tab-pin",
    `tab-pin--${kind}`,
    lowPrecision && "tab-pin--approx",
    active && "tab-pin--active",
    delayMs != null && "tab-pin--cascade",
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

/** Small pulsing dot for the user's own location. */
export function makeUserIcon() {
  const key = "user";
  const cached = cache.get(key);
  if (cached) return cached;
  const icon = L.divIcon({
    className: "tab-pin-anchor",
    html: `<div class="tab-user-dot" aria-hidden="true"></div>`,
    iconSize: [14, 14],
    iconAnchor: [7, 7],
  });
  cache.set(key, icon);
  return icon;
}
