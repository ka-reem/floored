import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/* A token that changes with EVERY build, exposed to the client.

   game/carpreview.ts keeps the garage's studio renders in localStorage so a
   returning player does not pay to re-render five cars on every visit. That
   is only safe while the stored PNGs still match what the code would draw
   today, so the store is keyed on this: a new deployment gets a new key and
   the old art is dropped rather than shown. Vercel's commit sha where there
   is one, the config's own evaluation time otherwise — both change exactly
   when a new bundle does. Read through lib/build.ts, never directly. */
const BUILD_REV =
  process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 12) ||
  process.env.GITHUB_SHA?.slice(0, 12) ||
  Date.now().toString(36);

/** @type {import('next').NextConfig} */
const nextConfig = {
  env: { NEXT_PUBLIC_BUILD_REV: BUILD_REV },
  reactStrictMode: false, // the game engine manages its own WebGL lifecycle
  outputFileTracingRoot: __dirname,
  /* Phone testing over the LAN. Next 16 refuses to serve /_next/* dev
     resources to an origin it does not recognise, so a phone hitting
     http://<mac-lan-ip>:3000 gets the HTML and then has every JS chunk and the
     HMR socket blocked — the game sits on its loading screen forever with
     nothing in the page to say why. The reason only appears in the SERVER log.

     DEV ONLY: `next build` ignores this, so it cannot widen anything in
     production. Private-range hosts only. The 192.168.4.x entry is this Mac's
     current DHCP lease and will rot when the router hands out a different one
     — if the phone starts hanging on the loading screen again, re-check with
     `ipconfig getifaddr en0` and update this list. */
  allowedDevOrigins: ["192.168.4.34", "192.168.4.*"],
  /* The dev-tools "N" route indicator defaults to bottom-left — directly on
     top of the HUD's speed/gear/score corner (rival-whiteline's screenshot
     mistook it for a game element). Top-left is the one corner the in-game
     chrome leaves empty: HUD bottom-left, minimap bottom-right, gear/⋯
     top-right. DEV ONLY: production builds never render the indicator. */
  devIndicators: { position: "top-left" },
  /* MODELS ARE IMMUTABLE ONCE STAMPED. public/models/*.glb keep the same
     filenames across builds while their contents change, so Next serves them
     `public, max-age=0` and every request pays a revalidation round trip —
     measured on Slow 4G, ~2 s for the 14 traffic bodyshells even when all
     fourteen were already in the disk cache from the menu-time prefetch.

     lib/build.ts's buildStamped() puts BUILD_REV in the query of every model
     URL the game asks for, so a URL only survives a deploy if its file did.
     The `has` clause is the safety catch: the year-long entry is handed out
     ONLY to a request carrying a `v`, so a bare /models/... path — a test
     harness, a hand-typed URL, anything that predates the stamping — keeps
     the revalidate-always behaviour and can never be answered with a stale
     year-old model. */
  async headers() {
    return [
      {
        source: "/models/:path*",
        has: [{ type: "query", key: "v" }],
        headers: [{ key: "Cache-Control", value: "public, max-age=31536000, immutable" }],
      },
    ];
  },
};

export default nextConfig;
