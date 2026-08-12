// Lazy-chunk entry for the results map. Everything leaflet lives behind this
// module boundary (React.lazy in ResultsPage) so the ~150 KB vendor-leaflet
// chunk loads on first toggle — never in the main bundle (900 KB CI gate).
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MapContainer, TileLayer, Marker, Polyline, ZoomControl, AttributionControl, useMap, useMapEvents } from "react-leaflet";
import L from "leaflet";
import { useTheme } from "next-themes";
import { Maximize2, Minimize2 } from "lucide-react";
import "leaflet/dist/leaflet.css";
import "./map.css";
import { cn } from "@/lib/utils";
import { calculateDistance } from "@/lib/distance";
import { buildMarkers, buildIndexMarkers } from "./markerData";
import { fetchPinsIndex } from "./pinsIndexClient";
import { groupByCoord, spiderfyOffsets } from "./spreadOverlaps";
import {
  makePinIcon,
  makeUserIcon,
  HQ_VIEWBOX,
  HQ_SHAPE_D,
  HQ_GLYPH_D,
  MFG_VIEWBOX,
  MFG_SHAPE_D,
  MFG_GLYPH_D,
  HOME_VIEWBOX,
  HOME_SHAPE_D,
} from "./markerIcons";
import FitBounds from "./FitBounds";
import MapHoverCard from "./MapHoverCard";

// Free basemaps, no API key. CARTO's free tier is intended for modest
// traffic — revisit the provider if volume grows. The plain-OSM fallback
// (tile.openstreetmap.org + .osm-fallback CSS inversion, see map.css) is a
// one-line swap here; OSM's donated tile servers have their own usage policy.
const WORLD_BOUNDS = [[-85, -180], [85, 180]];

const TILE_DARK = {
  url: "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",
  attribution:
    '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
};
const TILE_LIGHT = {
  url: "https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png",
  attribution: TILE_DARK.attribution,
};

const CASCADE_MAX_PINS = 50;

/**
 * A legend swatch that IS the pin — same paths, same CSS classes, so it picks
 * up the same colours and can never drift from what's on the map.
 */
function LegendPin({ kind }) {
  const spec =
    kind === "hq"
      ? { viewBox: HQ_VIEWBOX, shape: HQ_SHAPE_D, glyph: HQ_GLYPH_D, cls: "tab-pin--hq", w: 11, h: 14 }
      : kind === "mfg"
        ? { viewBox: MFG_VIEWBOX, shape: MFG_SHAPE_D, glyph: MFG_GLYPH_D, cls: "tab-pin--mfg", w: 12, h: 14 }
        : { viewBox: HOME_VIEWBOX, shape: HOME_SHAPE_D, glyph: null, cls: "", w: 11, h: 14 };
  const home = kind === "home";
  return (
    <svg
      width={spec.w}
      height={spec.h}
      viewBox={spec.viewBox}
      className={cn("shrink-0", spec.cls)}
      aria-hidden="true"
    >
      <path className={home ? "tab-home__pin" : "tab-pin__shape"} d={spec.shape} />
      {home ? (
        <circle className="tab-home__hole" cx="13" cy="12" r="4" />
      ) : (
        <path className="tab-pin__glyph" d={spec.glyph} />
      )}
    </svg>
  );
}

// Opening-view horizon for a search with a location: frame roughly this many
// of the nearest pins, and never stretch past this radius to include one.
const LOCAL_FIT_COUNT = 40;
const LOCAL_FIT_MAX_KM = 400;

/** Reports the container-pixel position of a latlng, tracking map move/zoom. */
function CardTracker({ latlng, onPoint }) {
  const map = useMap();
  const update = useCallback(() => {
    if (!latlng) return;
    const pt = map.latLngToContainerPoint(latlng);
    onPoint({ x: pt.x, y: pt.y });
  }, [map, latlng, onPoint]);
  useMapEvents({ move: update, zoom: update });
  useEffect(update, [update]);
  return null;
}

