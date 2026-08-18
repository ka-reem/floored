import * as THREE from "three";

/* Texture generation + loading for the world-dressing decal pass (Lane H).

   Lives in its own module rather than textures.ts (another lane owns edits
   there). Two kinds of texture come out of here:

   - canvas-generated gradients (the streetlight ground-pool ellipse), and
   - the downsized photo decals under public/assets/decals/, which ship as a
     colour JPG plus a separate grayscale opacity JPG (JPG carries no alpha
     channel; the pair costs a fraction of one PNG).

   Loading is failure-tolerant the same way highway.ts's loadProp is: a decal
   whose textures never arrive simply never calls back, and the world stands
   without it. */

/** Radial sodium-pool gradient for the streetlight ground pools. Shared by the
    town lamps (townmesh.ts) and the elevated deck lamps (highway.ts) — both
    meshes render it through the ONE material instance the engine's day/night
    pass drives, so opacity and tint stay centralized. The two-knee falloff is
    what sells it: a bright core under the head, a wide soft skirt, and zero
    well inside the quad so the quad edge never prints. */
export function poolGradientTex(): THREE.Texture {
  const cv = document.createElement("canvas");
  cv.width = cv.height = 128;
  const ctx = cv.getContext("2d")!;
  /* Sampled from a smooth curve rather than set as a few hand-placed knees.
     Two reasons the old four-stop version stopped working once the deck pools
     grew to span the carriageway (POOL_A in highway.ts):
       - four linear segments stretched over ~14 m print their own knees as
         visible rings, where over ~8 m they read as one fade;
       - the POV dashcam pass crushes blacks hard (`col - .06` in post.ts), so
         a LINEAR outer ramp crosses that floor at a definite radius and clips
         to a circular edge — the pool looked scoped rather than faded.
     So: many stops, monotone and decelerating, with a deliberately long low
     tail. The tail spends most of its length near the crush floor instead of
     diving through it, which is what turns the cut-off into a fade. The skirt
     is also fuller than before at the same core level — more ground covered
     without a brighter hotspot. */
  const g = ctx.createRadialGradient(64, 64, 2, 64, 64, 62);
  const STOPS: [number, number][] = [
    [0.00, 0.78], [0.10, 0.735], [0.20, 0.665], [0.30, 0.585],
    [0.40, 0.505], [0.50, 0.425], [0.60, 0.350], [0.68, 0.293],
    [0.76, 0.236], [0.83, 0.183], [0.89, 0.132], [0.94, 0.086],
    [0.97, 0.050], [0.99, 0.022], [1.00, 0.0],
  ];
  /* Core is the warmest; the skirt cools slightly toward the edge the way a
     real sodium pool does as it thins out over grey tarmac. */
  for (const [t, a] of STOPS) {
    const r = Math.round(255), gg = Math.round(219 - 29 * t), b = Math.round(158 - 38 * t);
    g.addColorStop(t, `rgba(${r},${gg},${b},${a})`);
  }
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export interface DecalMaps {
  map: THREE.Texture;
  alphaMap: THREE.Texture;
}

function clampTex(t: THREE.Texture) {
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.anisotropy = 4;
}

/** Load a colour+opacity JPG pair; `cb` fires only when both are in.

    `softEdge` multiplies a radial falloff into the opacity mask before it
    becomes a texture. The AsphaltDamage001 scan's mask is a hard-edged full
    square (it is authored as a surface *patch*, not an overlay), and a
    hard-edged 5 m rectangle of lighter asphalt floating on the deck is
    exactly the "decal soup" look this pass must avoid — the fade dissolves
    the patch back into the deck before its border can print. */
export function loadDecalMaps(
  colUrl: string,
  alphaUrl: string,
  opts: { softEdge?: boolean },
  cb: (maps: DecalMaps) => void
) {
  let map: THREE.Texture | null = null;
  let alphaMap: THREE.Texture | null = null;
  const done = () => {
    if (map && alphaMap) cb({ map, alphaMap });
  };
  new THREE.TextureLoader().load(
    colUrl,
    (t) => {
      t.colorSpace = THREE.SRGBColorSpace;
      clampTex(t);
      map = t;
      done();
    },
    undefined,
    () => {}
  );
  if (!opts.softEdge) {
    new THREE.TextureLoader().load(
      alphaUrl,
      (t) => {
        clampTex(t);
        alphaMap = t;
        done();
      },
      undefined,
      () => {}
    );
  } else {
    const img = new Image();
    img.onload = () => {
      const cv = document.createElement("canvas");
      cv.width = img.width;
      cv.height = img.height;
      const ctx = cv.getContext("2d")!;
      ctx.drawImage(img, 0, 0);
      // multiply the mask by a radial fade: full inside ~55% radius, gone at
      // the corners. 'multiply' on a grayscale mask is exactly mask * fade.
      const g = ctx.createRadialGradient(
        cv.width / 2, cv.height / 2, Math.min(cv.width, cv.height) * 0.28,
        cv.width / 2, cv.height / 2, Math.min(cv.width, cv.height) * 0.52
      );
      g.addColorStop(0, "rgb(255,255,255)");
      g.addColorStop(1, "rgb(0,0,0)");
      ctx.globalCompositeOperation = "multiply";
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, cv.width, cv.height);
      const t = new THREE.CanvasTexture(cv);
      clampTex(t);
      alphaMap = t;
      done();
    };
    img.onerror = () => {};
    img.src = alphaUrl;
  }
}
