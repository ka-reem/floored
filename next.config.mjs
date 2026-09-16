import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/* A token that changes with EVERY build, exposed to the client.

   Two things cache against it, and both are only safe while what they hold
   still matches what this bundle would produce:

     game/carpreview.ts keeps the garage's studio renders in localStorage, so
     a returning player does not pay to re-render five cars on every visit.
     A new deployment gets a new key and the old art is dropped, never shown.

     lib/build.ts's buildStamped() puts it in the query of every /models/ URL
     the game asks for, which is what lets the headers() rule below hand those
     files a one-year immutable lifetime (see the note there).

   The deploy platform's commit sha where there is one (VERCEL_GIT_COMMIT_SHA
   on Vercel, WORKERS_CI_COMMIT_SHA on Cloudflare Workers Builds,
   CF_PAGES_COMMIT_SHA on the older Cloudflare Pages, GITHUB_SHA in Actions),
   the config's own evaluation time otherwise — all of them change exactly when
   a new bundle does. Read through lib/build.ts, never directly. */
const BUILD_REV =
  process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 12) ||
  process.env.WORKERS_CI_COMMIT_SHA?.slice(0, 12) ||
  process.env.CF_PAGES_COMMIT_SHA?.slice(0, 12) ||
  process.env.GITHUB_SHA?.slice(0, 12) ||
  Date.now().toString(36);

/* STATIC EXPORT — the Cloudflare build, and nothing else.
 *
 * `NEXT_OUTPUT=export next build --webpack` writes a plain HTML/CSS/JS tree to
 * out/ that any static host can serve; a bare `next build` is untouched and
 * still produces the Vercel deployment. One branch, two hosts, no fork — see
 * docs/deploy-cloudflare.md.
 *
 * out/ is what wrangler.jsonc's `assets.directory` uploads, and every file in
 * it is served by Cloudflare WITHOUT invoking a Worker script, which is the
 * whole economics of the move. Anything that reintroduces a server — an
 * adapter, a route handler that cannot prerender — breaks that, so keep this
 * build fully static.
 *
 * The one thing a static export cannot carry is `headers()` below: there is no
 * server left to run it, and Next refuses the combination. Every header rule
 * that has to survive the move therefore ALSO lives in public/_headers, which
 * is Cloudflare's file for exactly this and which copies into out/ unchanged.
 * If you add a rule to headers(), add it there too or it ships on Vercel only. */
const STATIC_EXPORT = process.env.NEXT_OUTPUT === "export";

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
  ...(STATIC_EXPORT
    ? {
        output: "export",
        /* Nothing imports next/image today (grepped app/, components/, game/,
           lib/). Its default loader is the classic static-export blocker — it
           needs a server — so this says up front that an exported build serves
           images as plain files. Inert until someone adds an <Image>, and it
           cannot reach the Vercel build, which takes the other branch. */
        images: { unoptimized: true },
      }
    : {
        async headers() {
          return [
            {
              source: "/models/:path*",
              has: [{ type: "query", key: "v" }],
              headers: [{ key: "Cache-Control", value: "public, max-age=31536000, immutable" }],
            },
          ];
        },
      }),
};

export default nextConfig;