/** Closes the card / collapses spiderfy on map-background interaction. */
function MapClickCatcher({ onBackgroundClick }) {
  useMapEvents({ click: onBackgroundClick });
  return null;
}

/**
 * Renders coordinate groups: singletons as pins, pile-ups as one stack pin
 * with a count badge that spiderfies into a pixel-ring on click. Lives inside
 * MapContainer for useMap (layer-point math) and re-renders on zoomend so the
 * ring tracks the zoom level.
 */
function MarkersLayer({
  groups,
  spiderfiedKey,
  onStackClick,
  activeCompanyIds,
  delayFor,
  onPinOver,
  onPinOut,
  onPinClick,
}) {
  const map = useMap();
  const [, setZoomTick] = useState(0);
  useMapEvents({ zoomend: () => setZoomTick((t) => t + 1) });

  const pinMarker = (marker, latlng, count = 0) => (
    <Marker
      key={`${marker.id}${count > 1 ? ":stack" : ""}`}
      position={latlng}
      icon={makePinIcon({
        kind: marker.kind,
        lowPrecision: marker.lowPrecision,
        active: activeCompanyIds.has(marker.companyId),
        delayMs: delayFor(marker),
        count,
        index: !!marker.index,
        inScope: !!marker.inScope,
      })}
      eventHandlers={{
        mouseover: () => onPinOver(marker, latlng),
        mouseout: () => onPinOut(marker),
        click: (e) => {
          L.DomEvent.stopPropagation(e);
          onPinClick(marker, latlng);
        },
      }}
    />
  );

  return groups.map((group) => {
    const center = [group.lat, group.lng];
    if (group.markers.length === 1) return pinMarker(group.markers[0], center);

    if (spiderfiedKey !== group.key) {
      // Collapsed stack: representative pin + count badge. Click to fan out.
      const rep = group.markers[0];
      return (
        <Marker
          key={`stack:${group.key}`}
          position={center}
          icon={makePinIcon({
            kind: rep.kind,
            lowPrecision: group.markers.every((m) => m.lowPrecision),
            active: group.markers.some((m) => activeCompanyIds.has(m.companyId)),
            delayMs: delayFor(rep),
            count: group.markers.length,
            // A stack renders light only when EVERY member is an index pin —
            // any page result in the pile keeps the stack full-strength.
            index: group.markers.every((m) => m.index),
            // Mirror image: one in-place company in the pile marks the whole
            // stack, since collapsing it must not hide that the place has a
            // company in it.
            inScope: group.markers.some((m) => m.inScope),
          })}
          eventHandlers={{
            click: (e) => {
              L.DomEvent.stopPropagation(e);
              onStackClick(group.key);
            },
          }}
        />
      );
    }

    // Spiderfied: fan members out on a pixel ring with dashed legs back to
    // the shared coordinate. Pixel-space math so the ring is zoom-stable.
    const centerPt = map.latLngToLayerPoint(center);
    const offsets = spiderfyOffsets(group.markers.length);
    return (
      <React.Fragment key={`spider:${group.key}`}>
        {group.markers.map((marker, i) => {
          const latlng = map.layerPointToLatLng(
            L.point(centerPt.x + offsets[i].x, centerPt.y + offsets[i].y)
          );
          return (
            <React.Fragment key={marker.id}>
              <Polyline
                positions={[center, [latlng.lat, latlng.lng]]}
                pathOptions={{ className: "tab-spider-leg", weight: 1.5 }}
              />
              {pinMarker(marker, [latlng.lat, latlng.lng])}
            </React.Fragment>
          );
        })}
      </React.Fragment>
    );
  });
}

