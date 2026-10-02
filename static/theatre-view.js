// "Real theatre" view: the actual nDisplay theatre mesh (static/models/TheaterMesh.fbx) with the project's pictures
// on its screens. Loaded only when that view is chosen (three.js from jsDelivr via the page's importmap).
//
// The mesh (inspected with a binary FBX reader): Unreal export, Z-up, centimetres, five meshes with one material
// slot each and per-mesh UVs (UVmap_0 spans 0..1 on every screen; there is no shared 11520x2160 canvas UV).
// So each piece gets its own texture on its own mesh. Seen from inside the room, u runs left-to-right on every
// screen and v runs up, so the images are neither mirrored nor upside down.
import * as THREE from "three";
import { FBXLoader } from "three/addons/loaders/FBXLoader.js";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { Reflector } from "three/addons/objects/Reflector.js";

const MESH_TO_PIECE = [
  [/centre/i, "centre"], [/_LR$/i, "LR"], [/_RR$/i, "RR"], [/WallL$/i, "left"], [/WallR$/i, "right"],
];
const MODEL_URL = "/static/models/TheaterMesh.fbx";

let renderer, scene, camera, controls, host, raf = 0, visible = false, home = null, roomBox = null;
const screens = {};          // piece -> mesh
const loader = new THREE.TextureLoader();
const current = {};          // piece -> url shown

function pieceFor(name) {
  for (const [re, piece] of MESH_TO_PIECE) if (re.test(name)) return piece;
  return null;
}

function ledMaterial() {
  // Dark LED panel until a picture arrives: a faint dot grid, unlit.
  const c = document.createElement("canvas"); c.width = c.height = 64;
  const g = c.getContext("2d"); g.fillStyle = "#08070d"; g.fillRect(0, 0, 64, 64);
  g.fillStyle = "rgba(170,160,255,0.22)";
  for (let y = 4; y < 64; y += 8) for (let x = 4; x < 64; x += 8) g.fillRect(x, y, 1.5, 1.5);
  const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(24, 12);
  t.colorSpace = THREE.SRGBColorSpace;
  return new THREE.MeshBasicMaterial({ map: t, toneMapped: false, side: THREE.DoubleSide });
}

