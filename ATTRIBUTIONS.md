# Attributions

Third-party assets bundled in this repository, with the licence each was
obtained under. Most assets are CC0 / public domain; assets requiring credit
are identified explicitly below so the provenance of every shipped asset is
auditable.

## NPC vehicle bodyshells — `public/models/cars/*.glb`

**Current state (2026-08-29): eight of the nine styles ship from the Orchids
pack below; only `bus` ships from the 2026-08-28 hi-fi bake.** The hi-fi
fleet lasted one evening on the road: the owner sent taxi/police/van back to
the Orchids bakes the same day (`fc4fda1` — the civil-pack versions read
"glitched and angled"), then sedan/hybrid/compact/suv (`8f85877` — "the old
bakes read better"), and the desktop HD upgrade parked with them
(`public/models/cars-hd/` deleted, `HD_STYLES` emptied in
`game/npcmodels.ts`; the pipeline and tier gate remain for a future bake).

### `bus` — the one shipping hi-fi bake

| | |
|---|---|
| Asset | Generic civil service vehicles pack (the bus) |
| Author | comrade1280 |
| Licence | **CC BY 4.0** — commercial use and modification permitted with credit |
| Source | https://sketchfab.com/3d-models/8ff2a13f30914932a70c7950cfa58465 |

Baked by `tools/build-hifi-models.mjs`: interiors and occluded geometry
removed by a multi-view visibility pass, authored wheels kept welded to the
shell, packed onto a 512px JPEG atlas with quantized vertex attributes.
Rebuild (donor .gltf exports unzipped one-per-directory, not in the repo):

    node tools/build-hifi-models.mjs --dl <donor-dir>          # BASE fleet
    node tools/build-hifi-models.mjs --dl <donor-dir> --hd \
        sedan hybrid compact suv                               # HD upgrade (parked)

### Baked 2026-08-28, no longer shipped (kept for provenance — the files
remain in git history)

| Style | Donor | Author | Licence | Source |
|---|---|---|---|---|
| sedan | Toyota Camry 2020 | ItsDiyor | CC BY 4.0 | https://sketchfab.com/3d-models/236a5a6e2fa6420fbdf641f4800cd544 |
| hybrid | Toyota Prius 2020 | ItsDiyor | CC BY 4.0 | https://sketchfab.com/3d-models/ad0d925cb51040798d96f166db8c7f80 |
| compact | Volkswagen Golf GTI 2021 | ItsDiyor | CC BY 4.0 | https://sketchfab.com/3d-models/82a55610817646539ce699a6aaa5dda0 |
| suv | Toyota Highlander 2020 | ItsDiyor | CC BY 4.0 | https://sketchfab.com/3d-models/ff144d062f244a3ebfae71bc2a41564b |
| taxi, police, van | Generic civil service vehicles pack | comrade1280 | CC BY 4.0 | https://sketchfab.com/3d-models/8ff2a13f30914932a70c7950cfa58465 |

## The Orchids fleet (eight of nine styles) — `public/models/cars/*.glb`

| | |
|---|---|
| Asset | Orchids Simulator Traffic Car Pack |
| Author | SphereBall20 (@playmode280513) |
| Licence | **CC BY 4.0** — commercial use and modification permitted with credit |
| Source | https://sketchfab.com/3d-models/orchids-simulator-traffic-car-pack-2fc5970d5ba2415fa98ec98b8801e794 |

Eight of the nine roster styles ship from this one pack — `hybrid`, `sedan`,
`compact`, `suv`, `taxi`, `police`, `van`, `truck` (`bus` is above). The 26 MB
source scene is not shipped. The offline `tools/build-orchids-models.mjs` bake
selects the nine unnamed source nodes by index, removes their wheel geometry
in favor of the fleet's shared instanced wheels, resizes each source 1K color
texture to an embedded 512px JPEG (metallic-roughness, where the source has
one, to 256px), and fits each body to the game's existing dimensions. The
four passenger cars sample their tail-light glow anchors from the texture's
actual red lens regions; the other five use configured anchors. The taxi is
the pack's red sedan with a hue rotation baked into its texture. Each style
is a single instanced draw call.

