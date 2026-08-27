import * as THREE from "three";
import { buildPlayerCar } from "./player";
import { carById, getCar } from "./carspecs";
import { envFaceCanvas, glowTexF } from "./textures";

/* Offscreen studio renders of the player car rigs for the garage UI.
   One shared renderer/scene; results are cached per (car, paint). */

const cache = new Map<string, string>();

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

/** Render a front-3/4 studio shot of the car; returns a PNG data URL. */
export function carPreviewURL(carId: string, paintHex: number): string {
  const k = carId + ":" + paintHex;
  const hit = cache.get(k);
  if (hit) return hit;

  const st = getStudio();
  /* carById, not getCar: this renders the GARAGE CARD, and a COMING SOON car
     has to be drawn as itself. getCar() would resolve every locked id to the
     fallback car and put four identical shots on the shelf. */
  const spec = carById(carId) || getCar(carId);
  /* "mobile-base" purely because it is the tier that configures no donor dash
     for any car (player.ts COCKPIT_MODEL is keyed by car AND tier now; that row
     is empty for all of them). This shot is rendered and read back
     SYNCHRONOUSLY on the next line and the rig is disposed immediately after,
     so an imported dash could never arrive in time to appear in it — on the
     default tier the VOLVO card would kick off a 17 MB fetch whose only
     possible outcomes are wasted bandwidth and a wire() call against a disposed
     cockpit.

     THE DONOR BODY IS NOT COVERED BY THIS, and never was: BODY_MODEL is keyed
     by car alone, so the Volvo's card still starts a 0.48 MB fetch it cannot
     use. Pre-existing — it was the KAZE card doing it until the donor body
     moved — and harmless beyond the bandwidth, since the callback lands on a
     disposed rig and nothing reads it. Both cards render PROCEDURALLY either
     way, which is the intent: the garage draws each car from its ShellParams. */
  const rig = buildPlayerCar(st.scene, spec, paintHex, st.envMap, st.glowTex, st.blankTex, "mobile-base");
  rig.headMat.emissiveIntensity = 2.2;
  rig.carGroup.rotation.y = -2.42; // front-3/4, nose toward camera-left

  const L = spec.shell.L;
  st.camera.position.set(0, L * 0.42, L * 1.62);
  st.camera.lookAt(0, spec.shell.belt * 0.55, 0);
  st.renderer.render(st.scene, st.camera);
  const url = st.renderer.domElement.toDataURL("image/png");

  rig.dispose(st.scene);
  cache.set(k, url);
  return url;
}
