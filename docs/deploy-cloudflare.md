# Deploy to Cloudflare Pages

Everything in the repo is ready. This is the button press.

## 1. Create the project

dash.cloudflare.com → **Workers & Pages** → **Create** → **Pages** →
**Connect to Git** → `ka-reem/racing-game`.

## 2. Build settings

| Field | Value |
| --- | --- |
| Framework preset | **None** |
| Build command | `npm run build:static` |
| Build output directory | `out` |
| Root directory | *(leave empty)* |
| Production branch | `main` |

## 3. Environment variables (Production **and** Preview)

| Name | Value |
| --- | --- |
| `NODE_VERSION` | `22` |
| `NEXT_PUBLIC_SITE_URL` | `https://<your-project>.pages.dev` |

`NEXT_PUBLIC_SITE_URL` is not optional. It is baked into the page at build
time; without it the share card and canonical link point at
`http://localhost:3000`. You can only fill it in once Cloudflare has told you
the project's hostname — so set it after the first build and **redeploy**.

## 4. Stop it building every lane branch

This is the Vercel storage blow-up all over again if you skip it.

Project → **Settings** → **Build** → **Branch control** → Preview branches →
**Include only certain branches** → `dev`.

`main` (production) and `dev` (preview) build. Nothing else does — the same
split `vercel.json`'s `ignoreCommand` does today.

## 5. Deploy

**Save and Deploy.** First build is a few minutes (25 MB of models and
textures). Hand testers the `*.pages.dev` URL.

---

## The old Vercel URL

**Leave the Vercel project alone for the beta** — it is the fallback if
Cloudflare misbehaves, and this branch still builds and deploys there
unchanged. Once Cloudflare has proved itself, add one redirect to
`vercel.json` so every link you have already handed out follows to the new
host (no domain needed):

```json
"redirects": [
  { "source": "/(.*)", "destination": "https://<your-project>.pages.dev/$1", "permanent": false }
]
```

Keep it `"permanent": false` until you are sure — a permanent redirect is
cached by browsers and is painful to take back.

---

## What is already done in the repo

- `npm run build:static` = PWA icons → `NEXT_OUTPUT=export next build
  --webpack` → drop `out/assets-staging` (4.1 MB of donor source that
  `.vercelignore` keeps off Vercel and Cloudflare has no equivalent for).
- `public/_headers` ships the one-year immutable caching for `/models`,
  `/assets`, `/hdri` and `/_next/static` — the `vercel.json` rules, in
  Cloudflare's syntax. Without it every visit re-downloads ~20 MB.
- No `_redirects` file, on purpose: Pages already answers an unknown path
  with `out/404.html` at status 404, which is exactly what Vercel does.
- `next build` with no env var is untouched, so Vercel keeps deploying from
  this same branch.

## Two things that behave differently on Cloudflare

- **Vercel Web Analytics stops working.** `<Analytics />` in
  `app/layout.tsx` fetches `/_vercel/insights/script.js`, which only exists
  on Vercel — on Pages it 404s once per page load (console noise, nothing
  else). PostHog is unaffected. Removing that one line is the fix.
- `/models/*` gets the immutable header whether or not the URL carries the
  `?v=` build stamp — `_headers` cannot match on a query string. This is
  what `vercel.json` already does in production today, so nothing changes;
  it is only stricter than `next.config.mjs`'s rule.
