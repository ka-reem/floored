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

   Pass two swaps in the real donor body (volvo-s90-body-lite.glb, 1.4 MB and
   already shipped for the game itself) and re-shoots the SAME frame: same
   camera solve off the same shell length, same three lights, same floor disc,
   same transparent background. That is the whole reason it is done through
   buildPlayerCar rather than by loading the GLB into a scene of its own — the
   two cards have to sit side by side, and everything about the shot except the
   bodyshell is shared code.

   The card is told about pass two through a callback rather than by polling:
   the fetch settles in a few hundred ms and the img src just changes. */

const cache = new Map<string, string>();

/** Pass-two shots, keyed by CAR AND PAINT — same key shape as the procedural
    cache. This used to be keyed by car alone, back when the donor body kept
    its baked silver whatever the swatch said; player.ts tintDonorPaint now
    repaints the donor on load, so each colour genuinely is a different PNG.
    The per-colour GLB re-parse that keying used to be avoiding is real but
    cheap: the fetch itself comes out of the browser's HTTP cache after the
    first swatch. */
const realCache = new Map<string, string>();
/** Cards waiting on a pass-two shot that is already in flight, per car+paint. */
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
  const key = spec.id + ":" + paintHex;
  const waiting = realWaiting.get(key);
  if (waiting) {
    waiting.add(cb);
    return;
  }
  const set = new Set([cb]);
  realWaiting.set(key, set);

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

  /* the re-shoot itself waits its turn on the render queue below — the GLB
     landing for five cards at once must not become five renders in a frame */
  void rig.bodyReady.then(() => enqueue(() => {
    let url: string | null = null;
    /* No handle ⇒ the GLB 404'd or failed to parse. Keep the procedural shot:
       the same rule the game itself follows when a donor goes missing. */
    if (rig.bodyModel) {
      rig.carGroup.visible = true;
      url = shoot(st, rig, spec);
      rig.carGroup.visible = false;
    }
    rig.dispose(st.scene);
    realWaiting.delete(key);
    if (!url) return;
    realCache.set(key, url);
    for (const f of set) f(url);
  }));
}

/* ---------- the render queue ----------

   Every card used to render its own shot inside its own rAF callback, and
   React mounts all five cards in one commit — so the five procedural shots
   (and then the donor-body re-shoots) all ran back to back in ONE frame. At
   480×260 with soft shadows that is milliseconds on a GPU and, on the
   software GL the QA box runs, minutes of a frozen page every time a paint
   swatch was tapped.

   Now a shot is a job on this queue and the queue drains ONE job per
   animation frame — after that frame has painted (rAF → setTimeout 0), so
   the card that just filled in is on screen before the next one starts and
   the page answers input between shots. A paint change puts the SELECTED
   car's card at the front so the thing the player is looking at updates
   first. The studio renderer, its shadow map and the readback canvas are
   the same objects for every job; only the rig is built and disposed. */

type Job = { run: () => void; cancelled: boolean };
const queue: Job[] = [];
let pumping = false;
function pump() {
  if (pumping || !queue.length) return;
  pumping = true;
  requestAnimationFrame(() => {
    setTimeout(() => {
      pumping = false;
      let job: Job | undefined;
      while ((job = queue.shift()) && job.cancelled);
      if (job) job.run();
      pump();
    }, 0);
  });
}
function enqueue(run: () => void, first = false): Job {
  const job: Job = { run, cancelled: false };
  if (first) queue.unshift(job);
  else queue.push(job);
  pump();
  return job;
}

/** Pass one, synchronous: the procedural shell, from the cache when it has
    been shot before. */
function shootProcedural(spec: CarSpec, paintHex: number): string {
  const k = spec.id + ":" + paintHex;
  let url = cache.get(k);
  if (url) return url;
  const st = getStudio();
  /* Both donors OFF, said out loud. This shot is rendered and read back
     SYNCHRONOUSLY and the rig is disposed immediately after, so neither
     fetch could arrive in time to appear in it — the cabin's 5.7 MB would
     buy nothing but a wire() call against a disposed cockpit, and the
     body's 1.4 MB is pass two's job and is cached there.

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
  return url;
}

/** Ask for the card art for (car, paint). `cb` gets the best shot available
    — synchronously when it is already cached, otherwise from the queue — and
    once more with the real-bodywork shot when that lands. Returns a cancel
    function for the card's unmount: a cancelled request neither renders nor
    calls back. `first` jumps the queue (the selected car on a paint change). */
export function requestCarPreview(
  carId: string,
  paintHex: number,
  cb: (url: string, real: boolean) => void,
  first = false,
): () => void {
  const spec = carById(carId) || getCar(carId);
  let live = true;
  const emit = (url: string, real: boolean) => {
    if (live) cb(url, real);
  };
  const key = carId + ":" + paintHex;
  const real = realCache.get(key);
  if (real) {
    emit(real, true);
    return () => { live = false; };
  }
  const jobs: Job[] = [];
  const proc = cache.get(key);
  if (proc) emit(proc, false);
  else jobs.push(enqueue(() => emit(shootProcedural(spec, paintHex), false), first));
  if (hasDonorBody(carId)) {
    /* the donor re-shoot is queued as well (its render is enqueued from the
       fetch's .then in shootReal), so a burst of real-body renders cannot
       land in one frame either; starting it AFTER the procedural job keeps
       the card's first fill ahead of the fetch */
    if (jobs.length) jobs.push(enqueue(() => { if (live) shootReal(spec, paintHex, (u) => emit(u, true)); }, first));
    else shootReal(spec, paintHex, (u) => emit(u, true));
  }
  return () => {
    live = false;
    for (const j of jobs) j.cancelled = true;
  };
}

/** Render a front-3/4 studio shot of the car; returns a PNG data URL.
 *
 *  The synchronous one-shot path. The garage cards go through
 *  requestCarPreview above so their renders are spread over frames.
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
  const real = realCache.get(carId + ":" + paintHex);
  if (real) return real;
  const url = shootProcedural(spec, paintHex);
  if (onReal && hasDonorBody(carId)) shootReal(spec, paintHex, onReal);
  return url;
}
