import type { MetadataRoute } from "next";

/* Home-screen install manifest (served at /manifest.webmanifest — Next builds
   the route from this file, per node_modules/next/dist/docs/.../manifest.md).

   The game is played heavily on a phone in the browser; installed, it should
   read as a real game, not a bookmarked tab:
   - `standalone` drops the browser chrome. No service worker yet, on purpose
     — offline asset caching interacts with deploys and is a separate pass.
   - `orientation: landscape` states the intent (the dashcam frame is a
     landscape composition); iOS ignores it and Android treats it as the
     launch preference, so portrait play in a tab is unaffected.
   - Colors are the UI tokens from app/globals.css: `--bg` #05060c is both
     the splash background and the theme color, matching the themeColor
     app/layout.tsx already ships — the splash-to-loading-screen handoff
     stays one continuous dark frame.
   - Icons are committed renders from `node tools/build-pwa-icons.mjs`
     (procedural, no downloaded assets); the maskable variant keeps the
     emblem inside Android's safe circle so adaptive masks don't clip it. */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "NEON EXPRESSWAY",
    short_name: "首都高",
    description:
      "Night driving through a procedurally generated Japanese town and its elevated expressway. Sim-grade tire physics, dense AI traffic, rain, neon.",
    id: "/",
    start_url: "/",
    display: "standalone",
    orientation: "landscape",
    background_color: "#05060c",
    theme_color: "#05060c",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
      {
        src: "/icons/icon-512-maskable.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}
