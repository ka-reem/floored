# Deploy to Cloudflare Workers

Everything in the repo is ready. This is the button press.

**Workers, not Pages.** Cloudflare has pointed new projects at Workers with
static assets ever since Workers got native asset serving; Pages still works
but Workers is where the roadmap is, and the other project on this account is
already a Worker. Static assets cost the same on both: free and unlimited.

## 0. The one thing not to get wrong

`wrangler.jsonc` has **no `main`**, so this Worker has no script. Cloudflare
bills a request only when it *invokes a Worker script* — asset requests are
free and unlimited on every plan. One first load of this game is 30–60
requests, so if a script ever ran in front of them the free plan's 100,000
invocations/day would cap the game at roughly 1,500–3,000 loads/day: worse
than the Vercel limit this move exists to escape.

So: do not add `main`. Do not set `run_worker_first`. Do not install
`@cloudflare/next-on-pages` or `@opennextjs/cloudflare` — those adapters exist
to run Next's *server* on Workers, which would make every navigation a billed
invocation to render pages that are already files. Read the comment at the top
of `wrangler.jsonc` before changing any of it.

## 1. Create the Worker

dash.cloudflare.com → **Workers & Pages** → **Create** → the **Workers** tab →
**Import a repository** → `ka-reem/racing-game`.

(If you end up in the Pages tab, back out. The two flows look alike.)

## 2. Build settings

| Field | Value |
| --- | --- |
| Git branch (production) | `main` |
| Build command | `npm run build:static` |
| Deploy command | `npx wrangler deploy` |
| Root directory | *(leave empty)* |

There is no "build output directory" field on Workers — that lives in the
repo, as `assets.directory` in `wrangler.jsonc`, already set to `./out`.

## 3. Build variables (Settings → Build → Variables and secrets)

| Name | Value |
| --- | --- |
| `NODE_VERSION` | `22` |
| `NEXT_PUBLIC_SITE_URL` | `https://floored.<your-subdomain>.workers.dev` |

`NEXT_PUBLIC_SITE_URL` is baked into the page at build time; without it the
share card and the canonical link point at `http://localhost:3000`. You only
learn the hostname after the first deploy — set it then and **redeploy**.

These are *build* variables, under Settings → Build. The Worker's own
Variables & Secrets are runtime values and a static site never reads them.

## 4. Stop it building every lane branch

Cloudflare's free tier gives **3,000 build minutes/month**, **one concurrent
build** and a 20-minute build timeout. (Vercel's is 6,000 minutes. The often
quoted "500" is Pages' *builds* per month, a different product and a different
unit.) With four lanes pushing constantly, this is the `ignoreCommand` problem
again.

Settings → **Build** → **Branch control**:

- **Production branch**: `main`
- **Builds for non-production branches**: **unchecked**

That checkbox is the whole control the Workers dashboard gives you — it is
all-or-nothing, not Pages' include/exclude list. Unchecked means only `main`
builds, which is stricter than `vercel.json`'s `ignoreCommand` (that also lets
`dev` through).

If you want `dev` previewed as well, either tick the box only while you need
it, or set the preview trigger's `branch_includes` to `["main","dev"]` through
the API. Leaving it ticked builds **every** lane branch on every push.

## 5. Deploy

**Save and deploy.** The first build takes a few minutes (24 MB of models and
textures). Hand testers the `*.workers.dev` URL.

---

## What Cloudflare does with a request

| Request | Served how | Billed? |
| --- | --- | --- |
| `/` → `out/index.html` | static asset | no |
| `/_next/static/**` — JS, CSS, fonts | static asset | no |
| `/models/*.glb?v=<build>` | static asset | no |
| `/assets/**`, `/hdri/**`, `/icons/**`, `/og.png` | static asset | no |
| an unknown path → `out/404.html` at 404 | static asset | no |

All of it. There is no script to invoke, so the Worker's request counter
should sit at zero however many people play. If it ever moves, something has
added a Worker script.

## Caching

`public/_headers` ships to `out/_headers`, which Workers parses natively and
never serves (`/_headers` is a 404). It gives `/models`, `/assets`, `/hdri`
and `/_next/static` a one-year immutable lifetime, so a returning player
re-downloads none of the ~20 MB.

