import type { Metadata, Viewport } from "next";
import { Space_Grotesk } from "next/font/google";
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

export const metadata: Metadata = {
  title: "NEON EXPRESSWAY — 首都高 Night Drive",
  description:
    "Night driving through a procedurally generated Japanese town and its elevated expressway. Sim-grade tire physics, dense AI traffic, rain, neon.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  themeColor: "#05060c",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={displayFont.variable}>
      <body>{children}</body>
    </html>
  );
}
