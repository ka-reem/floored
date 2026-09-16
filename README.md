# FLOORED — 首都高 Night Drive (v3)

> **Public mirror.** This is a cleaned copy of a private working repo. The
> commit history is the real one — 770 commits over 32 days — but the
> development gallery (~42 MB of test renders), internal working notes and the
> Capacitor iOS project are not carried here, and the analytics key now comes
> from the environment. Nothing about the game code itself was changed to
> publish it.
>
> Much of this was written with AI assistance; the commits say so where that is
> the case.

Night driving through a **procedurally generated Japanese town** and the
elevated expressway looping above it — a browser take on the "No Hesi" vibe.
Sim-grade tire physics, 120 cars of AI traffic that yield, crash and wreck, an
optional rival that carves through the stream, a No Hesi score that builds on
speed and near misses, rain, neon, fog, and a garage of two cars (three more
teasing from behind COMING SOON badges).

The 4 km lap reads as six places, not one corridor: a floodlit harbor wharf, a
rhythm of lit overpasses, a mid-rise canyon through town, high-mast interchange
clusters, a foreground industrial yard with a burning flare stack, and a neon
canyon over the post-toll straight — plus **EXIT 4 峠 Tōge**, a curvy two-lane
mountain road with oncoming traffic to dodge, off the loop and back onto it.

Built with **Next.js + Three.js**, deployable to Vercel as-is. Plays with
keyboard, gamepad, or touch — phones get steering pucks/wheel/tilt and a ⋯
drawer holding every secondary control.

## Development gallery

The private repo carries `docs/gallery/index.html` — 184 renders from the work
itself in 32 chapters, each one a before/after of a specific change with the
measurements that justified it. It is ~42 MB of WebP and is not mirrored here.

## Run locally

```bash
npm install
npm run dev        # http://localhost:3000
```

## Deploy to Vercel

Push this repo and import it in Vercel — no configuration needed
(standard Next.js app, fully static + client-side WebGL). The one line of
`vercel.json` config disables auto-deploy on `main` only; feature branches
still get preview URLs, and production ships by manual promote.

## Test

```bash
npm run smoke      # headless-Chrome boot + drive + crash + screenshots
                   # artifacts land in test/artifacts/
npm run engine-rpm # asserts the engine flywheel model across the roster
node test/size-budget.mjs   # committed assets vs the 15/30 MB budgets
```

Those are the wired-up entry points; `test/` holds ~47 scripts in total
(standalone sims, browser assertion checks, and investigation instruments),
run by hand as needed.

## Controls

| Key | Action |
| --- | --- |
| W / S | throttle · brake & reverse |
| A / D (or arrows) | steer |
| Space | handbrake |
| C | camera (chase → cockpit → hood → console → **dashcam**, the default) |
| B | look back |
| Q / E | turn signals · F horn |
| G | high beams — tap to flash-to-pass, hold 2 s to latch |
| L | headlights · M mirrors · X minimap |
| R | rain · T time-lapse · V dashcam grade |
| N | reset to nearest road · K test mode |
| I | cabin light (desktop) · H controls overlay |
| P / , / . | music play-pause · prev / next track (desktop) |
| Esc | pause menu |

A connected gamepad drives the same controls; on touch, the ◀ ▶ telltales are
the signal switches and everything else secondary lives in the ⋯ drawer.

## Structure

```
app/                 Next.js app shell (page, layout, styles, design tokens)
components/GameApp.tsx   React UI: menus, garage, settings, HUD, touch drawer
game/
  engine.ts          conductor: loop, cameras, weather, HUD, No Hesi score,
                     debug API
  world/             seeded town generator (terrain, road graph, meshes),
                     elevated expressway + ramps + bypass viaduct, the
                     EXIT 4 mountain road, roadside districts, sky, aurora,
                     night clouds
  traffic.ts         pooled NPC fleet: road-graph AI, IDM, courtesy/yielding,
                     wreck physics, the rival
  physics.ts         Pacejka bicycle-model player physics (per-car specs)
  carshape.ts/player.ts/cockpit.ts   parametric car bodies + RHD cockpit;
                     the Volvo's donor cabin and exterior swap in over them
  post.ts            HDR pipeline: bloom, ACES, grade, FXAA, motion blur,
                     and the dashcam degrade chains
racing-game.html     the legacy v2 single-file build (kept for reference)
```

The town is generated from a seed (Settings → NEW TOWN regenerates it):
jittered street grid with pruned links, curved edges, rolling terrain the
roads conform to, and dense buildings placed along every street. The
expressway's lane schedule is seeded too — three to five lanes, two named
tunnels, and the same road on every lap thanks to the splice discipline.
