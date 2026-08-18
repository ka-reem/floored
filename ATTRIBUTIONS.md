# Attributions

Third-party assets bundled in this repository, with the licence each was
obtained under. Most assets are CC0 / public domain; assets requiring credit
are identified explicitly below so the provenance of every shipped asset is
auditable.

## NPC vehicle bodyshells — `public/models/cars/*.glb`

| | |
|---|---|
| Asset | Orchids Simulator Traffic Car Pack |
| Author | SphereBall20 (@playmode280513) |
| Licence | **CC BY 4.0** — commercial use and modification permitted with credit |
| Source | https://sketchfab.com/3d-models/orchids-simulator-traffic-car-pack-2fc5970d5ba2415fa98ec98b8801e794 |

The entire NPC roster ships from this one pack — nine styles: `hybrid`,
`sedan`, `compact`, `suv`, `taxi`, `police`, `van`, `truck`, `bus`. The 26 MB
source scene is not shipped. The offline `tools/build-orchids-models.mjs` bake
selects the nine unnamed source nodes by index, removes their wheel geometry
in favor of the fleet's shared instanced wheels, resizes each source 1K color
texture to an embedded 512px JPEG (metallic-roughness, where the source has
one, to 256px), and fits each body to the game's existing dimensions. The
four passenger cars sample their tail-light glow anchors from the texture's
actual red lens regions; the other five use configured anchors. The taxi is
the pack's red sedan with a hue rotation baked into its texture. Each style
is a single instanced draw call.

The nine baked models total about 1.3 MB on disk. Their base-colour and
metallic-roughness maps occupy roughly 14 MB of uncompressed GPU memory at
runtime including mipmaps.

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
(`https://api.polyhaven.com/files/<slug>`) at 2K, `.hdr` (Radiance) format.
Source: https://polyhaven.com/

| File | Asset | Item page |
|---|---|---|
| `cobblestone_street_night_2k.hdr` | **Shanghai Bund** (see note) | https://polyhaven.com/a/shanghai_bund |
| `modern_evening_street_2k.hdr` | Modern Evening Street | https://polyhaven.com/a/modern_evening_street |

Used as an environment map (PMREM) for car-paint specular reflections, not as
a visible skybox — 2K is sufficient at that role.

**Note on the filename:** the bytes at `cobblestone_street_night_2k.hdr` are
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
- Kenney's "Car Kit" (CC0) is exterior-only, no interiors — not applicable.
- A Sketchfab "Lotus 7 (CC0)" model is mislabeled: its actual displayed
  license is CC-BY 4.0, and it's an open-cockpit spaceframe racer (no
  dashboard/cabin) at 2.9M triangles — ruled out on both license-labeling
  and shape/budget grounds.

Full detail on everything evaluated (including PBR texture and HDRI
alternatives not chosen) is in `public/assets-staging/CATALOG.md`, which sits
outside the live asset paths and is not itself shipped.
