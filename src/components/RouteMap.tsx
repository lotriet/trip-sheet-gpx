"use client";

import { useEffect } from "react";
import { CircleMarker, MapContainer, Marker, Polyline, TileLayer, useMap, useMapEvents } from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import type { LonLat, TurnaroundPin } from "@/lib/engine/types";

type StopPin = { lat: number; lon: number; label: string };

function Fit({ coords }: { coords: LonLat[] }) {
  const map = useMap();
  useEffect(() => {
    if (coords.length < 2) return;
    const bounds = L.latLngBounds(coords.map((c) => [c[1], c[0]] as [number, number]));
    map.fitBounds(bounds, { padding: [28, 28] });
  }, [coords, map]);
  return null;
}

function Clicks({ onClick }: { onClick?: (lat: number, lon: number) => void }) {
  useMapEvents({
    click(e) {
      onClick?.(e.latlng.lat, e.latlng.lng);
    },
  });
  return null;
}

function numberIcon(n: number) {
  return L.divIcon({
    className: "stop-pin",
    html: `<div style="width:28px;height:28px;border-radius:999px;background:#0f2744;color:#fff;display:flex;align-items:center;justify-content:center;font:700 13px/1 sans-serif;border:2px solid #fff;box-shadow:0 1px 3px rgba(0,0,0,.45)">${n}</div>`,
    iconSize: [28, 28],
    iconAnchor: [14, 14],
  });
}

export default function RouteMap({
  coords,
  stops,
  turnarounds,
  selectedTurnaround,
  onMapClick,
}: {
  coords: LonLat[];
  stops: StopPin[];
  turnarounds: TurnaroundPin[];
  selectedTurnaround?: string | null;
  onMapClick?: (lat: number, lon: number) => void;
}) {
  const center: [number, number] = coords.length
    ? [coords[Math.floor(coords.length / 2)][1], coords[Math.floor(coords.length / 2)][0]]
    : [35.8, -78.78];
  return (
    <MapContainer center={center} zoom={13} className="h-[min(70vh,520px)] w-full rounded-xl" scrollWheelZoom>
      <TileLayer
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
        url="https://tile.openstreetmap.org/{z}/{x}/{y}.png"
      />
      <Fit coords={coords} />
      <Clicks onClick={onMapClick} />
      {coords.length > 1 && (
        <Polyline positions={coords.map((c) => [c[1], c[0]] as [number, number])} pathOptions={{ color: "#0f2744", weight: 5, opacity: 0.9 }} />
      )}
      {stops.map((s, i) => (
        <Marker key={`${s.lat}-${s.lon}-${i}`} position={[s.lat, s.lon]} icon={numberIcon(i + 1)} title={s.label} />
      ))}
      {turnarounds.map((t) => (
        <CircleMarker
          key={t.id}
          center={[t.lat, t.lon]}
          radius={t.id === selectedTurnaround ? 12 : 8}
          pathOptions={{
            color: "#9a3412",
            fillColor: "#f59e0b",
            fillOpacity: 0.95,
            weight: t.id === selectedTurnaround ? 3 : 2,
          }}
        />
      ))}
    </MapContainer>
  );
}