The nine shipped models (these eight plus the hi-fi bus) total about 1.4 MB
on disk. Their base-colour and metallic-roughness maps occupy roughly 14 MB
of uncompressed GPU memory at runtime including mipmaps.

An earlier fleet used six additional bodyshells from rgsdev's CC0 "Free Low
Poly Vehicles Pack" (https://opengameart.org/content/free-low-poly-vehicles-pack,
baked by `tools/build-npc-models.mjs`); none of those remain in the shipped
assets. There are no procedural NPC car bodies any more, and the `bike` and
`kei` styles were retired.

## PBR road/ground textures — `public/assets/pbr/*`

All sourced from **ambientCG.com**, released **CC0 1.0 (Public Domain)** — no
attribution legally required. Fetched via ambientCG's public JSON/CSV API at
1K resolution, then re-encoded (JPEG quality 80 for albedo/roughness/AO,
quality 82–90 for normals, normal maps additionally downsized to 768×768) to
fit a web-delivery size budget. Source: https://ambientcg.com/

| Directory | ambientCG asset | Item page | Maps kept | Used for |
|---|---|---|---|---|
| `asphalt/` | Asphalt031 (clean/fresh) | https://ambientcg.com/a/Asphalt031 | albedo, normal, rough, ao | town streets |
| `asphalt_worn/` | Asphalt026C (cracked/damaged) | https://ambientcg.com/a/Asphalt026C | albedo, normal, rough, ao | highway deck + ramps (falls back to `asphalt/` if missing) |
| `concrete/` | Concrete033 | https://ambientcg.com/a/Concrete033 | albedo, normal, rough, ao | deck fascia, parapets, ramp skirts, tunnel walls/ceiling |
| `guardrail/` | Metal032 | https://ambientcg.com/a/Metal032 | albedo, normal, rough, metal | **not guardrails** — this world has no guardrail/railing geometry (concrete parapets throughout). Retargeted to street furniture instead: lamp masts, signal poles, gantry legs (`mats.pole`). Directory kept as `guardrail/` for continuity with the download; see the load-site comment in the renderer for the mismatch. |

