import type { Metadata, Viewport } from "next";
import { Overpass, Space_Grotesk, Zen_Kaku_Gothic_New } from "next/font/google";
import { Analytics } from "@vercel/analytics/next";
import PostHogProvider from "@/components/PostHogProvider";
import "./globals.css";
import "./ui-system.css";

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

/* The Blue Route sign faces (app/ui-system.css, --font-sign / --font-sign-jp).
   Overpass is the open Highway Gothic descendant the guide-sign chrome is set
   in; it is a variable font, so no weight list. Zen Kaku Gothic New carries
   the Japanese. Google serves it as unicode-range slices (there is no
   "japanese" subset to name), so it is not preloaded — the JP glyph slices
   arrive on first paint of a JP string, and until then the CSS falls back to
   the platform's JP stack. Both are self-hosted by next/font at build time,
   same as Space Grotesk above. */
const signFont = Overpass({
  subsets: ["latin"],
  variable: "--font-sign-raw",
  display: "swap",
  fallback: ["Segoe UI", "system-ui", "sans-serif"],
});
const signFontJp = Zen_Kaku_Gothic_New({
  weight: ["700", "900"],
  preload: false,
  variable: "--font-sign-jp-raw",
  display: "swap",
  fallback: ["Hiragino Kaku Gothic ProN", "Hiragino Sans", "Yu Gothic", "Meiryo", "Noto Sans JP", "sans-serif"],
});

export const metadata: Metadata = {
  title: "NEON EXPRESSWAY — 首都高 Night Drive",
  description:
    "Night driving through a procedurally generated Japanese town and its elevated expressway. Sim-grade tire physics, dense AI traffic, rain, neon.",
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
    <html lang="en" className={`${displayFont.variable} ${signFont.variable} ${signFontJp.variable}`}>
      <body>
        {/* PostHog product analytics (curated game events + sampled session
            replay — see lib/analytics.ts). Wraps the page so its mount
            effect inits the client before the game emits anything. */}
        <PostHogProvider>{children}</PostHogProvider>
        {/* Vercel Web Analytics: ~1KB, cookieless visitor counting. The
            numbers live in the Vercel dashboard's Analytics tab — the owner
            flips the project-level switch there; without it this no-ops. */}
        <Analytics />
      </body>
    </html>
  );
}
