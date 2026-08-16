# Attributions

Third-party assets bundled in this repository, with the licence each was
obtained under. Everything here is CC0 / public domain: no attribution is
legally required, but it is recorded so the provenance of every shipped asset
is auditable.

## NPC vehicle bodyshells — `public/models/cars/*.glb`

| | |
|---|---|
| Asset | Free Low Poly Vehicles Pack |
| Author | Raphael Gonçalves (rgsdev) |
| Licence | **CC0 1.0 (Public Domain)** — "Public domain and free to use on any project, even commercial. Credit is not required." (`License.txt`, included in the download) |
| Source | https://opengameart.org/content/free-low-poly-vehicles-pack |
| Download | https://opengameart.org/sites/default/files/free_low_poly_vehicles_pack_by_rgsdev.zip |
| Mirror | https://rgsdev.itch.io/free-low-poly-vehicles-pack |
| Author's site | https://www.patreon.com/rgsdev |

The pack contains generic, unbranded vehicle silhouettes — no real-world
manufacturer, model, badge or trade dress is depicted or implied.

Ten of the pack's twenty-one vehicles are used, one per traffic style in
`game/traffic.ts`:

| style | source model | notes |
|---|---|---|
| `hybrid` | Hatchback | |
| `sedan` | Sedan | |
| `compact` | Pickup | a small pickup, for fleet variety |
| `kei` | Van | fitted to kei dimensions — reads as a kei van |
| `suv` | SUV | |
| `van` | Van | |
| `taxi` | Taxi | |
| `police` | Police Sedan | black/white livery kept; white takes the paint slot |
| `truck` | Truck | a bobtail cab; the cargo box is added by the bake |
| `bus` | Bus | |

`bike` has no model in the pack and stays procedural.

### How the shipped GLBs were produced

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
Total: 10 models, ~9.0k triangles, 553 KB.

## PBR road/ground textures — `public/assets/pbr/*`

All sourced from **ambientCG.com**, released **CC0 1.0 (Public Domain)** — no
attribution legally required. Fetched via ambientCG's public JSON/CSV API at
1K resolution, then re-encoded (JPEG quality 80 for albedo/roughness/AO,
quality 82–90 for normals, normal maps additionally downsized to 768×768) to
fit a web-delivery size budget. Source: https://ambientcg.com/

| Directory | ambientCG asset | Item page | Maps kept |
|---|---|---|---|
| `asphalt/` | Asphalt031 (clean/fresh) | https://ambientcg.com/a/Asphalt031 | albedo, normal, rough, ao |
| `asphalt_worn/` | Asphalt026C (cracked/damaged) | https://ambientcg.com/a/Asphalt026C | albedo, normal, rough, ao |
| `concrete/` | Concrete033 | https://ambientcg.com/a/Concrete033 | albedo, normal, rough, ao |
| `guardrail/` | Metal032 | https://ambientcg.com/a/Metal032 | albedo, normal, rough, metal |
| `lanemarks/` | RoadLines001 | https://ambientcg.com/a/RoadLines001 | albedo, normal, rough |

Displacement maps were provided by ambientCG but intentionally dropped —
`game/mats.ts`'s PBR loader has no parallax/displacement stage, so they'd be
dead weight. Each set follows a fixed filename contract so the loader can
`fetch()` blind and fall back to the existing procedural canvas textures if a
file is missing:

```
public/assets/pbr/<set>/albedo.jpg   (required)
public/assets/pbr/<set>/normal.jpg   (OpenGL/+Y convention)
public/assets/pbr/<set>/rough.jpg
public/assets/pbr/<set>/ao.jpg       (optional)
public/assets/pbr/<set>/metal.jpg    (optional — guardrail only)
```

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