Displacement maps were provided by ambientCG but intentionally dropped —
the PBR loader has no parallax/displacement stage, so they'd be dead weight.
AO maps are on disk but not sampled (three.js reads `aoMap` from a second UV
channel this geometry doesn't have; the effect would be near-invisible on
these flat surfaces anyway, so it wasn't worth adding one).

A sixth set, `lanemarks/` (ambientCG RoadLines001, a photo decal atlas of
painted lane stripes), was downloaded but **not shipped**: this world builds
lane markings as per-lane geometry (stripe quads from the highway corridor's
lane schedule) with procedural paint-wear erosion, not as a texture, so a
photo atlas had nowhere to map onto. Removed from `public/assets/pbr/`.

Each set follows a fixed filename contract so the loader can `fetch()` blind
and fall back to the existing procedural canvas textures if a file is
missing:

```
public/assets/pbr/<set>/albedo.jpg   (required)
public/assets/pbr/<set>/normal.jpg   (OpenGL/+Y convention)
public/assets/pbr/<set>/rough.jpg
public/assets/pbr/<set>/ao.jpg       (optional, present but unused — see above)
public/assets/pbr/<set>/metal.jpg    (optional — guardrail/ only)
```

## Highway world-dressing PBR textures — `public/assets/pbr/*` (wave 2)

All sourced from **ambientCG.com**, **CC0 1.0 (Public Domain)** — no
attribution legally required. Recompressed to JPEG for the size budget; the
two hero sets seen closest to the camera (fence albedo/opacity, tunnel tile
and canopy corrugation albedo/normal) ship at 2K, everything else at 1K or
512. Same filename contract as the road sets, plus `alpha.jpg` for cutout
opacity maps.

| Directory | ambientCG asset | Item page | Maps kept | Used for |
|---|---|---|---|---|
| `fence/` | Fence007A | https://ambientcg.com/a/Fence007A | albedo, alpha, normal, rough, metal | perforated-steel sound-barrier panels on the parapets (alphaTest cutout) |
| `tile/` | Tiles036 | https://ambientcg.com/a/Tiles036 | albedo, normal, rough | tunnel wall tiling |
| `corrugated/` | CorrugatedSteel009 | https://ambientcg.com/a/CorrugatedSteel009 | albedo, normal, rough, metal | toll canopy roof |
| `plates/` | MetalPlates003 | https://ambientcg.com/a/MetalPlates003 | albedo, normal, rough, metal | toll canopy fascia |
| `walkway/` | MetalWalkway012 | https://ambientcg.com/a/MetalWalkway012 | albedo, alpha, normal, rough | gantry catwalk decking (alphaTest cutout) |

## Road-realism photo decals — `public/assets/decals/*`

All sourced from **ambientCG.com**, **CC0 1.0 (Public Domain)** — no
attribution legally required; provenance recorded (added to this file
2026-08-29 — the assets shipped earlier without an entry). Each ships as a
colour JPG plus a separate grayscale opacity JPG (JPG carries no alpha; the
pair costs a fraction of one PNG), loaded by `game/world/decaltex.ts` and
scattered by `game/world/decals.ts`.

| Files | ambientCG asset | Item page | Used for |
|---|---|---|---|
| `asphalt_damage_{col,a}.jpg` | AsphaltDamage001 | https://ambientcg.com/a/AsphaltDamage001 | cracked/patched asphalt |
| `leak_streak_{col,a}.jpg` | Leaking004 | https://ambientcg.com/a/Leaking004 | moisture streaks — tunnel walls, barrier faces |
| `oil_stain_{col,a}.jpg` | Leaking009 | https://ambientcg.com/a/Leaking009 | oil/grime pooling on asphalt |
| `manhole_{col,a}.jpg` | ManholeCover005/009/011 (one of the three — the bake is unlabelled, all CC0) | https://ambientcg.com/a/ManholeCover005 | shoulder manhole/drainage covers |

The full shortlist (including covers and road lines downloaded but not
shipped) is in `public/assets-staging/CATALOG.md` §14.

## Lens-dirt sprite — `public/assets/lens/dirt_02.png`

From **Kenney's Particle Pack** (https://kenney.nl/assets/particle-pack),
**CC0** — the pack's own `License.txt` ships alongside the file. Used as the
lens-dirt overlay layer in the post-processing composite. The rest of the
pack's evaluated sprites stayed in staging (`CATALOG.md` §15).

## Display typeface — Space Grotesk (self-hosted via `next/font`)

`app/layout.tsx` loads **Space Grotesk** (Florian Karsten, **SIL Open Font
License 1.1**) through `next/font/google`, which downloads it at build time
and self-hosts the subset — no request to Google at runtime. OFL permits
bundling; no attribution required, provenance recorded.

## Cockpit interior leather PBR textures — `public/assets/pbr/leather*`

All sourced from **ambientCG.com**, **CC0 1.0 (Public Domain)** — no
attribution legally required. Recompressed to JPEG for the size budget:
albedo and normal ship at 1K (1024×1024), roughness reduced to 512×512
(roughness is low-frequency). Normal maps are the OpenGL/+Y "NormalGL"
variant, per the loader's filename contract.

| Directory | ambientCG asset | Item page | Maps kept | Used for |
|---|---|---|---|---|
| `leather/` | Leather037 | https://ambientcg.com/a/Leather037 | albedo, normal, rough | dash pad + seat/door leather |
| `leather_quilt/` | Leather034C | https://ambientcg.com/a/Leather034C | albedo, normal, rough | quilted door inserts + armrests |

## Photoscanned world props — `public/assets/props/*`

Sourced from **Poly Haven**, **CC0 1.0 (Public Domain)**, no attribution
required. glTF (1K texture variants), textures recompressed to 512 for the
size budget. Source: https://polyhaven.com/

| Directory | Asset | Item page | Used for |
|---|---|---|---|
| `concrete-road-barrier/` | Concrete Road Barrier | https://polyhaven.com/a/concrete_road_barrier | jersey barriers at the toll island noses / shoulders (instanced, variant A) |
| `concrete-road-barrier-02/` | Concrete Road Barrier 02 | https://polyhaven.com/a/concrete_road_barrier_02 | jersey barrier variant B, alternated with A to break repetition |
| `security-light/` | Security Light | https://polyhaven.com/a/security_light | floodlight heads on the toll canopy fascia |

## Night-city HDRI — `public/hdri/*`

Sourced from **Poly Haven**, **CC0 1.0 (Public Domain)**, no attribution
required. Downloaded via Poly Haven's public files API
(`https://api.polyhaven.com/files/<slug>`) at 2K, `.hdr` (Radiance) format,
then downsampled to 512x256 for the size budget (`tools/shrink-hdri.mjs`).
Source: https://polyhaven.com/

| File | Asset | Item page |
|---|---|---|
| `cobblestone_street_night_2k.hdr` | **Shanghai Bund** (see note) | https://polyhaven.com/a/shanghai_bund |
| `modern_evening_street_2k.hdr` | Modern Evening Street | https://polyhaven.com/a/modern_evening_street |

Used as an environment map (PMREM) for car-paint specular reflections, never as
a visible skybox, and only on the player car's exterior — which `CAM_POV`, the
dashcam view the game actually ships in, hides outright (`engine.ts`
`exteriorG.visible = !inside`). So these files light nothing in the shipping
frame; they are a CHASE/HOOD nicety. `PMREMGenerator` sizes its cube at
`equirect.width / 4`, so 512x256 buys a 128px-per-face prefiltered cube, and
the 12.3 MB the pair used to cost was 28% of the whole asset footprint for
pixels no player sees. Downsampling is a box filter in linear float, so mean
radiance — the quantity `carenv.ts` rescales against the painted cube — is
preserved exactly and `envScale` is unchanged.

**Note on the filenames:** the `_2k` suffixes are historical; the shipped files
are 512x256 (see above). The bytes at `cobblestone_street_night_2k.hdr` are
the **Shanghai Bund** night-city panorama (CC0, Poly Haven). The world-dressing
wave replaced the original cobblestone street with the dense city-skyline glow,
but the loader probes a fixed URL list in `game/carenv.ts` (owned by another
lane at the time), so the swap was done at the file path the loader already
prefers. A follow-up may rename the file and the URL together. The 4K Shanghai
Bund master stays in `public/assets-staging/hdri-night/` as a future
desktop-lazy upgrade; `modern_evening_street` remains the softer fallback the
loader falls to when the primary is missing.

## Recorded audio — `public/assets/audio/*`

Real recordings behind the sampled engine, tunnel reverb, skids, crashes and
horns. All shipped files were converted offline (mono WAV,
sliced/normalized, one-shots resampled to 22.05kHz) from the staged originals
catalogued in `public/assets-staging/CATALOG.md` §18–24.

**Attribution required (CC-BY):**

| | |
|---|---|
| Asset | Car Tire Skid Squealing (`tires/skid.wav`) |
| Author | **qubodup (opengameart.org)** |
| Licence | **CC-BY 3.0** — https://creativecommons.org/licenses/by/3.0/ |
| Source | https://opengameart.org/content/car-tire-skid-squealing |
| Changes | downmixed to mono, peak-normalized |

**CC0 / public domain (no attribution required; provenance recorded):**

| Files | Asset / Author | Source |
|---|---|---|
| `engine/loop_0.wav` … `loop_3.wav` | Racing car engine sound loops, by domasx2 | https://opengameart.org/content/racing-car-engine-sound-loops |
| `engine/idle.wav` | Elantra Engine Idle and Rev, by microman502 (freesound) | https://freesound.org/people/microman502/sounds/865228/ |
| `reverb/tunnel_ir.wav` | 13.7s Boca Underpass (impulse response), by djericmark (freesound) | https://freesound.org/people/djericmark/sounds/724019/ |
| `crash/debris.wav` | crash, by Feed_ (freesound) | https://freesound.org/people/Feed_/sounds/545692/ |
| `crash/med.wav` | car crash short 1, by Logicogonist (freesound) | https://freesound.org/people/Logicogonist/sounds/807438/ |
| `crash/heavy.wav` | Crash.wav, by CogFireStudios (freesound) | https://freesound.org/people/CogFireStudios/sounds/420356/ |
| `crash/metal_*.wav`, `crash/glass_*.wav`, `crash/thud_*.wav` | Kenney Impact Sounds (CC0, License.txt in staging) | https://kenney.nl/assets/impact-sounds |
| `horns/player.wav`, `horns/npc_a.wav`, `horns/npc_c.wav` | Alfa Romeo MiTo horn, by boedie (freesound) | https://freesound.org/people/boedie/sounds/457425/ |
| `horns/npc_b.wav` | Car horn beep beep, by AmishRob (freesound) | https://freesound.org/people/AmishRob/sounds/423990/ |
| `horns/truck.wav` | Truck_horns, by ikbenraar (freesound) | https://freesound.org/people/ikbenraar/sounds/570603/ |

## Player cockpit dashboard — `public/models/cockpits/volvo-s90-full.glb`

| | |
|---|---|
| Asset | Volvo S90 Recharge (Free) |
| Author | lazercar |
| Licence | **CC BY 4.0** — commercial use and modification permitted with credit |
| Source | https://sketchfab.com/3d-models/volvo-s90-recharge-free-9462b07c10244fd4a28d86846dc9e3a9 |

The cabin the player sits in (the DASHCAM POV view and the other interior
cameras). The source is a complete car — 3,273,670 triangles across 45
textures, 3.50 GB of decoded texture — and none of it ships as authored.
`tools/build-cockpit.mjs` with `--no-clip --full-cabin --simplify` keeps
whole donor NODES: every node the widest legal camera frustum can reach is
kept entire and decimated with meshoptimizer, and nodes no legal frustum can
reach (rear bench, rear door cards, all bodywork) are dropped whole, along
with every material that went with them. Nothing is sliced, so the
Field-of-view slider is clean to its maximum. What ships is 356,880 triangles
and 21 images, 5.68 MB on disk plus a JSON sidecar of per-role bounding
boxes.

An earlier cut of the same donor (`volvo-s90.glb`, per-vertex frustum-clipped
to the dashcam lens) shipped until it printed sliced edges at wide FOV; it is
retired and recoverable per `docs/DISABLED.md` §11. Inside the tool the clip
survives for one job: the `mirror` role is still frozen to the old cut's
frustum — never rendered, only the bounding box that anchors the live mirror
glass.

Modified further at runtime (`game/cockpitmodel.ts`): the model's painted-on
instrument cluster is hidden in favour of a live one, and its centre screen is
re-textured with the game's own navigation canvas.

The 386 MB source download is not in this repository. It is listed in
`public/assets-staging/CATALOG.md` with the URL and licence above; rebuild the
shipped GLB with (the command recorded in `.gitignore`):

    node tools/build-cockpit.mjs public/assets-staging/volvo_s90_recharge_free.glb \
      --out volvo-s90-full --no-clip --full-cabin --simplify --meshopt \
      --tex 2048 --jpeg-q 82

Sibling asset from the same author's page: the description links a Google
Drive `.blend` bundle offered as a higher-quality alternative to Sketchfab's
own export. It is not used here — the shipped cut comes from the Sketchfab
glTF export.

## Player car body — `public/models/player/volvo-s90-body-lite.glb`

Same donor, same author, same CC BY 4.0 licence as the cockpit above — see that
section for the source URL. This is the other half of the car: the exterior
shell the chase cameras see, which `tools/build-cockpit.mjs` throws away.

Built by `tools/build-car-body.mjs` (meshoptimizer edge-collapse simplification
under a per-part budget) in REAR-BIASED form: this asset is only ever seen by
cameras that frame the car from behind or at a rear 3/4 — the chase cam, the
live mirror, the garage card — so `--rear-bias` pins the tail-lamp stack,
trunk, rear bumper and rear badges near donor resolution (the rear cluster
holds ~74k of the file's triangles, against ~14k of 88k in the previous even
cut) while the front and sides take the decimation. Rear-lamp textures stay at
256 px webp, everything else at 128 px. `--strip` drops the donor's wheels,
tyres, brake discs, calipers and hubs at selection time, because the game keeps
its own — they steer and spin, and the donor's would not (the old ad-hoc
post-build strip left one stray brake-disc mesh; this one leaves none). The
hood is the one front part pinned high (weight 8): `game/player.ts` lifts its
connected component into the shipping DASHCAM view. Encoded straight to
meshopt: 131,376 triangles, 23 draw calls, 9 textures, 0.78 MB on disk.

