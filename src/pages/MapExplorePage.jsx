// /map — the explore map: every mappable company in the catalog, clustered.
// No search required; this is the "just show me where companies are" surface
// the product owner asked for. Data comes from /api/map-pins (the precomputed
// whole-catalog pins index, HTTP-cached); clustering is leaflet.markercluster
// with our own divIcon clusters so theming matches the app.
//
// This page lazy-loads via App.jsx, so leaflet + markercluster never touch
// the main bundle.
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Helmet } from "@/components/DocumentHead";
import { MapContainer, TileLayer, ZoomControl, AttributionControl, useMap, useMapEvents } from "react-leaflet";
import L from "leaflet";
import { useTheme } from "next-themes";
import "leaflet/dist/leaflet.css";
import "leaflet.markercluster/dist/MarkerCluster.css";
import "leaflet.markercluster";
import "@/components/results/map/map.css";
import { cn } from "@/lib/utils";
import { buildIndexMarkers } from "@/components/results/map/markerData";
import { fetchPinsIndex } from "@/components/results/map/pinsIndexClient";
import { makePinIcon, makeUserIcon } from "@/components/results/map/markerIcons";
import MapHoverCard from "@/components/results/map/MapHoverCard";

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

/**
 * Renders all markers through one L.markerClusterGroup. Imperative because
 * react-leaflet has no first-party cluster layer and ~20k React <Marker>
 * children would be slower than letting markercluster own the DOM.
 */
function ClusterLayer({ markers, onPinOver, onPinOut, onPinTap }) {
  const map = useMap();
  useEffect(() => {
    const group = L.markerClusterGroup({
      chunkedLoading: true,
      showCoverageOnHover: false,
      maxClusterRadius: 45,
      spiderfyOnMaxZoom: true,
      // Stop clustering once there's room to show pins individually.
      disableClusteringAtZoom: 10,
      iconCreateFunction: (cluster) => {
        const n = cluster.getChildCount();
        const size = n >= 1000 ? "lg" : n >= 100 ? "md" : "sm";
        return L.divIcon({
          className: "tab-cluster-anchor",
          html: `<div class="tab-cluster tab-cluster--${size}">${n >= 1000 ? `${Math.round(n / 100) / 10}k` : n}</div>`,
          iconSize: [40, 40],
          iconAnchor: [20, 20],
        });
      },
    });
    for (const m of markers) {
      const lm = L.marker([m.lat, m.lng], {
        icon: makePinIcon({ kind: m.kind, lowPrecision: m.lowPrecision }),
      });
      lm.on("mouseover", () => onPinOver(m, lm.getLatLng()));
      lm.on("mouseout", () => onPinOut(m));
      lm.on("click", () => onPinTap(m, lm.getLatLng()));
      group.addLayer(lm);
    }
    map.addLayer(group);
    return () => {
      map.removeLayer(group);
    };
  }, [map, markers, onPinOver, onPinOut, onPinTap]);
  return null;
}

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

function MapClickCatcher({ onBackgroundClick }) {
  useMapEvents({ click: onBackgroundClick });
  return null;
}