It deliberately touches **no HTML**. Cloudflare's default for an asset is
`public, max-age=0, must-revalidate` plus an ETag, and that is what `/` and
`404.html` keep, so a new deploy is visible on the next request. Never add a
`/*` rule; `npm run cf:check` asserts this against the shipped file.

Model filenames are stable across builds while their contents are not, which
is normally exactly when `immutable` is unsafe. What makes it safe is
`lib/build.ts`'s `buildStamped()`: every model URL the game asks for carries
`?v=<build rev>`, so the URL changes whenever the bundle does. On Workers
Builds that rev comes from `WORKERS_CI_COMMIT_SHA`.

## Proving it before you press the button

```
npm run build:static
npm run cf:check
```

`cf:check` serves `out/` through a local implementation of the asset routing
Cloudflare documents (`test/lib/cf-assets-server.mjs`: auto-trailing-slash,
404-page, `_headers` parsed not served) and then drives the real game in it —
menu → DRIVE → a lap of the corridor — with the whole network log and console
recorded. It fails on any 404, any console error, or any immutable header that
reaches HTML.

Last green run: the world built from the exported assets, nine stations driven
at 144 km/h with 81 traffic cars, and **160 responses off the export — 159×200
and one 404**, that one being the Vercel Analytics script below. Captures land
in `test/artifacts/static-export-lap.png` and `static-export-404.png`.

---

## The old Vercel URL

**Leave the Vercel project alone for the beta.** It is the fallback, and this
branch still builds and deploys there unchanged: `vercel.json` and its
`ignoreCommand` are untouched, and a plain `next build` with no `NEXT_OUTPUT`
still produces the server build. One branch, two hosts.

Once Cloudflare has proved itself, add one redirect to `vercel.json` so links
already handed out follow to the new host:

```json
"redirects": [
  { "source": "/(.*)", "destination": "https://floored.<subdomain>.workers.dev/$1", "permanent": false }
]
```

Keep it `"permanent": false` until you are sure — a permanent redirect is
cached by browsers and is painful to take back.

---

## Two things that behave differently on Cloudflare

- **Vercel Web Analytics stops working.** `<Analytics />` in `app/layout.tsx`
  injects `/_vercel/insights/script.js`, which only exists on Vercel. On
  Cloudflare that path is answered with the 404 page, so the browser logs one
  console error per load. It is the only 404 in a full run of `cf:check`.
  Harmless and still free (it is a static-asset response), but noisy — the fix
  is to drop that one line, or render it only when `VERCEL` is set. PostHog is
  unaffected.
- `/models/*` gets the immutable header whether or not the URL carries the
  `?v=` stamp, because a `_headers` rule cannot match on a query string.
  `vercel.json` already does the same in production today, so nothing changes;
  it is only looser than `next.config.mjs`'s `has: [{ type: "query", key: "v" }]`.

## Limits worth knowing (free plan)

| | |
| --- | --- |
| Static asset requests | free, unlimited |
| Worker invocations | 100,000/day — this project uses none |
| Files per Worker version | 20,000 (this export: 177) |
| Individual file size | 25 MiB (largest here: 5.4 MiB) |
| `_headers` rules | 100 (this file: 4) |
| Build minutes | 3,000/month, 1 concurrent, 20-minute timeout |

## What has NOT been verified

Nobody has deployed this. The sandbox these changes were made in cannot reach
`api.cloudflare.com`, `dash.cloudflare.com` or `*.workers.dev`, and holds no
Cloudflare credentials, so `wrangler deploy` has never run and the config has
never been read by Cloudflare's own parser. Everything above is from
Cloudflare's current documentation plus a local implementation of the routing
it describes. First deploy is the real test — watch for:

- the dashboard rejecting `wrangler.jsonc` (comments in JSONC are fine for
  Wrangler, but the dashboard's own preview of the file may not render them);
- `assets.directory` resolving relative to the wrong root if a root directory
  is ever set;
- the Worker's request counter moving at all. It should not.
