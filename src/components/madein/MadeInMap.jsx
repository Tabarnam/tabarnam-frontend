// Place-scoped map for the made-in pages: every company location inside one
// country or state. Lazy-loaded, so leaflet + markercluster stay out of the
// main bundle. Hovering a pin shows the same card the map surfaces use, and
// its link opens the company in a NEW TAB via the pasted-URL exact-match flow.
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MapContainer, TileLayer, ZoomControl, AttributionControl, useMap, useMapEvents } from "react-leaflet";
import L from "leaflet";
import { useTheme } from "next-themes";
import "leaflet/dist/leaflet.css";
import "leaflet.markercluster/dist/MarkerCluster.css";
import "leaflet.markercluster";
import "@/components/results/map/map.css";
import { makePinIcon } from "@/components/results/map/markerIcons";
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

function ClusterLayer({ markers, onPinOver, onPinOut, onPinTap, onBounds }) {
  const map = useMap();
  useEffect(() => {
    const group = L.markerClusterGroup({
      chunkedLoading: true,
      showCoverageOnHover: false,
      maxClusterRadius: 45,
      spiderfyOnMaxZoom: true,
      // Stop clustering once there's room to show pins individually — the
      // expanded view reads better than a badge you have to click.
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
    if (markers.length) {
      const bounds = L.latLngBounds(markers.map((m) => [m.lat, m.lng]));
      map.fitBounds(bounds, { padding: [30, 30], maxZoom: 9, animate: false });
      onBounds?.(bounds);
    }
    return () => {
      map.removeLayer(group);
    };
  }, [map, markers, onPinOver, onPinOut, onPinTap, onBounds]);
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

export default function MadeInMap({ markers, placeName }) {
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === "dark";
  const tiles = isDark ? TILE_DARK : TILE_LIGHT;

  const wrapperRef = useRef(null);
  const mapRef = useRef(null);
  const [containerSize, setContainerSize] = useState({ w: 0, h: 0 });
  const [active, setActive] = useState(null);
  const [cardPoint, setCardPoint] = useState(null);
  const closeTimerRef = useRef(null);

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

  const center = useMemo(() => {
    if (!markers.length) return [20, 0];
    return [markers[0].lat, markers[0].lng];
  }, [markers]);

  return (
    <div
      ref={wrapperRef}
      className="results-map relative z-0 h-[420px] sm:h-[520px] rounded-lg overflow-hidden border border-border bg-card"
      style={{ isolation: "isolate" }}
      aria-label={`Map of company locations in ${placeName}`}
    >
      <MapContainer
        ref={mapRef}
        center={center}
        zoom={4}
        minZoom={1}
        worldCopyJump
        className="w-full h-full"
        attributionControl={false}
        zoomControl={false}
      >
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
  );
}
