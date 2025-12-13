import React from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { MapContainer, TileLayer, Marker } from "react-leaflet";
import "leaflet/dist/leaflet.css";
import L from "leaflet";

// Fix default marker icon path (Leaflet quirk)
delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png",
  iconUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png",
  shadowUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png",
});

function toNumberOrNull(value) {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function isValidLat(lat) {
  return typeof lat === "number" && Number.isFinite(lat) && lat >= -90 && lat <= 90;
}

function isValidLng(lng) {
  return typeof lng === "number" && Number.isFinite(lng) && lng >= -180 && lng <= 180;
}

function formatTimestamp(ts) {
  const s = typeof ts === "string" ? ts.trim() : "";
  if (!s) return "";
  const d = new Date(s);
  if (!Number.isFinite(d.getTime())) return s;
  return d.toLocaleString();
}

function computeGeoStatus({ lat, lng, geocode_status, geocode_source, geocoded_at }, { staleDays = 180 } = {}) {
  if (!isValidLat(lat) || !isValidLng(lng)) {
    const latMissing = lat === null || lat === undefined || String(lat) === "";
    const lngMissing = lng === null || lng === undefined || String(lng) === "";
    if (latMissing || lngMissing) return "MISSING";
    return "INVALID";
  }

  if (String(geocode_status || "").toLowerCase() === "failed") return "INVALID";

  const source = String(geocode_source || "").toLowerCase();
  if (source === "manual") return "OK";

  const ts = typeof geocoded_at === "string" ? geocoded_at.trim() : "";
  if (!ts) return "OK";

  const d = new Date(ts);
  const ms = d.getTime();
  if (!Number.isFinite(ms)) return "OK";

  const ageDays = (Date.now() - ms) / (1000 * 60 * 60 * 24);
  if (ageDays > staleDays) return "STALE";
  return "OK";
}

function StatusPill({ status }) {
  const s = String(status || "MISSING");
  const cls =
    s === "OK"
      ? "bg-emerald-100 text-emerald-800 border-emerald-200"
      : s === "STALE"
        ? "bg-amber-100 text-amber-800 border-amber-200"
        : s === "INVALID"
          ? "bg-red-100 text-red-800 border-red-200"
          : "bg-slate-100 text-slate-700 border-slate-200";

  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded border text-xs font-medium ${cls}`}>
      {s}
    </span>
  );
}

export default function LocationGeolocationRow({
  title,
  location,
  onChange,
  onRegeocode,
  isRegeocoding = false,
}) {
  const address =
    (typeof location?.address === "string" && location.address.trim()) ||
    (typeof location?.location === "string" && location.location.trim()) ||
    (typeof location?.formatted === "string" && location.formatted.trim()) ||
    (typeof location?.full_address === "string" && location.full_address.trim()) ||
    "";

  const [latStr, setLatStr] = React.useState(location?.lat ?? "");
  const [lngStr, setLngStr] = React.useState(location?.lng ?? "");

  React.useEffect(() => {
    setLatStr(location?.lat ?? "");
    setLngStr(location?.lng ?? "");
  }, [location?.lat, location?.lng]);

  const latNum = toNumberOrNull(latStr);
  const lngNum = toNumberOrNull(lngStr);

  const status = computeGeoStatus(
    {
      lat: latNum,
      lng: lngNum,
      geocode_status: location?.geocode_status,
      geocode_source: location?.geocode_source,
      geocoded_at: location?.geocoded_at,
    },
    { staleDays: 180 }
  );

  const formattedAddressLabel =
    (typeof location?.geocode_formatted_address === "string" && location.geocode_formatted_address.trim()) || "";

  const provider = (typeof location?.geocode_source === "string" && location.geocode_source.trim()) || "";

  const lastGeocoded = formatTimestamp(location?.geocoded_at);

  const hasValidCoords = isValidLat(latNum) && isValidLng(lngNum);

  const latError =
    latStr !== "" && latNum === null
      ? "Latitude must be a number"
      : latNum !== null && !isValidLat(latNum)
        ? "Latitude must be between -90 and 90"
        : "";

  const lngError =
    lngStr !== "" && lngNum === null
      ? "Longitude must be a number"
      : lngNum !== null && !isValidLng(lngNum)
        ? "Longitude must be between -180 and 180"
        : "";

  const commitManual = () => {
    const next = { ...(location && typeof location === "object" ? location : {}) };

    if (latNum === null || lngNum === null) {
      next.lat = latNum === null ? undefined : latNum;
      next.lng = lngNum === null ? undefined : lngNum;
      if (!isValidLat(next.lat) || !isValidLng(next.lng)) {
        next.geocode_status = undefined;
        next.geocode_source = undefined;
        next.geocoded_at = undefined;
      }
      onChange?.(next);
      return;
    }

    next.lat = latNum;
    next.lng = lngNum;

    if (isValidLat(latNum) && isValidLng(lngNum)) {
      next.geocode_status = "ok";
      next.geocode_source = "manual";
      next.geocoded_at = new Date().toISOString();
      next.geocode_error = undefined;
      next.geocode_google_status = undefined;
    }

    onChange?.(next);
  };

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4 space-y-3">
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-2">
        <div className="min-w-0">
          <div className="text-sm font-semibold text-slate-900 flex items-center gap-2">
            <span className="truncate">{title || address || "Location"}</span>
            <StatusPill status={status} />
          </div>
          {address && <div className="text-xs text-slate-600 break-words">{address}</div>}
        </div>

        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            disabled={isRegeocoding || !address || !onRegeocode}
            onClick={() => onRegeocode?.()}
          >
            {isRegeocoding ? "Re-geocoding…" : "Re-geocode"}
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div>
          <Label className="text-xs">Latitude</Label>
          <Input
            type="number"
            inputMode="decimal"
            value={latStr}
            onChange={(e) => setLatStr(e.target.value)}
            onBlur={commitManual}
            placeholder=""
          />
          {latError && <div className="text-xs text-red-600 mt-1">{latError}</div>}
        </div>
        <div>
          <Label className="text-xs">Longitude</Label>
          <Input
            type="number"
            inputMode="decimal"
            value={lngStr}
            onChange={(e) => setLngStr(e.target.value)}
            onBlur={commitManual}
            placeholder=""
          />
          {lngError && <div className="text-xs text-red-600 mt-1">{lngError}</div>}
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
        <div className="space-y-1">
          <div className="text-slate-500">Geocoded address label</div>
          <div className="text-slate-900 break-words">{formattedAddressLabel || "—"}</div>
        </div>
        <div className="space-y-1">
          <div className="text-slate-500">Geocode provider</div>
          <div className="text-slate-900">{provider || "—"}</div>
        </div>
        <div className="space-y-1">
          <div className="text-slate-500">Geocode status (stored)</div>
          <div className="text-slate-900">{location?.geocode_status ? String(location.geocode_status).toUpperCase() : "—"}</div>
        </div>
        <div className="space-y-1">
          <div className="text-slate-500">Last geocoded</div>
          <div className="text-slate-900">{lastGeocoded || "—"}</div>
        </div>
      </div>

      <div className="rounded-md border border-slate-200 overflow-hidden">
        {hasValidCoords ? (
          <div className="h-[160px] w-full">
            <MapContainer
              center={[latNum, lngNum]}
              zoom={6}
              style={{ width: "100%", height: "100%" }}
              scrollWheelZoom={false}
              dragging={false}
              doubleClickZoom={false}
              zoomControl={false}
              attributionControl={false}
            >
              <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
              <Marker position={[latNum, lngNum]} />
            </MapContainer>
          </div>
        ) : (
          <div className="h-[160px] w-full flex items-center justify-center text-sm text-slate-500 bg-slate-50">
            No geolocation
          </div>
        )}
      </div>
    </div>
  );
}
