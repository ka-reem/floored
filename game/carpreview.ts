import * as THREE from "three";
import { buildPlayerCar, hasDonorBody, type PlayerRig } from "./player";
import { carById, getCar, type CarSpec } from "./carspecs";
import { envFaceCanvas, glowTexF } from "./textures";

/* Offscreen studio renders of the player car rigs for the garage UI.
   One shared renderer/scene; results are cached per (car, paint).

   TWO PASSES for a car with an imported exterior (today: the Volvo).

   Pass one is the procedural shot, built from the car's ShellParams, rendered
   and read back synchronously. It is what every card has always been and it is
   still what goes up first — a card that starts empty and fills in a beat later
   is worse than one that improves.

   Pass two swaps in the real donor body (volvo-s90-body-lite.glb, 0.5 MB and
   already shipped for the game itself) and re-shoots the SAME frame: same
   camera solve off the same shell length, same three lights, same floor disc,
   same transparent background. That is the whole reason it is done through
   buildPlayerCar rather than by loading the GLB into a scene of its own — the
   two cards have to sit side by side, and everything about the shot except the
   bodyshell is shared code.

   The card is told about pass two through a callback rather than by polling:
   the fetch settles in a few hundred ms and the img src just changes. */

const cache = new Map<string, string>();

/** Pass-two shots, keyed by CAR ALONE and not by paint. The donor body carries
    its own baked paint and player.ts does not retint it (lightDonorBody only
    touches env/roughness), and every procedural part still on show under it —
    the four wheels, the lamp glows — is built from fixed materials rather than
    from the chosen hex. So the shot genuinely cannot vary with the swatch, and
    keying it by paint would only re-fetch and re-parse the GLB once per colour
    to produce the same PNG. See the note in GaragePanel about what that means
    for the paint row. */
const realCache = new Map<string, string>();
/** Cards waiting on a pass-two shot that is already in flight, per car. */
const realWaiting = new Map<string, Set<(url: string) => void>>();

let studio: {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  envMap: THREE.CubeTexture;
  glowTex: THREE.Texture;
  blankTex: THREE.Texture;
} | null = null;

function getStudio() {
  if (studio) return studio;
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
  renderer.setSize(480, 260);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(30, 480 / 260, 0.1, 50);

  scene.add(new THREE.AmbientLight(0x8fa3cc, 0.55));
  const key = new THREE.DirectionalLight(0xfff2e0, 1.5);
  key.position.set(4, 6, 5);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  const fill = new THREE.DirectionalLight(0x6f9dff, 0.5);
  fill.position.set(-5, 3, -2);
  const rim = new THREE.DirectionalLight(0xbfd4ff, 0.9);
  rim.position.set(0, 4, -7);
  scene.add(key, fill, rim);

  const floor = new THREE.Mesh(
    new THREE.CircleGeometry(9, 40),
    new THREE.MeshStandardMaterial({ color: 0x11141f, roughness: 0.85, metalness: 0.2 })
  );
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(floor);

  const envMap = new THREE.CubeTexture([
    envFaceCanvas(), envFaceCanvas(), envFaceCanvas(true),
    envFaceCanvas(false), envFaceCanvas(), envFaceCanvas(),
  ]);
  envMap.needsUpdate = true;
  const glowTex = glowTexF();
  const blankTex = new THREE.Texture();

  studio = { renderer, scene, camera, envMap, glowTex, blankTex };
  return studio;
}

/** Pose `rig`, solve the camera off its shell and read one PNG back. The rig
    must already be in the studio scene and is left there; both passes go
    through this so the two cards cannot drift apart on framing or exposure. */
function shoot(st: NonNullable<typeof studio>, rig: PlayerRig, spec: CarSpec): string {
  rig.headMat.emissiveIntensity = 2.2;
  rig.carGroup.rotation.y = -2.42; // front-3/4, nose toward camera-left

  const L = spec.shell.L;
  st.camera.position.set(0, L * 0.42, L * 1.62);
  st.camera.lookAt(0, spec.shell.belt * 0.55, 0);
  st.renderer.render(st.scene, st.camera);
  return st.renderer.domElement.toDataURL("image/png");
}

/** Build a second rig, wait for its donor exterior, re-shoot, hand the PNG to
    everyone waiting on this car. At most one in flight per car. */
function shootReal(spec: CarSpec, paintHex: number, cb: (url: string) => void) {
  const id = spec.id;
  const waiting = realWaiting.get(id);
  if (waiting) {
    waiting.add(cb);
    return;
  }
  const set = new Set([cb]);
  realWaiting.set(id, set);

  const st = getStudio();
  const rig = buildPlayerCar(
    st.scene, spec, paintHex, st.envMap, st.glowTex, st.blankTex, "mobile-base",
    { cabin: false },
  );
  /* HIDDEN until it is the one being photographed. This rig outlives the call
     that made it, and the studio scene is shared — another card rendering its
     own synchronous shot while this one sat there visible would get a second
     car in the frame. JS is single-threaded, so "visible only across the
     render call below" is airtight rather than merely likely. */
  rig.carGroup.visible = false;

  void rig.bodyReady.then(() => {
    let url: string | null = null;
    /* No handle ⇒ the GLB 404'd or failed to parse. Keep the procedural shot:
       the same rule the game itself follows when a donor goes missing. */
    if (rig.bodyModel) {
      rig.carGroup.visible = true;
      url = shoot(st, rig, spec);
      rig.carGroup.visible = false;
    }
    rig.dispose(st.scene);
    realWaiting.delete(id);
    if (!url) return;
    realCache.set(id, url);
    for (const f of set) f(url);
  });
}

/** Render a front-3/4 studio shot of the car; returns a PNG data URL.
 *
 *  `onReal` is optional and only ever fires for a car with an imported
 *  exterior: the returned URL is the procedural shot, and this lands later
 *  with the real-bodywork one. A caller that does not pass it gets exactly the
 *  old behaviour and starts no fetch. */
export function carPreviewURL(
  carId: string,
  paintHex: number,
  onReal?: (url: string) => void,
): string {
  /* carById, not getCar: this renders the GARAGE CARD, and a COMING SOON car
     has to be drawn as itself. getCar() would resolve every locked id to the
     fallback car and put four identical shots on the shelf. */
  const spec = carById(carId) || getCar(carId);

  const real = realCache.get(carId);
  if (real) return real;

  const k = carId + ":" + paintHex;
  let url = cache.get(k);
  if (!url) {
    const st = getStudio();
    /* Both donors OFF, said out loud. This shot is rendered and read back
       SYNCHRONOUSLY below and the rig is disposed immediately after, so
       neither fetch could arrive in time to appear in it — the cabin's 5.7 MB
       would buy nothing but a wire() call against a disposed cockpit, and the
       body's 0.5 MB is pass two's job and is cached there.

       It used to say this by asking for tier "mobile-base" and leaning on that
       row of COCKPIT_MODEL being empty. It is not empty any more (a player who
       picks the Volvo on a phone gets its real cabin now), which would have
       turned every first paint of the garage into a 5.7 MB download. An
       opt-out that lives in another file's data table is not an opt-out. */
    const rig = buildPlayerCar(
      st.scene, spec, paintHex, st.envMap, st.glowTex, st.blankTex, "mobile-base",
      { cabin: false, body: false },
    );
    url = shoot(st, rig, spec);
    rig.dispose(st.scene);
    cache.set(k, url);
  }
  if (onReal && hasDonorBody(carId)) shootReal(spec, paintHex, onReal);
  return url;
}
