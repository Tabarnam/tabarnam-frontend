// Pure same-coordinate handling for the results map. Country/state-centroid
// geocodes collide at EXACTLY identical coords (every "China" manufacturer at
// the country center), so markers are grouped by a rounded key; groups >1
// render as a single stack pin that spiderfies into a ring on click.
// No leaflet imports — the panel converts the pixel offsets to latlngs.

/** ~11 m grid; centroid collisions are exact so this only merges true stacks. */
export function coordKey(lat, lng) {
  return `${lat.toFixed(4)},${lng.toFixed(4)}`;
}

/**
 * Group markers by rounded coordinate.
 * @returns {Array<{key, lat, lng, markers}>} - singletons keep markers.length === 1
 */
export function groupByCoord(markers) {
  const byKey = new Map();
  for (const marker of Array.isArray(markers) ? markers : []) {
    const key = coordKey(marker.lat, marker.lng);
    let group = byKey.get(key);
    if (!group) {
      group = { key, lat: marker.lat, lng: marker.lng, markers: [] };
      byKey.set(key, group);
    }
    group.markers.push(marker);
  }
  return [...byKey.values()];
}

/**
 * Pixel-space ring offsets for a spiderfied group, one per marker,
 * starting at 12 o'clock. Radius grows with member count, capped so a
 * 50-pin centroid stack stays on screen.
 * @returns {Array<{x, y}>}
 */
export function spiderfyOffsets(count) {
  if (!Number.isInteger(count) || count <= 0) return [];
  if (count === 1) return [{ x: 0, y: 0 }];
  const radius = Math.min(24 + 6 * count, 120);
  const offsets = [];
  for (let i = 0; i < count; i++) {
    const angle = (2 * Math.PI * i) / count - Math.PI / 2;
    offsets.push({
      x: Math.round(radius * Math.cos(angle) * 100) / 100,
      y: Math.round(radius * Math.sin(angle) * 100) / 100,
    });
  }
  return offsets;
}
