import type { Metadata, Viewport } from "next";
import { Space_Grotesk } from "next/font/google";
import { Analytics } from "@vercel/analytics/next";
import "./globals.css";

/* Display face for titles/buttons/HUD numerals only (globals.css scopes it
   with var(--font-display) rather than applying .className to <body>) —
   dense UI text (settings rows, controls grid) keeps the system stack for
   legibility at 12-13px. Self-hosted by next/font: no request to Google at
   runtime, and the woff2 lands in .next/static, outside test/size-budget.mjs
   (which only walks public/). */
const displayFont = Space_Grotesk({
  subsets: ["latin"],
  variable: "--font-display-raw",
  display: "swap",
});

/* Absolute origin for the URL-bearing metadata below (canonical, og:image,
   twitter:image need fully qualified URLs — see metadataBase in
   node_modules/next/dist/docs/.../functions/generate-metadata.md).
   NEXT_PUBLIC_SITE_URL wins when set (a custom domain); otherwise Vercel's
   own production hostname, then the per-deployment hostname for previews,
   then localhost so `next build` never fails on a missing base. */
const SITE_URL =
  process.env.NEXT_PUBLIC_SITE_URL ||
  (process.env.VERCEL_PROJECT_PRODUCTION_URL
    ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
    : process.env.VERCEL_URL
      ? `https://${process.env.VERCEL_URL}`
      : "http://localhost:3000");

const DESCRIPTION =
  "Night driving through a procedurally generated Japanese town and its elevated expressway. Sim-grade tire physics, dense AI traffic, rain, neon.";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: "NEON EXPRESSWAY — 首都高 Night Drive",
  description: DESCRIPTION,
  applicationName: "NEON EXPRESSWAY",
  alternates: { canonical: "/" },
  /* Share card. public/og.png is a static 1200×630 render (night palette,
     title, 首都高ナイトドライブ, sodium-orange road deck) — a committed file
     rather than an opengraph-image route so scrapers get a plain cached
     PNG with no render on request. */
  openGraph: {
    type: "website",
    url: "/",
    siteName: "NEON EXPRESSWAY",
    title: "NEON EXPRESSWAY — 首都高 Night Drive",
    description: DESCRIPTION,
    locale: "en_US",
    images: [{ url: "/og.png", width: 1200, height: 630, alt: "NEON EXPRESSWAY — 首都高ナイトドライブ" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "NEON EXPRESSWAY — 首都高 Night Drive",
    description: DESCRIPTION,
    images: ["/og.png"],
  },
  /* iOS half of the install story (app/manifest.ts is the standard half —
     modern iOS reads it, these tags cover what it still ignores). The title
     matches the manifest short_name so the home-screen label agrees across
     platforms; black-translucent lets the page own the pixels under the
     status bar instead of stacking a black system strip on top of a
     landscape game frame. The apple-touch-icon link comes from the
     app/apple-icon.png file convention (a tools/build-pwa-icons.mjs
     render), not from config here. */
  appleWebApp: {
    title: "首都高",
    statusBarStyle: "black-translucent",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  themeColor: "#05060c",
  /* Installed standalone (and with black-translucent above) the page runs
     edge to edge, so claim the notch/home-indicator regions explicitly —
     otherwise iOS letterboxes landscape with white bars. Every edge-anchored
     HUD element pads itself back out with env(safe-area-inset-*) via the
     --sa* tokens in app/globals.css. */
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={displayFont.variable}>
      <body>
        {children}
        {/* Vercel Web Analytics: ~1KB, cookieless visitor counting. The
            numbers live in the Vercel dashboard's Analytics tab — the owner
            flips the project-level switch there; without it this no-ops. */}
        <Analytics />
      </body>
    </html>
  );
}
