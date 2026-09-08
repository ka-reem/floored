import * as THREE from "three";
import { buildPlayerCar, hasDonorBody, type PlayerRig } from "./player";
import { carById, getCar, type CarSpec } from "./carspecs";
import { envFaceCanvas, glowTexF } from "./textures";
import { BUILD_REV } from "@/lib/build";

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

/* ---------- the card art SURVIVES THE TAB ----------

   WHY. Every shot below is a full buildPlayerCar() plus a shadowed render
   plus a PNG readback. Measured on a desktop production build (the render
   itself excluded — this QA box has no GPU and inflates it beyond use), one
   card costs 100-205 ms to build and ~56 ms to encode, and the garage shoots
   FIVE of them. That is roughly a second of main-thread work on a desktop
   and several on a phone, paid on the first garage open of every visit and
   again on every paint the player has not already seen — which is exactly
   the shape of "the garage takes a while to load sometimes".

   The in-memory caches above already make the SECOND open of a session
   instant. This makes the first one instant too, on every visit after the
   first, by keeping the finished PNGs in localStorage.

   WHY IT CANNOT GO STALE. The store is keyed on BUILD_REV, which changes
   with every deployment, and hydrate() deletes every key that is not the
   current one — so art from a build where the cars looked different is
   dropped, never shown. And it is off entirely outside a production build:
   `next dev` evaluates next.config.mjs once at server start, so an HMR edit
   to a car would not move the key, and a lane working on car art must never
   be shown a cached render of the old one.

   BUDGET. A shot is ~60 KB of base64; five cards in one paint is ~300 KB,
   against a localStorage quota that is 5 MB on a good day and smaller in a
   private window. STORE_MAX_BYTES caps it well under that and the oldest
   entries go first. Every read and write is wrapped: Safari's private mode
   throws on setItem, and a garage that works is worth more than a garage
   that is fast. */
const STORE_PREFIX = "neonx.cards.";
const STORE_KEY = STORE_PREFIX + BUILD_REV;
/* ~99 KB a shot, measured: one paint across the five cards, plus the Volvo's
   donor-bodywork pass, is about 600 KB. Two paints fit here — the one the
   player drives in and the one they last looked at — inside a fifth of a 5 MB
   origin quota. Past it the oldest entries go, and touch() keeps the ones
   being read at the young end, so what survives is what is in use. */
const STORE_MAX_BYTES = 1_100_000;
/** Off without a build token, and off outside a production bundle. */
const STORE_ON = !!BUILD_REV && process.env.NODE_ENV === "production";

/** Insertion order IS the eviction order — a Map keeps it, and a shot that is
    re-read is not re-inserted, so this is oldest-first rather than true LRU.
    Good enough: the cost of evicting a shot is one re-render of one card. */
const store = new Map<string, string>();
let hydrated = false;

function hydrate() {
  if (hydrated) return;
  hydrated = true;
  if (!STORE_ON || typeof localStorage === "undefined") return;
  try {
    /* Drop every other build's art first. Without this the quota fills with
       renders of cars nobody can see any more and the current build's writes
       start failing. */
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (k && k.startsWith(STORE_PREFIX) && k !== STORE_KEY) localStorage.removeItem(k);
    }
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return;
    const obj = JSON.parse(raw) as Record<string, string>;
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v !== "string" || !v.startsWith("data:image/png")) continue;
      store.set(k, v);
      /* Straight into the two in-memory caches the rest of this file reads,
         so a hydrated shot is indistinguishable from one this session drew —
         requestCarPreview hands it back synchronously and renders nothing. */
      if (k.endsWith(":real")) realCache.set(k.slice(0, -5), v);
      else cache.set(k, v);
    }
  } catch {
    /* unparseable, or storage denied: this session simply renders its own */
  }
}

let saveQueued = false;
function saveSoon() {
  if (!STORE_ON || saveQueued || typeof localStorage === "undefined") return;
  saveQueued = true;
  /* On idle, and never inside a shot: the write is a synchronous serialise of
     up to STORE_MAX_BYTES of base64, which is not something to do in the same
     frame as a render the player is waiting on. */
  const run = () => {
    saveQueued = false;
    /* Never mid-burst. A cold garage open finishes six shots over six frames
       and each one would otherwise serialise the whole store again; waiting
       for the render queue to drain turns that into one write. */
    if (queue.length) { saveSoon(); return; }
    try {
      let total = 0;
      for (const v of store.values()) total += v.length;
      while (total > STORE_MAX_BYTES && store.size) {
        const oldest = store.keys().next().value as string;
        total -= store.get(oldest)!.length;
        store.delete(oldest);
      }
      localStorage.setItem(STORE_KEY, JSON.stringify(Object.fromEntries(store)));
    } catch {
      /* quota, or a private window that refuses writes. Give up for good
         rather than retrying into the same wall on every shot. */
      try { localStorage.removeItem(STORE_KEY); } catch {}
      store.clear();
    }
  };
  const ric = (window as unknown as {
    requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => void;
  }).requestIdleCallback;
  if (ric) ric(run, { timeout: 2000 });
  else setTimeout(run, 500);
}

