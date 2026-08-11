import { useEffect, useRef } from "react";
import { useMap } from "react-leaflet";
import L from "leaflet";

/**
 * Fits the map to `points` ONLY when `boundsKey` changes (a new search /
 * page / explicit recenter) — never on infinite-scroll appends, pin-filter
 * toggles, hover, or expand.
 *
 * The fit is ARMED by a key change but only FIRES once `loading` is false:
 * when the user changes search criteria with the map open, the key changes
 * while the previous search's results are still rendered — fitting
 * immediately would lock onto the OLD pins and never show the new ones.
 * Waiting out the load means the refit lands on the new result set. This
 * also covers a shared ?map=1 URL whose search is in flight at mount.
 */
export default function FitBounds({ boundsKey, points, loading = false, recenterNonce = 0 }) {
  const map = useMap();
  const lastKeyRef = useRef(null);
  const lastNonceRef = useRef(recenterNonce);
  const armedRef = useRef(true);

  useEffect(() => {
    if (boundsKey !== lastKeyRef.current) {
      lastKeyRef.current = boundsKey;
      armedRef.current = true;
    }
    // An explicit Recenter click fits NOW, regardless of loading — it must
    // never be dead just because a fetch is (or appears) in flight.
    const recenterClicked = recenterNonce !== lastNonceRef.current;
    lastNonceRef.current = recenterNonce;
    if (!recenterClicked) {
      if (!armedRef.current || loading || !points.length) return;
    } else if (!points.length) {
      return;
    }
    armedRef.current = false;
    const bounds = L.latLngBounds(points.map((p) => [p.lat, p.lng]));
    // maxZoom keeps a single-pin result from slamming to street level.
    // animate:false — a new result set also reflows the list, and the
    // ResizeObserver's invalidateSize() aborts any in-flight zoom animation,
    // leaving the map stuck on the previous search's viewport.
    map.fitBounds(bounds, { padding: [40, 40], maxZoom: 10, animate: false });
  }, [map, boundsKey, points, loading, recenterNonce]);

  return null;
}
