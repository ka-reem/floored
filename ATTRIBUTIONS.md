# Attributions

Third-party assets bundled in this repository, with the licence each was
obtained under. Most assets are CC0 / public domain; assets requiring credit
are identified explicitly below so the provenance of every shipped asset is
auditable.

## NPC vehicle bodyshells — `public/models/cars/*.glb`

### Original six traffic styles

| | |
|---|---|
| Asset | Free Low Poly Vehicles Pack |
| Author | Raphael Gonçalves (rgsdev) |
| Licence | **CC0 1.0 (Public Domain)** — "Public domain and free to use on any project, even commercial. Credit is not required." (`License.txt`, included in the download) |
| Source | https://opengameart.org/content/free-low-poly-vehicles-pack |
| Download | https://opengameart.org/sites/default/files/free_low_poly_vehicles_pack_by_rgsdev.zip |
| Mirror | https://rgsdev.itch.io/free-low-poly-vehicles-pack |
| Author's site | https://www.patreon.com/rgsdev |

The rgsdev pack contains generic, unbranded vehicle silhouettes — no
real-world manufacturer, model, badge or trade dress is depicted or implied.

Six of the pack's twenty-one vehicles remain in use:

| style | source model | notes |
|---|---|---|
| `kei` | Van | fitted to kei dimensions — reads as a kei van |
| `van` | Van | |
| `taxi` | Taxi | |
| `police` | Police Sedan | black/white livery kept; white takes the paint slot |
| `truck` | Truck | a bobtail cab; the cargo box is added by the bake |
| `bus` | Bus | |

`bike` has no model in the pack and stays procedural.

### How the original six GLBs were produced

The source pack is FBX. The committed GLBs were baked from it by
`tools/build-npc-models.mjs`, which is run offline, not at build time:

```sh
unzip free_low_poly_vehicles_pack_by_rgsdev.zip
node tools/build-npc-models.mjs "Free Low Poly Vehicles Pack by Rgsdev"
```

The bake fits each vehicle to the L/W/H the game already uses (the source
proportions are cartoonish — a 2.8 m wide sedan), drops the wheels in favour of
the fleet's shared instanced wheel, collapses the material slots into a baked
vertex colour plus the `paintable` mask the NPC shader reads, and records the
lamp and wheel anchors. See the header comment in that file for the details.

### Four everyday passenger styles

| | |
|---|---|
| Asset | Orchids Simulator Traffic Car Pack |
| Author | SphereBall20 (@playmode280513) |
| Licence | **CC BY 4.0** — commercial use and modification permitted with credit |
| Source | https://sketchfab.com/3d-models/orchids-simulator-traffic-car-pack-2fc5970d5ba2415fa98ec98b8801e794 |

Four ordinary passenger vehicles from the pack replace the `hybrid`, `suv`,
`compact`, and `sedan` styles. The 26 MB source scene is not shipped. The
offline `tools/build-orchids-models.mjs` bake selects only those four unnamed
nodes, removes their wheel geometry in favor of the fleet's shared instanced
wheels, resizes each source 1K color texture to an embedded 512px JPEG (and its
metallic-roughness map to 256px), and fits each body to the game's existing
dimensions. Tail-light glow anchors are sampled from each texture's actual red
lens regions. Each style still uses its existing single instanced draw call.

The four baked models contain 5,452 triangles and total about 580 KB. Their
base-colour and metallic-roughness maps occupy about 7 MB of uncompressed GPU
memory at runtime including mipmaps.

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
| `cobblestone_street_night_2k.hdr` | Cobblestone Street Night | https://polyhaven.com/a/cobblestone_street_night |
| `modern_evening_street_2k.hdr` | Modern Evening Street | https://polyhaven.com/a/modern_evening_street |

Used as an environment map (PMREM) for car-paint specular reflections, not as
a visible skybox — 2K is sufficient at that role. `cobblestone_street_night`
is the recommended default (higher-contrast lamp highlights read better on
curved metal at speed); `modern_evening_street` is a softer alternate.

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
