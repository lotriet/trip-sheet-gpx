import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "Trip sheet to GPX",
  description: "Turn a Wake County school bus trip sheet into an OsmAnd track that follows the printed streets.",
  applicationName: "Trip sheet to GPX",
  manifest: "/manifest.webmanifest",
  icons: {
    icon: [
      { url: "/trip-sheet-gpx/app-icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/trip-sheet-gpx/app-icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: [{ url: "/trip-sheet-gpx/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
  },
  appleWebApp: { capable: true, title: "Trip sheet", statusBarStyle: "default" },
};

export const viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#0f2744",
  colorScheme: "light" as const,
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html
      lang="en"
      className="h-full antialiased"
      style={{ colorScheme: "light" }}
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