export default function MapExplorePage() {
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === "dark";
  const tiles = isDark ? TILE_DARK : TILE_LIGHT;

  const wrapperRef = useRef(null);
  const mapRef = useRef(null);
  const [containerSize, setContainerSize] = useState({ w: 0, h: 0 });
  const [pinsIndex, setPinsIndex] = useState(null);
  const [loadError, setLoadError] = useState(false);
  const [pinFilter, setPinFilter] = useState("both");
  const [active, setActive] = useState(null);
  const [cardPoint, setCardPoint] = useState(null);
  const [userDot, setUserDot] = useState(null);
  const [locating, setLocating] = useState(false);
  const closeTimerRef = useRef(null);

  useEffect(() => {
    let dead = false;
    fetchPinsIndex()
      .then((m) => {
        if (!dead) setPinsIndex(m);
      })
      .catch(() => {
        if (!dead) setLoadError(true);
      });
    return () => {
      dead = true;
    };
  }, []);

  const markers = useMemo(() => {
    if (!pinsIndex) return [];
    // Every catalog company; `index: true` keeps the domain-flow click-through
    // in the card, but the icons render full-strength — on this page the
    // catalog IS the content, so nothing to be "lighter than".
    return buildIndexMarkers(pinsIndex, [...pinsIndex.keys()], new Set(), pinFilter);
  }, [pinsIndex, pinFilter]);

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
    closeTimerRef.current = setTimeout(() => setActive(null), 200);
  }, [cancelClose]);
  useEffect(() => cancelClose, [cancelClose]);

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
    },
    [cancelClose, placeCard]
  );
  const handlePinOut = useCallback(() => scheduleClose(), [scheduleClose]);
  const handlePinTap = useCallback(
    (marker, latlng) => {
      cancelClose();
      placeCard(latlng);
      setActive({ marker, latlng });
    },
    [cancelClose, placeCard]
  );
  const handleBackgroundClick = useCallback(() => setActive(null), []);

  const handleNearMe = useCallback(() => {
    if (!navigator.geolocation || locating) return;
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLocating(false);
        const lat = pos.coords.latitude;
        const lng = pos.coords.longitude;
        setUserDot([lat, lng]);
        mapRef.current?.flyTo([lat, lng], 9, { duration: 1.2 });
      },
      () => setLocating(false),
      { timeout: 8000 }
    );
  }, [locating]);

  useEffect(() => {
    if (!userDot || !mapRef.current) return;
    const m = L.marker(userDot, { icon: makeUserIcon(), interactive: false });
    m.addTo(mapRef.current);
    return () => m.remove();
  }, [userDot]);

  const filterBtn = (val, label) => (
    <button
      key={val}
      type="button"
      onClick={() => setPinFilter(val)}
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
    <div className="px-1 pb-4 max-w-[1500px] mx-auto">
      <Helmet>
        <title>Company Map – Tabarnam</title>
        <meta
          property="og:description"
          content="Explore where companies are headquartered and where they manufacture, worldwide."
        />
      </Helmet>

      <div className="flex flex-wrap items-center justify-between gap-2 mt-4 mb-3 px-1">
        <div>
          <h1 className="text-lg font-semibold text-foreground">Company Map</h1>
          <p className="text-sm text-muted-foreground">
            {pinsIndex
              ? `${pinsIndex.size.toLocaleString()} companies — headquarters and manufacturing, worldwide. Zoom in to explore.`
              : loadError
                ? "The map data is unavailable right now — try again shortly."
                : "Loading the catalog…"}
          </p>
        </div>
        <button
          type="button"
          onClick={handleNearMe}
          disabled={locating}
          className="text-sm px-3 py-1.5 rounded-md bg-card border border-border text-foreground hover:bg-muted transition-colors disabled:opacity-50"
        >
          {locating ? "Locating…" : "Near me"}
        </button>
      </div>

      <div
        ref={wrapperRef}
        className="results-map relative z-0 h-[calc(100dvh-14rem)] min-h-[420px] rounded-lg overflow-hidden border border-border bg-card"
        style={{ isolation: "isolate" }}
      >
        <MapContainer
          ref={mapRef}
          center={[25, -30]}
          zoom={2}
          minZoom={1}
          worldCopyJump
          className="w-full h-full"
          attributionControl={false}
          zoomControl={false}
        >
          {/* Zoom control top-right: top-left is the HQ/MFG/Both pill. */}
          <ZoomControl position="topright" />
          {/* OSM + CARTO credit is required by ODbL and CARTO's terms, so it
              stays — prefix={false} drops only the optional "Leaflet" mention,
              and map.css keeps it small and faded. */}
          <AttributionControl position="bottomright" prefix={false} />
          <TileLayer key={isDark ? "dark" : "light"} url={tiles.url} attribution={tiles.attribution} noWrap />
          <MapClickCatcher onBackgroundClick={handleBackgroundClick} />
          {active && <CardTracker latlng={active.latlng} onPoint={setCardPoint} />}
          {markers.length > 0 && (
            <ClusterLayer
              markers={markers}
              onPinOver={handlePinOver}
              onPinOut={handlePinOut}
              onPinTap={handlePinTap}
            />
          )}
        </MapContainer>

        <div className="absolute top-2 left-2 z-[1000] flex gap-1 bg-muted/90 backdrop-blur-sm rounded-lg p-0.5 border border-border">
          {filterBtn("both", "All")}
          {filterBtn("hq", "HQ")}
          {filterBtn("mfg", "Mfg")}
        </div>

        <div className="absolute bottom-6 left-2 z-[1000] flex flex-col gap-1 bg-card/90 backdrop-blur-sm rounded-lg px-2 py-1.5 border border-border text-[11px] text-muted-foreground">
          <span className="inline-flex items-center gap-1.5">
            <span className="inline-block w-2.5 h-2.5 rounded-full" style={{ background: "hsl(var(--primary))" }} />
            Home/HQ
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="inline-block w-2.5 h-2.5 rotate-45" style={{ background: "#649BA0" }} />
            Manufacturing
          </span>
        </div>

        <MapHoverCard
          marker={active?.marker}
          point={cardPoint}
          containerSize={containerSize}
          unit="mi"
          linkParams=""
          onMouseEnter={cancelClose}
          onMouseLeave={scheduleClose}
          onClose={() => setActive(null)}
        />
      </div>
    </div>
  );
}
