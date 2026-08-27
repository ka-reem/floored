# NEON EXPRESSWAY — 首都高 Night Drive (v3)

Night driving through a **procedurally generated Japanese town** and its elevated
expressway. Sim-grade tire physics, dense AI traffic that crashes and wrecks,
rain, neon, fog, and a garage of two cars (three more coming).

Built with **Next.js + Three.js**, deployable to Vercel as-is.

## Development gallery

[`docs/gallery/index.html`](docs/gallery/index.html) — 87 renders from the work
itself, in eleven chapters: the A/B that retired the frustum-clipped dashboard,
the hole hunts across every screen shape, the clay passes that found the camera
sitting inside the driver's seat, the decimation ladder, the procedural sky, and
the asset budget that governed all of it. Clone and open it in a browser; it is
a single self-contained page with no build step. It is excluded from the Vercel
deployment via `.vercelignore` and is not part of the shipped game.

## Run locally

```bash
npm install
npm run dev        # http://localhost:3000
```

## Deploy to Vercel

Push this repo and import it in Vercel — no configuration needed
(standard Next.js app, fully static + client-side WebGL).

## Test

```bash
npm run smoke      # headless-Chrome boot + drive + crash + screenshots
                   # artifacts land in test/artifacts/
```

## Controls

| Key | Action |
| --- | --- |
| W / S | throttle · brake & reverse |
| A / D | steer |
| Space | handbrake |
| C | camera (chase → cockpit → hood) |
| B | look back |
| Q / E | turn signals · F horn |
| L | headlights · M mirrors · X minimap |
| R | rain · T time-lapse · V dashcam grade |
| N | reset to nearest road |
| Esc | pause menu |

## Structure

```
app/                 Next.js app shell (page, layout, styles)
components/GameApp.tsx   React UI: menus, garage, settings, HUD
game/
  engine.ts          conductor: loop, camera, weather, HUD, debug API
  world/             seeded town generator (terrain, road graph, meshes),
                     elevated expressway + exit/off-ramp treatment, sky
  traffic.ts         pooled NPC fleet: road-graph AI, IDM, wreck physics
  physics.ts         Pacejka bicycle-model player physics (per-car specs)
  carshape.ts/player.ts/cockpit.ts   parametric car bodies + RHD cockpit
  post.ts            HDR pipeline: bloom, ACES, grade, FXAA, motion blur
racing-game.html     the legacy v2 single-file build (kept for reference)
```

The town is generated from a seed (Settings → NEW TOWN regenerates it):
jittered street grid with pruned links, curved edges, rolling terrain the
roads conform to, and dense buildings placed along every street.
