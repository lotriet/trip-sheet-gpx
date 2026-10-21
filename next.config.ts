import type { NextConfig } from "next";

/** GitHub project site: https://lotriet.github.io/trip-sheet-gpx/ */
const basePath = "/trip-sheet-gpx";

const nextConfig: NextConfig = {
  // The phone link is 127.0.0.1. Without this, Next blocks the dev
  // websocket and the page stays on the server render (buttons do nothing).
  allowedDevOrigins: ["127.0.0.1"],
  // A folder of HTML, JS, and CSS. `npm run build` writes it to `out/`.
  // Cache Components (PPR) cannot be combined with a static export.
  output: "export",
  basePath,
  assetPrefix: basePath,
  env: {
    NEXT_PUBLIC_BASE_PATH: basePath,
  },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
