import { useEffect, useRef } from "react";
import { useMap } from "react-leaflet";
import L from "leaflet";

/**
 * Fits the map to `points` ONLY when `boundsKey` changes (a new search /
 * page / explicit recenter) — never on infinite-scroll appends, pin-filter
 * toggles, hover, or expand. Also fires on the 0→N points transition for the
 * current key, covering a shared ?map=1 URL whose search is still in flight
 * at mount.
 */
export default function FitBounds({ boundsKey, points }) {
  const map = useMap();
  const lastKeyRef = useRef(null);
  const fittedRef = useRef(false);

  useEffect(() => {
    const keyChanged = boundsKey !== lastKeyRef.current;
    if (keyChanged) {
      lastKeyRef.current = boundsKey;
      fittedRef.current = false;
    }
    if (fittedRef.current || !points.length) return;
    fittedRef.current = true;
    const bounds = L.latLngBounds(points.map((p) => [p.lat, p.lng]));
    // maxZoom keeps a single-pin result from slamming to street level.
    map.fitBounds(bounds, { padding: [40, 40], maxZoom: 10 });
  }, [map, boundsKey, points]);

  return null;
}