export default function ResultsMapPanel({
  companies,
  pinFilter = "both",
  unit = "mi",
  userLoc = null,
  hoveredCompanyId = null,
  promotedId = null,
  onPinHover,
  onPinFilterChange,
  /**
   * Open a pinned company in the results column instead of a new tab.
   * Null when there is no column on screen (fullscreen / mobile), which
   * falls the card back to its link.
   */
  onOpenProfile = null,
  boundsKey,
  linkParams = "",
  loading = false,
  matchIds = null,
  /** Set of company ids inside the searched place (vs merely near it). */
  inScopeIds = null,
  /** Name of that place, for the legend. */
  scopeLabel = "",
  isFullscreen = false,
  onToggleFullscreen,
}) {
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === "dark";
  const tiles = isDark ? TILE_DARK : TILE_LIGHT;

  const wrapperRef = useRef(null);
  const mapRef = useRef(null);
  const [containerSize, setContainerSize] = useState({ w: 0, h: 0 });
  const [active, setActive] = useState(null); // { marker, latlng }
  const [cardPoint, setCardPoint] = useState(null);
  const [spiderfiedKey, setSpiderfiedKey] = useState(null);
  const [recenterNonce, setRecenterNonce] = useState(0);
  const closeTimerRef = useRef(null);

  const pageMarkers = useMemo(() => buildMarkers(companies, pinFilter), [companies, pinFilter]);

  // Whole-catalog pins index (fetched once, HTTP-cached) joined against the
  // search's full matched id list → lighter pins for every match beyond the
  // loaded page. Best-effort: no index, no extra pins — page pins still work.
  const [pinsIndex, setPinsIndex] = useState(null);
  // Settled means "the index is done deciding", success or failure — the
  // opening fit waits on this so it frames every match, not just this page.
  const [pinsSettled, setPinsSettled] = useState(false);
  useEffect(() => {
    let dead = false;
    fetchPinsIndex()
      .then((m) => {
        if (!dead) setPinsIndex(m);
      })
      .catch(() => {})
      .finally(() => {
        if (!dead) setPinsSettled(true);
      });
    return () => {
      dead = true;
    };
  }, []);
  const indexMarkers = useMemo(() => {
    if (!pinsIndex || !Array.isArray(matchIds) || !matchIds.length) return [];
    const pageIds = new Set(
      (Array.isArray(companies) ? companies : [])
        .map((c) => String(c?.company_id ?? c?.id ?? "").trim())
        .filter(Boolean)
    );
    return buildIndexMarkers(pinsIndex, matchIds, pageIds, pinFilter);
  }, [pinsIndex, matchIds, companies, pinFilter]);

  // Page markers FIRST: groupByCoord preserves insertion order, so a stack's
  // representative pin is always a full-strength page pin when one is present.
  //
  // Companies actually IN the searched place are marked so the map agrees
  // with the list, where they sit above the "Nearby results" divider.
  const markers = useMemo(() => {
    const all = [...pageMarkers, ...indexMarkers];
    if (!inScopeIds || !inScopeIds.size) return all;
    return all.map((m) => (inScopeIds.has(m.companyId) ? { ...m, inScope: true } : m));
  }, [pageMarkers, indexMarkers, inScopeIds]);
  const groups = useMemo(() => groupByCoord(markers), [markers]);

  // Cascade bookkeeping: a fresh search (boundsKey change) re-animates
  // everything; infinite-scroll appends mini-cascade only the new pins;
  // pin-filter/hover re-renders never re-animate. Skipped past 50 pins.
  // Delays are STICKY per marker id for the life of a boundsKey: the results
  // list re-renders several times in the first seconds (quick response →
  // full response → distance enrichment) and a recomputed "already seen ⇒
  // no delay" answer would strip the cascade class mid-animation. A sticky
  // registry keeps the icon identical across those re-renders instead.
  const delayRegistryRef = useRef({ key: null, map: new Map() });
  if (delayRegistryRef.current.key !== boundsKey) {
    delayRegistryRef.current = { key: boundsKey, map: new Map() };
  }
  useMemo(() => {
    const reg = delayRegistryRef.current.map;
    const fresh = markers.filter((m) => !reg.has(m.id));
    if (!fresh.length) return;
    // Cap on RENDERED pins (post-stacking groups), not raw markers — a stack
    // of 40 country-centroid markers animates as one pin.
    if (groups.length > CASCADE_MAX_PINS) {
      fresh.forEach((m) => reg.set(m.id, null));
      return;
    }
    // Sweep outward from the user: nearest pins land first.
    const ordered = fresh
      .map((m) => ({ id: m.id, dist: m.dist ?? Infinity }))
      .sort((a, b) => a.dist - b.dist);
    const stagger = Math.min(40, 1200 / ordered.length);
    ordered.forEach((m, i) => reg.set(m.id, i * stagger));
  }, [markers, groups]);
  const delayFor = useCallback((marker) => {
    const v = delayRegistryRef.current.map.get(marker.id);
    return v === undefined ? null : v;
  }, []);

  // Sticky/breakpoint/toggle changes all resize the container — Leaflet
  // needs an explicit invalidateSize to repaint tiles correctly.
  useEffect(() => {
    const el = wrapperRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const obs = new ResizeObserver(() => {
      mapRef.current?.invalidateSize();
      const rect = el.getBoundingClientRect();
      setContainerSize({ w: rect.width, h: rect.height });
    });
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  const cancelClose = useCallback(() => {
    if (closeTimerRef.current) {
      clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  }, []);
  const scheduleClose = useCallback(() => {
    cancelClose();
    // Grace period so the cursor can travel from pin to card.
    closeTimerRef.current = setTimeout(() => setActive(null), 200);
  }, [cancelClose]);
  useEffect(() => cancelClose, [cancelClose]);

  // Position the card synchronously on open — CardTracker only keeps it
  // pinned during subsequent map move/zoom.
  const placeCard = useCallback((latlng) => {
    const m = mapRef.current;
    if (!m) return;
    const pt = m.latLngToContainerPoint(latlng);
    setCardPoint({ x: pt.x, y: pt.y });
  }, []);

  const handlePinOver = useCallback(
    (marker, latlng) => {
      cancelClose();
      placeCard(latlng);
      setActive({ marker, latlng });
      onPinHover?.(marker.companyId);
    },
    [cancelClose, placeCard, onPinHover]
  );
  const handlePinOut = useCallback(() => {
    onPinHover?.(null);
    scheduleClose();
  }, [onPinHover, scheduleClose]);
  const handlePinClick = useCallback(
    (marker, latlng) => {
      // Tap path (mobile): click opens/keeps the card.
      cancelClose();
      placeCard(latlng);
      setActive({ marker, latlng });
    },
    [cancelClose, placeCard]
  );
  const handleBackgroundClick = useCallback(() => {
    setActive(null);
    setSpiderfiedKey(null);
  }, []);
  const handleStackClick = useCallback((key) => {
    setActive(null);
    setSpiderfiedKey((prev) => (prev === key ? null : key));
  }, []);

  const activeCompanyIds = useMemo(() => {
    const ids = new Set();
    if (hoveredCompanyId) ids.add(String(hoveredCompanyId));
    if (promotedId) ids.add(String(promotedId));
    if (active?.marker) ids.add(active.marker.companyId);
    return ids;
  }, [hoveredCompanyId, promotedId, active]);

  // Opening view. With a search location, fit the LOCAL neighbourhood rather
  // than every pin: these companies' overseas plants are on the map too, and
  // including them zoomed the opening view out to the whole world — the
  // opposite of what a "near me" search asked for. The far pins stay put;
  // they just don't get a vote on the starting zoom. Zoom out (or hit
  // Recenter after panning) and they're all still there.
  const fitPoints = useMemo(() => {
    const all = markers.map((m) => ({ lat: m.lat, lng: m.lng }));
    const hasOrigin = userLoc && Number.isFinite(userLoc.lat) && Number.isFinite(userLoc.lng);
    if (!hasOrigin) return all;

    const origin = { lat: userLoc.lat, lng: userLoc.lng };
    const byDistance = markers
      .map((m) => ({ m, km: calculateDistance(origin.lat, origin.lng, m.lat, m.lng) }))
      .filter((x) => Number.isFinite(x.km))
      .sort((a, b) => a.km - b.km);
    if (byDistance.length === 0) return [origin];

    // Take the nearest cluster of pins, but never let one outlier stretch the
    // view: stop at LOCAL_FIT_COUNT pins or the first that is more than
    // LOCAL_FIT_MAX_KM away, whichever comes first. A minimum of one pin means
    // the view always frames at least the closest company.
    const local = [];
    for (const { m, km } of byDistance) {
      if (local.length >= LOCAL_FIT_COUNT) break;
      if (local.length > 0 && km > LOCAL_FIT_MAX_KM) break;
      local.push({ lat: m.lat, lng: m.lng });
    }
    return [origin, ...local];
  }, [markers, userLoc]);

  const filterBtn = (val, label) => (
    <button
      key={val}
      type="button"
      onClick={() => onPinFilterChange?.(val)}
      aria-pressed={pinFilter === val}
      className={cn(
        "text-xs px-2 py-1 rounded-md transition-colors",
        pinFilter === val
          ? "bg-card shadow-sm font-medium text-foreground"
          : "text-muted-foreground hover:text-foreground"
      )}
    >
      {label}
    </button>
  );

  return (
    <div
      ref={wrapperRef}
      className={cn(
        "results-map relative w-full h-full",
        // Only when tucked under the sticky site header — see map.css.
        !isFullscreen && "results-map--below-header"
      )}
    >
      <MapContainer
        ref={mapRef}
        center={[20, 0]}
        zoom={2}
        minZoom={1}
        // One world, not a filmstrip of them. Leaflet wraps infinitely by
        // default, which repeated whole continents side by side and made a
        // global pin set unreadable. maxBounds pins the view to a single
        // Earth; noWrap on the tiles stops the copies being drawn at all.
        maxBounds={WORLD_BOUNDS}
        maxBoundsViscosity={1}
        className="w-full h-full"
        // The OSM + CARTO credit is REQUIRED by ODbL and CARTO's basemap
        // terms, so it stays — but the "Leaflet" prefix is optional and the
        // rest is styled quiet (see .leaflet-control-attribution in map.css).
        attributionControl={false}
        zoomControl={false}
      >
        {/* Default zoom control lives top-LEFT, where the HQ/MFG/Both pill
            would cover its + button — pin it top-right instead. */}
        <ZoomControl position="topright" />
        {/* OSM + CARTO credit is required by ODbL and CARTO's terms, so it
            stays — prefix={false} drops only the optional "Leaflet" mention,
            and map.css keeps it small and faded. */}
        <AttributionControl position="bottomright" prefix={false} />
        <TileLayer key={isDark ? "dark" : "light"} url={tiles.url} attribution={tiles.attribution} noWrap />
        <FitBounds
          boundsKey={boundsKey}
          points={fitPoints}
          loading={loading}
          recenterNonce={recenterNonce}
          pinsSettled={pinsSettled}
        />
        <MapClickCatcher onBackgroundClick={handleBackgroundClick} />
        {active && <CardTracker latlng={active.latlng} onPoint={setCardPoint} />}
        {userLoc && Number.isFinite(userLoc.lat) && Number.isFinite(userLoc.lng) && (
          <Marker
            position={[userLoc.lat, userLoc.lng]}
            icon={makeUserIcon()}
            interactive={false}
            keyboard={false}
          />
        )}
        <MarkersLayer
          groups={groups}
          spiderfiedKey={spiderfiedKey}
          onStackClick={handleStackClick}
          activeCompanyIds={activeCompanyIds}
          delayFor={delayFor}
          onPinOver={handlePinOver}
          onPinOut={handlePinOut}
          onPinClick={handlePinClick}
        />
      </MapContainer>

      {/* HQ/MFG/Both pin filter — map-scoped UI; state lives in the URL. */}
      <div
        style={{ top: "var(--tab-map-chrome-top)" }}
        className="absolute left-2 z-[1000] flex gap-1 bg-muted/90 backdrop-blur-sm rounded-lg p-0.5 border border-border"
      >
        {filterBtn("both", "All")}
        {filterBtn("hq", "HQ")}
        {filterBtn("mfg", "Mfg")}
      </div>

      {/* Legend */}
      <div className="absolute bottom-6 left-2 z-[1000] flex flex-col gap-1 bg-card/90 backdrop-blur-sm rounded-lg px-2 py-1.5 border border-border text-[11px] text-muted-foreground">
        {/* The swatches are the pins themselves, at the same geometry and off
            the same path data — a dot and a rotated square explained the
            colours but not what the user is actually looking at. */}
        <span className="inline-flex items-center gap-1.5">
          <LegendPin kind="hq" />
          Home/HQ
        </span>
        <span className="inline-flex items-center gap-1.5">
          <LegendPin kind="mfg" />
          Manufacturing
        </span>
        <span className="inline-flex items-center gap-1.5">
          <LegendPin kind="home" />
          Your location
        </span>
        {/* Only shown when a scope actually split the results, so the ring
            never appears in the legend without appearing on the map.
            "Company in X", not "in X": the ring marks every pin belonging to
            a company that is in X — including its plants abroad, which are
            the whole point of showing them. */}
        {inScopeIds && inScopeIds.size > 0 && (
          <span className="inline-flex items-center gap-1.5">
            <span
              className="inline-block w-3 h-3 rounded-full shrink-0"
              style={{ border: "2px solid hsl(var(--primary))" }}
            />
            {scopeLabel ? `Company in ${scopeLabel}` : "Company in this place"}
          </span>
        )}
      </div>

      {/* Fullscreen toggle. Sits below the zoom control (top-right) rather
          than in a bottom corner, which the site's floating theme toggle
          already occupies. */}
      {onToggleFullscreen && (
        <button
          type="button"
          onClick={onToggleFullscreen}
          aria-pressed={isFullscreen}
          title={isFullscreen ? "Exit full screen (Esc)" : "Full screen map"}
          // Sits directly under the two 30px zoom buttons, wherever those
          // ended up (66px = 2 × 30 + a 6px gap).
          style={{ top: "calc(var(--tab-map-chrome-top) + 66px)" }}
          className="absolute right-2 z-[1000] w-8 h-8 inline-flex items-center justify-center rounded-md bg-card/90 backdrop-blur-sm border border-border text-foreground hover:bg-muted transition-colors"
        >
          {isFullscreen ? <Minimize2 size={15} aria-hidden="true" /> : <Maximize2 size={15} aria-hidden="true" />}
          <span className="sr-only">{isFullscreen ? "Exit full screen" : "Full screen map"}</span>
        </button>
      )}

      {/* Recenter — refits to the current pins on demand (the only refit
          outside a search change). Bottom-CENTER: the bottom-right corner is
          shared with the site's light/dark toggle, which covered it. */}
      <button
        type="button"
        onClick={() => setRecenterNonce((n) => n + 1)}
        className="absolute bottom-6 left-1/2 -translate-x-1/2 z-[1000] text-xs px-2.5 py-1.5 rounded-md bg-card/90 backdrop-blur-sm border border-border text-foreground hover:bg-muted transition-colors"
      >
        Recenter
      </button>

      {markers.length === 0 && (
        <div className="absolute inset-0 z-[1000] flex items-center justify-center pointer-events-none">
          <div className="bg-card/90 backdrop-blur-sm border border-border rounded-lg px-4 py-2 text-sm text-muted-foreground">
            No mappable locations in these results
          </div>
        </div>
      )}

      <MapHoverCard
        marker={active?.marker}
        point={cardPoint}
        containerSize={containerSize}
        unit={unit}
        linkParams={linkParams}
        onOpenProfile={onOpenProfile}
        onMouseEnter={cancelClose}
        onMouseLeave={scheduleClose}
        onClose={() => setActive(null)}
      />
    </div>
  );
}