Loaded by `game/bodymodel.ts`. It and the donor dash are two cuts of the same
car and now belong to the same garage entry: the **VOLVO S90**, which is the
only id in `BODY_MODEL` (`game/player.ts`) and the only one in `COCKPIT_MODEL`.
Picking that car in the garage is what shows both; picking the KAZE GT shows
neither. (There used to be a `J` key A/B against the procedural car, off one
`Game.dashImported` flag — retired, because the choice is the garage's now.)
The body is invisible in the shipping DASHCAM view, which hides the exterior
group entirely. Fitted to the Volvo's shell box by a non-uniform scale at
runtime — very nearly an identity scale, since that shell is the real car's
4.96 x 1.88 x 1.44 — and lined up on the axles so the game's own wheels sit in
its arches.

Rebuilt 2026-08-28 from the donor's Sketchfab glTF export (`scene.gltf` +
`scene.bin` + `textures/`, 379 MB on disk — `NodeIO` reads the .gltf form
directly, no .glb repack needed) in one command, no post-steps:

    node --max-old-space-size=12288 tools/build-car-body.mjs <scene.gltf> \
      --out volvo-s90-body-lite --exterior --strip --rear-bias \
      --tris 120000 --tex 128 --tex-rear 256 --compress meshopt

The donor download is not committed (gitignored); the source URL and licence
are above. Full before/after numbers and renders:
`docs/handoff/reports/volvo-body-local.md` and
`docs/gallery/img/volvo-rear-{before,after}.webp`.

