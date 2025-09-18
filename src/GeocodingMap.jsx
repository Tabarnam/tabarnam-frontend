// src/GeocodingMap.jsx
import React, { useMemo, useState } from "react";
import { MapContainer, TileLayer, Marker, Popup, useMap } from "react-leaflet";
import "leaflet/dist/leaflet.css";
import L from "leaflet";
import PinIcon from "@/assets/tabarnam-pin.jpg";

// Fix default marker icon path (Leaflet quirk)
delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png",
  iconUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png",
  shadowUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png",
});

const defaultCenter = [37.773972, -122.431297]; // SF fallback

export default function GeocodingMap({ companies = [], userCenter }) {
  const [center, setCenter] = useState(userCenter || null);

  const points = useMemo(() => {
    return companies
      .filter(c => Number.isFinite(c.hq_lat) && Number.isFinite(c.hq_lng))
      .map(c => ({ ...c, pos: [c.hq_lat, c.hq_lng] }));
  }, [companies]);

  const bounds = useMemo(() => {
    if (!points.length) return null;
    const b = L.latLngBounds(points.map(p => p.pos));
    if (center) b.extend(center);
    return b;
  }, [points, center]);

  return (
    <div className="w-full h-[480px] border rounded overflow-hidden">
      <MapContainer
        center={center || defaultCenter}
        zoom={points.length ? 6 : 3}
        style={{ width: "100%", height: "100%" }}
        whenCreated={(map) => {
          if (bounds) map.fitBounds(bounds, { padding: [30, 30] });
        }}
      >
        <TileLayer
          attribution='&copy; OpenStreetMap'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />

        {center && (
          <Marker position={center}>
            <Popup>
              <div className="flex items-center gap-2">
                <img src={PinIcon} alt="Center" className="w-5 h-5 rounded-full object-contain" />
                <span>Your reference point</span>
              </div>
            </Popup>
          </Marker>
        )}

        {points.map((c, i) => (
          <Marker key={(c.company_name || "c") + "-" + i} position={c.pos}>
            <Popup>
              <div className="space-y-1 text-sm">
                <div className="font-medium">{c.company_name}</div>
                {c.url && <a href={c.url} target="_blank" rel="noreferrer" className="text-blue-600 underline">{c.url}</a>}
                <div>{c.headquarters_location || ""}</div>
              </div>
            </Popup>
          </Marker>
        ))}

        {bounds && <FitToBounds bounds={bounds} />}
      </MapContainer>
    </div>
  );
}

function FitToBounds({ bounds }) {
  const map = useMap();
  React.useEffect(() => { if (bounds) map.fitBounds(bounds, { padding: [30, 30] }); }, [bounds, map]);
  return null;
}