export async function init(container, onPick) {
  host = container;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  } catch (e) {
    throw new Error("Your browser can't show 3D graphics here (WebGL is off or unavailable). The 3D room and Flat view still work.");
  }
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  host.appendChild(renderer.domElement);
  renderer.domElement.addEventListener("webglcontextlost", (e) => { e.preventDefault(); stop(); });

  scene = new THREE.Scene();
  scene.background = null;
  camera = new THREE.PerspectiveCamera(58, 1, 0.05, 200);

  const fbx = await new FBXLoader().loadAsync(MODEL_URL);
  // Unreal: Z-up, centimetres -> three.js: Y-up, metres.
  fbx.rotation.x = -Math.PI / 2;
  fbx.scale.setScalar(0.01);
  scene.add(fbx);
  fbx.updateMatrixWorld(true);
  fbx.traverse((o) => {
    if (!o.isMesh) return;
    const piece = pieceFor(o.name);
    if (!piece) { o.material = new THREE.MeshStandardMaterial({ color: 0x15141b, roughness: 0.9 }); return; }
    o.material = ledMaterial();
    o.userData.piece = piece;
    screens[piece] = o;
  });

  roomBox = new THREE.Box3().setFromObject(fbx);
  const size = roomBox.getSize(new THREE.Vector3());
  // The screens start 36.6 cm above the floor in the mesh (Unreal z 49.6 - 25 + 12).
  const floorY = roomBox.min.y - 0.366;

  // Floor: a dim mirror (cheap: five quads to reflect) under a dark translucent tint.
  const fw = size.x + 4, fd = size.z + 6;
  const mirror = new Reflector(new THREE.PlaneGeometry(fw, fd), {
    clipBias: 0.003, textureWidth: 1024, textureHeight: 1024, color: 0x6a6a72,
  });
  mirror.rotation.x = -Math.PI / 2;
  mirror.position.set((roomBox.min.x + roomBox.max.x) / 2, floorY, (roomBox.min.z + roomBox.max.z) / 2);
  scene.add(mirror);
  const tint = new THREE.Mesh(new THREE.PlaneGeometry(fw, fd),
    new THREE.MeshBasicMaterial({ color: 0x0b0a10, transparent: true, opacity: 0.82 }));
  tint.rotation.x = -Math.PI / 2;
  tint.position.copy(mirror.position).add(new THREE.Vector3(0, 0.002, 0));
  scene.add(tint);
  scene.add(new THREE.AmbientLight(0xffffff, 0.6));

  // Audience position: in the room, on the centre line, eye height, looking at the centre screen.
  const c = new THREE.Box3().setFromObject(screens.centre || fbx);
  const target = c.getCenter(new THREE.Vector3());
  const front = roomBox.max.z;              // the open end of the U (the audience side)
  // Stand on the centre line at eye height, at the open (audience) end of the U, looking at the centre screen.
  home = { pos: new THREE.Vector3(target.x, floorY + 1.6, front + 1.2), target: target.clone() };

  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.enablePan = true;
  controls.screenSpacePanning = true;
  controls.minDistance = 0.8;
  controls.maxDistance = Math.max(size.x, size.z) * 1.15;
  controls.maxPolarAngle = Math.PI * 0.62;
  controls.addEventListener("change", keepInside);
  reset();
  // A click (not a drag) on a screen opens that piece big.
  const ray = new THREE.Raycaster(), down = { x: 0, y: 0 };
  renderer.domElement.addEventListener("pointerdown", (e) => { down.x = e.clientX; down.y = e.clientY; });
  renderer.domElement.addEventListener("pointerup", (e) => {
    if (!onPick || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4) return;
    const r = renderer.domElement.getBoundingClientRect();
    ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), camera);
    const hit = ray.intersectObjects(Object.values(screens), false)[0];
    if (hit && current[hit.object.userData.piece]) onPick(hit.object.userData.piece);
  });
  window.addEventListener("resize", resize);
  resize();
  return Object.keys(screens);
}

function keepInside() {
  // Keep the camera inside, or just in front of, the room.
  if (!roomBox) return;
  const p = camera.position, m = 0.15;
  p.x = Math.min(roomBox.max.x - m, Math.max(roomBox.min.x + m, p.x));
  p.y = Math.min(roomBox.max.y + 1.5, Math.max(roomBox.min.y - 0.2, p.y));
  p.z = Math.min(roomBox.max.z + 3, Math.max(roomBox.min.z + 0.4, p.z));
}

export function reset() {
  if (!home) return;
  camera.position.copy(home.pos);
  controls.target.copy(home.target);
  controls.update();
}

function resize() {
  if (!renderer || !host) return;
  const w = host.clientWidth || 1, h = host.clientHeight || 1;
  renderer.setSize(w, h, false);
  renderer.domElement.style.width = "100%"; renderer.domElement.style.height = "100%";
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}

function loop() {
  raf = requestAnimationFrame(loop);
  controls.update();
  renderer.render(scene, camera);
}
export function start() { visible = true; resize(); if (!raf) loop(); }
export function stop() { visible = false; if (raf) cancelAnimationFrame(raf); raf = 0; }

/* pieces: { left: url|null, LR: url|null, centre: url|null, RR: url|null, right: url|null } */
export function show(pieces) {
  for (const [piece, mesh] of Object.entries(screens)) {
    const url = pieces[piece] || null;
    if (current[piece] === url) continue;
    current[piece] = url;
    if (!url) { mesh.material.dispose(); mesh.material = ledMaterial(); continue; }
    loader.load(url, (tex) => {
      if (current[piece] !== url) { tex.dispose(); return; }
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
      const old = mesh.material;
      // Unlit: an LED makes its own light, so the picture shows at full brightness.
      mesh.material = new THREE.MeshBasicMaterial({ map: tex, toneMapped: false, side: THREE.DoubleSide });
      if (old.map) old.map.dispose();
      old.dispose();
    });
  }
}