/** Move an already-stored shot to the end of the eviction queue, so reading a
    card keeps it alive. Deliberately does NOT schedule a save: the order is
    worth persisting, but not worth a 900 KB serialise on its own — the next
    real write carries it. */
function touch(key: string, real: boolean) {
  if (!STORE_ON) return;
  const k = real ? key + ":real" : key;
  const v = store.get(k);
  if (v === undefined) return;
  store.delete(k);
  store.set(k, v);
}

/** Remember one finished shot. `key` is the same car:paint key the in-memory
    caches use; `real` marks the donor-bodywork pass so the two cannot collide
    in one flat store. */
function remember(key: string, url: string, real: boolean) {
  if (!STORE_ON) return;
  store.set(real ? key + ":real" : key, url);
  saveSoon();
}

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
  cancelStudioRelease();
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
    remember(key, url, true);
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
  if (pumping) return;
  if (!queue.length) {
    releaseStudioWhenIdle();
    return;
  }
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
/* ---------- handing the studio's GL context back ----------

   getStudio() builds a SECOND WebGLRenderer, with its own WebGL context, its
   own 1024² shadow map and a preserveDrawingBuffer canvas. It was cached in a
   module-level `studio` and never released, so one visit to the garage left
   that context and its driver-side allocation alive for the rest of the
   session, alongside the game's own.

   That matters because a context is a capped resource: the browser allows
   only so many live at once and drops the OLDEST to stay under the cap. In a
   page whose main context is the game, the thing dropped is the game — which
   is the "Graphics context lost" panel the owner is seeing in replays and
   hitting himself. On a phone the memory alone is reason enough.

   Releasing it is safe because the card art is CACHED (in memory and in the
   persisted `remember` store), so the studio is only ever needed again for a
   car+paint combination that has never been shot. Re-creating it costs one
   renderer construction on that path and nothing at all on the common one.

   Two conditions, and the second is the subtle one: the render queue must be
   empty, AND `realWaiting` must be empty. shootReal() acquires the studio
   BEFORE its GLB fetch, parks a hidden rig in the studio scene, and renders
   from `st` captured in its own closure when the fetch lands. Disposing while
   such a rig is parked would render into a dead renderer. A fetch that never
   resolves therefore keeps the context — failing towards "kept" rather than
   "used after free" is the right way round. */
const STUDIO_IDLE_MS = 8000;
let studioIdleT: ReturnType<typeof setTimeout> | undefined;

function cancelStudioRelease() {
  if (studioIdleT !== undefined) {
    clearTimeout(studioIdleT);
    studioIdleT = undefined;
  }
}

function releaseStudioWhenIdle() {
  cancelStudioRelease();
  if (!studio) return;
  studioIdleT = setTimeout(() => {
    studioIdleT = undefined;
    if (!studio || queue.length || realWaiting.size) return;
    const st = studio;
    studio = null;
    st.scene.traverse((o) => {
      const m = o as THREE.Mesh;
      m.geometry?.dispose();
      const mats = Array.isArray(m.material) ? m.material : m.material ? [m.material] : [];
      for (const mm of mats) mm.dispose();
    });
    st.envMap.dispose();
    st.glowTex.dispose();
    st.blankTex.dispose();
    /* dispose() frees three's own GPU objects; only forceContextLoss() hands
       the CONTEXT itself back, which is the scarce thing here. */
    st.renderer.dispose();
    st.renderer.forceContextLoss();
  }, STUDIO_IDLE_MS);
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
  remember(k, url, false);
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
  hydrate();
  const spec = carById(carId) || getCar(carId);
  let live = true;
  const emit = (url: string, real: boolean) => {
    if (live) cb(url, real);
  };
  const key = carId + ":" + paintHex;
  const real = realCache.get(key);
  if (real) {
    touch(key, true);
    emit(real, true);
    return () => { live = false; };
  }
  const jobs: Job[] = [];
  const proc = cache.get(key);
  if (proc) {
    touch(key, false);
    emit(proc, false);
  }
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
  hydrate();
  const spec = carById(carId) || getCar(carId);
  const real = realCache.get(carId + ":" + paintHex);
  if (real) return real;
  const url = shootProcedural(spec, paintHex);
  if (onReal && hasDonorBody(carId)) shootReal(spec, paintHex, onReal);
  return url;
}
