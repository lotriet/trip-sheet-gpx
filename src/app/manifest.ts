import type { MetadataRoute } from "next";

export const dynamic = "force-static";

export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/trip-sheet-gpx/",
    name: "Trip Sheet to GPX",
    short_name: "Trip Sheet",
    description: "Turn a school bus trip sheet into an OsmAnd GPX track.",
    start_url: "/trip-sheet-gpx/",
    scope: "/trip-sheet-gpx/",
    display: "standalone",
    background_color: "#f6f3ea",
    theme_color: "#0f2744",
    icons: [
      { src: "/trip-sheet-gpx/app-icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/trip-sheet-gpx/app-icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
    ],
  };
}