## Sourcing notes / other candidates evaluated but not shipped

A parallel hunt for realistic car **interior** models (dashboard/wheel/seats,
for the driver's-eye cockpit view) did not clear the bar for this repo:

- The best candidate found — "Sedan (glb format, with interior)" by 3DHA,
  CC-BY 4.0, 18.2k triangles, https://sketchfab.com/3d-models/sedan-glb-format-with-interior-fe0d953112044d6893d04dbbec75ac82
  — could not be downloaded in this environment (Sketchfab's download API
  requires an authenticated account/token; no browser automation available
  here). Left unshipped; would need a manual download by someone with a free
  Sketchfab account, then the CC-BY attribution added here.
- OpenGameArt's CC0 "Cartoon Vehicles Pack 1" (https://opengameart.org/content/cartoon-vehicles-pack-1)
  has real interior geometry (dashboard, seats, steering wheel) but is
  stylized/cartoon, not a match for this game's realism target — not shipped.
  Superseded in any case by the Volvo S90 cut above; the 2026-08-19 re-hunt
  and its full shortlist are recorded in `public/assets-staging/CATALOG.md`.
- Kenney's "Car Kit" (CC0) is exterior-only, no interiors — not applicable.
- A Sketchfab "Lotus 7 (CC0)" model is mislabeled: its actual displayed
  license is CC-BY 4.0, and it's an open-cockpit spaceframe racer (no
  dashboard/cabin) at 2.9M triangles — ruled out on both license-labeling
  and shape/budget grounds.

Full detail on everything evaluated (including PBR texture and HDRI
alternatives not chosen) is in `public/assets-staging/CATALOG.md`, which sits
outside the live asset paths and is not itself shipped.
