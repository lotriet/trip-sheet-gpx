"use client";

import { useEffect } from "react";
import { CircleMarker, MapContainer, Marker, Polyline, Popup, TileLayer, useMap, useMapEvents } from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import type { LonLat, TurnaroundPin } from "@/lib/engine/types";
import type { TurnPin } from "@/lib/dayPlan";

type StopPin = { lat: number; lon: number; label: string };

function Fit({ coords }: { coords: LonLat[] }) {
  const map = useMap();
  useEffect(() => {
    if (coords.length < 2) return;
    const bounds = L.latLngBounds(coords.map((c) => [c[1], c[0]] as [number, number]));
    // No animation: leaving the screen mid-zoom made Leaflet throw (_leaflet_pos).
    map.fitBounds(bounds, { padding: [28, 28], animate: false });
  }, [coords, map]);
  return null;
}

function FocusPoint({ point }: { point?: { lat: number; lon: number; key: number } }) {
  const map = useMap();
  useEffect(() => {
    if (!point) return;
    map.setView([point.lat, point.lon], Math.max(map.getZoom(), 16), { animate: false });
  }, [map, point]);
  return null;
}

function FocusArea({ points }: { points?: LonLat[] }) {
  const map = useMap();
  useEffect(() => {
    if (!points || points.length < 2) return;
    map.fitBounds(L.latLngBounds(points.map(([lon, lat]) => [lat, lon] as [number, number])), {
      padding: [36, 36],
      maxZoom: 16,
      animate: false,
    });
  }, [map, points]);
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

/** L, R or U where the track turns. Amber when the router could not confirm the intersection. */
function turnIcon(pin: TurnPin) {
  const letter = pin.kind === "left" ? "L" : pin.kind === "right" ? "R" : "U";
  const fill = pin.confirmed ? "#ffffff" : "#f59e0b";
  return L.divIcon({
    className: "turn-pin",
    html: `<div style="width:20px;height:20px;border-radius:6px;background:${fill};color:#0f2744;display:flex;align-items:center;justify-content:center;font:800 11px/1 sans-serif;border:2px solid #0f2744;box-shadow:0 1px 2px rgba(0,0,0,.35)">${letter}</div>`,
    iconSize: [20, 20],
    iconAnchor: [10, 10],
  });
}

export default function RouteMap({
  coords,
  stops,
  turnarounds,
  vias = [],
  turns = [],
  warningStops = [],
  highlightedLines = [],
  focusArea,
  focusPoint,
  selectedTurnaround,
  picking = false,
  onMapClick,
}: {
  coords: LonLat[];
  stops: StopPin[];
  turnarounds: TurnaroundPin[];
  vias?: { lat: number; lon: number }[];
  /** Where each printed turn happens on the track. */
  turns?: TurnPin[];
  warningStops?: StopPin[];
  highlightedLines?: LonLat[][];
  focusArea?: LonLat[];
  focusPoint?: { lat: number; lon: number; key: number };
  selectedTurnaround?: string | null;
  /** The next tap should add a via, so the map takes the touch instead of the page. */
  picking?: boolean;
  onMapClick?: (lat: number, lon: number) => void;
}) {
  const center: [number, number] = coords.length
    ? [coords[Math.floor(coords.length / 2)][1], coords[Math.floor(coords.length / 2)][0]]
    : [35.8, -78.78];
  return (
    <MapContainer center={center} zoom={13} className={`${picking ? "h-[min(45vh,360px)] ring-4 ring-[#f5c451]" : "h-[min(55vh,420px)]"} w-full rounded-xl touch-none`} scrollWheelZoom>
      <TileLayer
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
        url="https://tile.openstreetmap.org/{z}/{x}/{y}.png"
      />
      <Fit coords={coords} />
      <FocusPoint point={focusPoint} />
      <FocusArea points={focusArea} />
      <Clicks onClick={onMapClick} />
      {coords.length > 1 && (
        <Polyline positions={coords.map((c) => [c[1], c[0]] as [number, number])} pathOptions={{ color: "#0f2744", weight: 5, opacity: 0.9 }} />
      )}
      {highlightedLines.map((line, i) => line.length > 1 && (
        <Polyline key={`highlight-${i}`} positions={line.map(([lon, lat]) => [lat, lon] as [number, number])} pathOptions={{ color: "#e11d48", weight: 8, opacity: 0.95, dashArray: "8 8" }} />
      ))}
      {turns.map((t, i) => (
        <Marker key={`turn-${i}-${t.lat}-${t.lon}`} position={[t.lat, t.lon]} icon={turnIcon(t)} title={t.label}>
          <Popup>{t.confirmed ? t.label : `${t.label} — not confirmed at a clear intersection; check it against the sheet.`}</Popup>
        </Marker>
      ))}
      {stops.map((s, i) => (
        <Marker key={`${s.lat}-${s.lon}-${i}`} position={[s.lat, s.lon]} icon={numberIcon(i + 1)} title={s.label} />
      ))}
      {warningStops.map((s, i) => (
        <CircleMarker key={`warning-${i}-${s.lat}-${s.lon}`} center={[s.lat, s.lon]} radius={17} pathOptions={{ color: "#b91c1c", fillColor: "#ef4444", fillOpacity: 0.18, weight: 4 }} />
      ))}
      {vias.map((v, i) => (
        <CircleMarker
          key={`via-${i}-${v.lat}-${v.lon}`}
          center={[v.lat, v.lon]}
          radius={10}
          pathOptions={{ color: "#1e3a8a", fillColor: "#2563eb", fillOpacity: 0.95, weight: 2 }}
        />
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
