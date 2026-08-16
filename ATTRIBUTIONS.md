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
