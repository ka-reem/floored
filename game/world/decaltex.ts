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
  // Brightened per user call — the sodium pools should visibly light the
  // street: hotter core, fuller mid skirt; the zero edge stays.
  const g = ctx.createRadialGradient(64, 64, 2, 64, 64, 62);
  g.addColorStop(0, "rgba(255,219,158,0.78)");
  g.addColorStop(0.35, "rgba(255,207,142,0.46)");
  g.addColorStop(0.7, "rgba(255,192,122,0.17)");
  g.addColorStop(1, "rgba(255,190,120,0)");
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
