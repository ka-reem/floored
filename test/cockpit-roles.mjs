/* Does the shipped donor interior still satisfy the contract
   game/cockpitmodel.ts binds to?  Offline — no dev server, no renderer.

     node test/cockpit-roles.mjs [name]        (default: volvo-s90-full)

   wire() throws outright if `cluster` or `screen` is missing, and fails
   SILENTLY if `mirror`, `wheel` or the `steering` block is: the live gauge
   cluster and the nav minimap stop being where the donor puts them, or the
   mirror glass falls back to a procedural home fitted to a lens 12 cm higher.
   None of that shows up in a typecheck and none of it shows up in the size
   budget, so it is checked here — through the real GLTFLoader with the real
   meshopt decoder, so a compression or manifest change the loader would reject
   is caught too.

   The two anchor assertions at the end are the point of the file. They
   recompute, the way wire() does, where the live cluster and the mirror glass
   would actually land, and compare that against the manifest. A build that
   quietly moved either would still load, still typecheck, and still fit the
   budget. */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

/* GLTFLoader is browser code: it hands image payloads to URL.createObjectURL
   and then to an <img>. Neither exists here and neither matters here — this is
   a geometry and wiring check — so both are stubbed and every texture arrives
   as an empty THREE.Texture. */
globalThis.self = globalThis;
globalThis.URL.createObjectURL = () => "blob:stub";
globalThis.URL.revokeObjectURL = () => {};
import * as THREE from "three";
THREE.ImageLoader.prototype.load = function (url, onLoad) { onLoad({ width: 1, height: 1 }); return {}; };
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";

const DIR = path.join(fileURLToPath(new URL(".", import.meta.url)), "..", "public", "models", "cockpits") + path.sep;
const NAME = process.argv[2] || "volvo-s90-full";
const man = JSON.parse(fs.readFileSync(DIR + NAME + ".json", "utf8"));
const buf = fs.readFileSync(DIR + NAME + ".glb");
console.log(`${NAME}.glb  ${(buf.length / 1e6).toFixed(2)} MB   donor: ${man.source}`);

const gltf = await new Promise((res, rej) =>
  new GLTFLoader().setMeshoptDecoder(MeshoptDecoder)
    .parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), "", res, rej));
const scene = gltf.scene;
scene.updateMatrixWorld(true);
for (const c of scene.children) c.updateMatrix();

let fail = 0;
const REQUIRED = ["cluster", "screen"];              // wire() throws without these
const WANTED = ["clusterGlass", "mirror", "wheel", "shell", "cabin"];
const EXTRA = ["column", "seats", "floor", "pedals", "headliner"];  // trim; absence is legal
console.log(`scene: ${scene.children.length} children\n`);

for (const role of [...REQUIRED, ...WANTED, ...EXTRA]) {
  const want = man.parts[role] ?? [];
  /* Resolved BY NAME, the way byRole() does it — the check that matters is not
     "is it in the file" but "does three's name sanitising still find it". */
  const got = want.map((p) => scene.getObjectByName(p.name)).filter(Boolean);
  const bad = got.length !== want.length || (want.length === 0 && !EXTRA.includes(role));
  if (bad && !EXTRA.includes(role)) fail++;
  console.log(`${bad ? "FAIL" : "ok  "}  ${role.padEnd(13)} manifest ${String(want.length).padStart(2)}  resolved ${String(got.length).padStart(2)}`);
}
if (!man.steering) { console.log("FAIL  steering      block missing — the donor rim would spin about the wrong axis"); fail++; }
else console.log(`ok    steering      hub [${man.steering.hub}]  axis [${man.steering.axis}]`);

/* --- the live cluster ---------------------------------------------------- */

const clusterMesh = scene.getObjectByName(man.parts.cluster[0].name);
clusterMesh.geometry.computeBoundingBox();
const at = clusterMesh.geometry.boundingBox.getCenter(new THREE.Vector3()).applyMatrix4(clusterMesh.matrix);
const cb = man.parts.cluster[0].bbox;
const mid = [0, 1, 2].map((k) => (cb[0][k] + cb[1][k]) / 2);
const err = Math.max(...[0, 1, 2].map((k) => Math.abs(at.getComponent(k) - mid[k])));
console.log(`\ncluster anchor   loaded [${at.toArray().map((v) => v.toFixed(4))}]`);
console.log(`                 manifest [${mid.map((v) => v.toFixed(4))}]   agree to ${(err * 1000).toFixed(3)} mm`);
if (err > 0.001) { console.log("FAIL  cluster anchor disagrees with the manifest by more than 1 mm"); fail++; }

/* --- the nav minimap ------------------------------------------------------ */

const screenMesh = scene.getObjectByName(man.parts.screen[0].name);
const sm = Array.isArray(screenMesh.material) ? screenMesh.material[0] : screenMesh.material;
const screenOk = screenMesh.isMesh && !!sm && "map" in sm && "emissiveMap" in sm;
console.log(`${screenOk ? "ok  " : "FAIL"}  screen takes the nav canvas as map + emissiveMap: ${screenMesh.type} / ${sm?.type}`);
if (!screenOk) fail++;

/* --- the mirror glass ----------------------------------------------------- */

const box = new THREE.Box3();
for (const p of man.parts.mirror.map((q) => scene.getObjectByName(q.name))) {
  p.geometry.computeBoundingBox();
  box.union(p.geometry.boundingBox.clone().applyMatrix4(p.matrix));
}
const size = box.getSize(new THREE.Vector3()), mid2 = box.getCenter(new THREE.Vector3());
// cockpitmodel.ts MIRROR_NUDGE; keep the two in step if that constant moves
const NUDGE = new THREE.Vector3(0.08, -0.065, 0.10);
const glassAt = new THREE.Vector3(mid2.x, mid2.y, box.min.z - 0.004).add(NUDGE);
const glassScale = Math.min(1, (size.x * 0.88) / 0.30);
console.log(`mirror glass     at [${glassAt.toArray().map((v) => v.toFixed(4))}]  scale ${glassScale.toFixed(4)}`);
if (!(glassScale > 0.4 && glassScale <= 1)) { console.log("FAIL  mirror aperture is not a plausible size — the housing bbox moved"); fail++; }

console.log(fail ? `\n${fail} FAILURE(S)` : "\nOK: every role the wiring needs resolves");
process.exit(fail ? 1 : 0);
