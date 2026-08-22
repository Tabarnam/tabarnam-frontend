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
export default function FitBounds({
  boundsKey,
  points,
  loading = false,
  recenterNonce = 0,
  pinsSettled = true,
}) {
  const map = useMap();
  const lastKeyRef = useRef(null);
  const lastNonceRef = useRef(recenterNonce);
  const armedRef = useRef(true);
  // The first fit runs against the pins of the CURRENT PAGE only — the pins
  // index resolves a moment later and adds every other match. Those extra
  // pins are usually the tightly-clustered local ones, so the page-only fit
  // opens far wider than the result set warrants: a San Dimas search framed
  // 250km of Southern California when all 114 matches sat within 10 miles.
  // One upgrade fit is allowed when the index lands, and only while the user
  // hasn't touched the map — their pan/zoom always wins.
  const upgradedRef = useRef(false);
  const fittedCountRef = useRef(0);
  const userMovedRef = useRef(false);
  const programmaticRef = useRef(false);

  useEffect(() => {
    const onMove = () => {
      if (!programmaticRef.current) userMovedRef.current = true;
    };
    map.on("dragstart", onMove);
    map.on("zoomstart", onMove);
    return () => {
      map.off("dragstart", onMove);
      map.off("zoomstart", onMove);
    };
  }, [map]);

  // Tour bridge: the map step wants a wide continental-US view regardless of
  // how the current pins cluster — so it always looks like a real search
  // even when demo data hasn't been imported yet. The tour dispatches
  // "tour:fit-map-us" after the initial pin-fit has rendered; we override
  // with the fixed CONUS bounding box. Non-tour flows never hit this path.
  useEffect(() => {
    const handler = () => {
      programmaticRef.current = true;
      userMovedRef.current = false;
      // Continental US bounding box — includes the lower 48. Excludes AK / HI
      // on purpose so the aspect ratio matches a familiar "US map" view.
      const US_BOUNDS = L.latLngBounds([[24.4, -125.0], [49.5, -66.5]]);
      map.fitBounds(US_BOUNDS, { padding: [40, 40], animate: false });
      setTimeout(() => { programmaticRef.current = false; }, 0);
    };
    window.addEventListener("tour:fit-map-us", handler);
    return () => window.removeEventListener("tour:fit-map-us", handler);
  }, [map]);

  useEffect(() => {
    if (boundsKey !== lastKeyRef.current) {
      lastKeyRef.current = boundsKey;
      armedRef.current = true;
      upgradedRef.current = false;
      fittedCountRef.current = 0;
      userMovedRef.current = false;
    }
    // An explicit Recenter click fits NOW, regardless of loading — it must
    // never be dead just because a fetch is (or appears) in flight.
    const recenterClicked = recenterNonce !== lastNonceRef.current;
    lastNonceRef.current = recenterNonce;

    // The one post-index refit: the fit already ran, the index has since
    // delivered more pins, and the user hasn't moved the map themselves.
    const upgrading =
      !recenterClicked &&
      !armedRef.current &&
      !upgradedRef.current &&
      pinsSettled &&
      !userMovedRef.current &&
      !loading &&
      points.length > fittedCountRef.current;

    if (!recenterClicked && !upgrading) {
      if (!armedRef.current || loading || !points.length) return;
    } else if (!points.length) {
      return;
    }
    armedRef.current = false;
    if (upgrading) upgradedRef.current = true;
    fittedCountRef.current = points.length;
    const bounds = L.latLngBounds(points.map((p) => [p.lat, p.lng]));
    // maxZoom keeps a single-pin result from slamming to street level.
    // animate:false — a new result set also reflows the list, and the
    // ResizeObserver's invalidateSize() aborts any in-flight zoom animation,
    // leaving the map stuck on the previous search's viewport.
    programmaticRef.current = true;
    map.fitBounds(bounds, { padding: [40, 40], maxZoom: 10, animate: false });
    // Cleared after Leaflet's own move/zoom events have fired, so this fit
    // isn't mistaken for the user grabbing the map.
    setTimeout(() => {
      programmaticRef.current = false;
    }, 0);
  }, [map, boundsKey, points, loading, recenterNonce, pinsSettled]);

  return null;
}
