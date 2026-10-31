// WebGL 3D renderer built on Three.js. Same interface as the 2D Renderer
// (render, centerOn, pan, zoomAt, screenToTile, floatText) plus rotate()
// and pickObject().
//
// World space: x = tile x, z = tile y, y = up. One tile is one unit (4 m).

import * as THREE from '/vendor/three/three.module.min.js';
import { GRID, RIDES, STALLS, STAFF, PANDEMONIUM } from './catalog.js';
import { TILE, ENTRANCE, idx, actorPos, cellsOf, rideDef, weatherOf } from './sim.js';
import { CLIMATES, PATH_STYLES } from './options.js';
import * as Coaster from './coaster.js';

const INSTANCED = new Set(['tree', 'pine', 'flowers', 'palm', 'cactus', 'cherry', 'rock']);
const SKIN = [0xf4d1b5, 0xe0ac85, 0xc68863, 0x8d5a3b, 0x5c3a24];
const MAX_PEOPLE = 1400;
const hash = (n) => {
  n = Math.imul(n ^ (n >>> 16), 0x45d9f3b);
  n = Math.imul(n ^ (n >>> 16), 0x45d9f3b);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
};
const mat = (color, extra = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.75, metalness: 0.05, flatShading: true, ...extra });
const MATS = {};
const M = (color, extra) => {
  const key = `${color}|${JSON.stringify(extra || {})}`;
  return (MATS[key] ||= mat(color, extra));
};

function mesh(geo, material, { cast = true, receive = true } = {}) {
  const m = new THREE.Mesh(geo, material);
  m.castShadow = cast;
  m.receiveShadow = receive;
  return m;
}
const box = (w, h, d, color, extra) => mesh(new THREE.BoxGeometry(w, h, d), M(color, extra));
const cyl = (rt, rb, h, color, seg = 12, extra) => mesh(new THREE.CylinderGeometry(rt, rb, h, seg), M(color, extra));
const sphere = (r, color, extra) => mesh(new THREE.SphereGeometry(r, 12, 8), M(color, extra));

function textTexture(text, { size = 64, color = '#fff', bg = null, font = 'bold 40px system-ui, sans-serif', w = 256, h = 64 } = {}) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  if (bg) { ctx.fillStyle = bg; ctx.fillRect(0, 0, w, h); }
  ctx.fillStyle = color;
  ctx.font = font;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, w / 2, h / 2 + 2);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

function stripeTexture(a, b, n = 8) {
  const c = document.createElement('canvas');
  c.width = 128; c.height = 8;
  const ctx = c.getContext('2d');
  for (let i = 0; i < n; i++) { ctx.fillStyle = i % 2 ? b : a; ctx.fillRect((i * 128) / n, 0, 128 / n + 1, 8); }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

let glowTex = null;
function glowTexture() {
  if (glowTex) return glowTex;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.4, 'rgba(255,255,255,0.35)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  glowTex = new THREE.CanvasTexture(c);
  return glowTex;
}

const emojiCache = new Map();
function emojiSprite(emoji, scale = 0.45) {
  let tex = emojiCache.get(emoji);
  if (!tex) {
    tex = textTexture(emoji, { w: 128, h: 128, font: '96px system-ui, "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif' });
    emojiCache.set(emoji, tex);
  }
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthWrite: false }));
  s.scale.set(scale, scale, scale);
  return s;
}

/** Instanced mesh helper that is filled from scratch every frame. */
class Batch {
  constructor(scene, geo, material, max, { cast = true } = {}) {
    this.mesh = new THREE.InstancedMesh(geo, material, max);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.castShadow = cast;
    this.mesh.receiveShadow = false;
    this.mesh.frustumCulled = false;
    this.max = max;
    this.n = 0;
    this.color = new THREE.Color();
    scene.add(this.mesh);
  }
  begin() { this.n = 0; }
  add(matrix, color) {
    if (this.n >= this.max) return;
    this.mesh.setMatrixAt(this.n, matrix);
    if (color !== undefined) this.mesh.setColorAt(this.n, this.color.set(color));
    this.n++;
  }
  end() {
    this.mesh.count = this.n;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }
}

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _v = new THREE.Vector3();
const _s = new THREE.Vector3();
const compose = (x, y, z, ry = 0, sx = 1, sy = 1, sz = 1, rx = 0, rz = 0) => {
  _e.set(rx, ry, rz, 'YXZ');
  _q.setFromEuler(_e);
  return _m.compose(_v.set(x, y, z), _q, _s.set(sx, sy, sz));
};

export class Renderer3D {
  constructor(canvas) {
    this.canvas = canvas;
    this.gl = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.gl.shadowMap.enabled = true;
    this.gl.shadowMap.type = THREE.PCFSoftShadowMap;
    this.gl.outputColorSpace = THREE.SRGBColorSpace;
    this.gl.toneMapping = THREE.ACESFilmicToneMapping;
    this.gl.toneMappingExposure = 1.05;

    this.scene = new THREE.Scene();
    this.sky = new THREE.Color(0x9fd3f2);
    this.scene.background = this.sky.clone();
    this.scene.fog = new THREE.Fog(0x9fd3f2, 60, 140);

    this.camera = new THREE.PerspectiveCamera(38, 1, 0.1, 400);
    this.target = new THREE.Vector3(GRID / 2, 0, GRID - 8);
    this.yaw = Math.PI / 4;
    this.pitch = 0.88;
    this.distance = 34;

    this.hemi = new THREE.HemisphereLight(0xdff1ff, 0x5a7a3a, 1.1);
    this.scene.add(this.hemi);
    this.sun = new THREE.DirectionalLight(0xfff2d6, 2.6);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    const sc = this.sun.shadow.camera;
    sc.left = -30; sc.right = 30; sc.top = 30; sc.bottom = -30; sc.near = 1; sc.far = 120;
    this.sun.shadow.bias = -0.0005;
    this.sun.shadow.normalBias = 0.02;
    this.sun.position.set(GRID / 2 + 18, 40, GRID / 2 - 10);
    this.sun.target.position.set(GRID / 2, 0, GRID / 2);
    this.scene.add(this.sun, this.sun.target);

    this.objects = new Map(); // obj.id -> { group, version, animate }
    this.particles = [];
    this.shots = [];
    this.floaters = [];
    this.dusk = 0;
    this.raid = false;

    this.buildWorld();
    this.buildBatches();
    this.buildOverlays();
    this.floatLayer = document.createElement('div');
    this.floatLayer.className = 'float-layer';
    document.body.append(this.floatLayer);

    this.raycaster = new THREE.Raycaster();
    this.groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    this.resize();
    this.updateCamera();
  }

  // ------------------------------------------------------------------
  // Camera
  // ------------------------------------------------------------------

  resize() {
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    this.gl.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.gl.setSize(w, h, false);
    this.camera.aspect = w / Math.max(1, h);
    this.camera.updateProjectionMatrix();
  }

  updateCamera() {
    const t = this.target;
    t.x = Math.max(-5, Math.min(GRID + 5, t.x));
    t.z = Math.max(-5, Math.min(GRID + 5, t.z));
    const cp = Math.cos(this.pitch);
    this.camera.position.set(
      t.x + this.distance * cp * Math.sin(this.yaw),
      t.y + this.distance * Math.sin(this.pitch),
      t.z + this.distance * cp * Math.cos(this.yaw),
    );
    this.camera.lookAt(t);
  }

  centerOn(fx, fy) {
    this.target.set(fx + 0.5, 0, fy + 0.5);
    this.updateCamera();
  }

  pan(dx, dy) {
    const k = this.distance / this.canvas.clientHeight * 0.8;
    const right = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    const fwd = new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    this.target.addScaledVector(right, -dx * k).addScaledVector(fwd, dy * k * 1.3);
    this.updateCamera();
  }

  rotate(delta) {
    this.yaw += delta;
    this.updateCamera();
  }

  tilt(delta) {
    this.pitch = Math.max(0.35, Math.min(1.45, this.pitch + delta));
    this.updateCamera();
  }

  zoomAt(factor, sx, sy) {
    const before = this.screenToTile(sx, sy);
    this.distance = Math.max(7, Math.min(90, this.distance / factor));
    this.updateCamera();
    const after = this.screenToTile(sx, sy);
    if (before && after) {
      this.target.x += before.x - after.x;
      this.target.z += before.y - after.y;
      this.updateCamera();
    }
  }

  get zoom() { return 34 / this.distance; }

  ray(sx, sy) {
    const r = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2((sx / r.width) * 2 - 1, -(sy / r.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    return this.raycaster;
  }

  /** CSS-pixel point -> continuous tile coordinates on the ground. */
  screenToTile(sx, sy) {
    const hit = new THREE.Vector3();
    if (!this.ray(sx, sy).ray.intersectPlane(this.groundPlane, hit)) return { x: -999, y: -999 };
    return { x: hit.x, y: hit.z };
  }

  /** Tile-space point (plus height) -> CSS pixels. */
  tileToScreen(fx, fy, h = 0) {
    const v = new THREE.Vector3(fx, h, fy).project(this.camera);
    const r = this.canvas.getBoundingClientRect();
    return { x: (v.x + 1) / 2 * r.width, y: (1 - v.y) / 2 * r.height, visible: v.z < 1 };
  }

  /** The object (ride, shop...) under the cursor, if any. */
  pickObject(sx, sy) {
    const groups = [...this.objects.values()].map((o) => o.group);
    const hits = this.ray(sx, sy).intersectObjects(groups, true);
    for (const h of hits) {
      let o = h.object;
      while (o && o.userData.objId === undefined) o = o.parent;
      if (o) return o.userData.objId;
    }
    return null;
  }

  floatText(fx, fy, text, color) {
    const el = document.createElement('div');
    el.className = 'floater';
    el.textContent = text;
    el.style.color = color;
    this.floatLayer.append(el);
    this.floaters.push({ fx, fy, el, age: 0 });
  }

  // ------------------------------------------------------------------
  // Static world
  // ------------------------------------------------------------------

  buildWorld() {
    // Surrounding countryside.
    this.outer = mesh(new THREE.PlaneGeometry(400, 400), new THREE.MeshStandardMaterial({ color: 0x3f7a3c, roughness: 1 }), { cast: false });
    this.outer.rotation.x = -Math.PI / 2;
    this.outer.position.set(GRID / 2, -0.02, GRID / 2);
    this.scene.add(this.outer);

    // Park lawn: a checker texture tinted by climate (see applyClimate).
    this.lawn = mesh(new THREE.PlaneGeometry(GRID, GRID), new THREE.MeshStandardMaterial({ roughness: 0.95 }), { cast: false });
    this.lawn.rotation.x = -Math.PI / 2;
    this.lawn.position.set(GRID / 2, 0, GRID / 2);
    this.scene.add(this.lawn);
    this.applyClimate('temperate');

    // Entrance arch.
    const arch = new THREE.Group();
    const { x, y } = ENTRANCE;
    for (const dx of [0.08, 0.92]) {
      const post = box(0.12, 1.5, 0.12, 0x7a4b2a);
      post.position.set(x + dx, 0.75, y + 0.9);
      arch.add(post);
    }
    this.signTex = { open: textTexture('WELCOME', { bg: '#e5484d' }), closed: textTexture('CLOSED', { bg: '#555' }) };
    this.sign = mesh(new THREE.BoxGeometry(1.3, 0.32, 0.06), [
      M(0xb3373b), M(0xb3373b), M(0xb3373b), M(0xb3373b),
      new THREE.MeshStandardMaterial({ map: this.signTex.open }), new THREE.MeshStandardMaterial({ map: this.signTex.open }),
    ]);
    this.sign.position.set(x + 0.5, 1.55, y + 0.9);
    arch.add(this.sign);
    this.scene.add(arch);

    this.fence = new THREE.Group();
    this.fence.visible = false;
    this.scene.add(this.fence);
    this.buildFence();
  }

  applyClimate(climate) {
    if (climate === this.climate) return;
    this.climate = climate;
    const C = CLIMATES[climate] || CLIMATES.temperate;
    const [r, g, b] = C.grass;
    const c = document.createElement('canvas');
    c.width = c.height = GRID * 8;
    const ctx = c.getContext('2d');
    for (let y = 0; y < GRID; y++) {
      for (let x = 0; x < GRID; x++) {
        const v = hash(x * 131 + y * 71), d = (x + y) % 2 ? 0 : -6;
        ctx.fillStyle = `rgb(${r + d + v * 10},${g + d + v * 12},${b + d + v * 8})`;
        ctx.fillRect(x * 8, y * 8, 8, 8);
      }
    }
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.magFilter = THREE.NearestFilter;
    this.lawn.material.map?.dispose();
    this.lawn.material.map = tex;
    this.lawn.material.needsUpdate = true;
    this.outer.material.color.setHex(C.outer);
    this.scenerySig = null; // foliage colours depend on climate
  }

  buildFence() {
    const posts = [];
    const H = 0.7;
    const wires = [];
    const edge = (x0, z0, x1, z1) => {
      posts.push([x0, z0]);
      for (const h of [0.2, 0.45, H]) wires.push(x0, h, z0, x1, h, z1);
    };
    for (let i = 0; i < GRID; i++) {
      edge(i, 0, i + 1, 0);
      edge(0, i, 0, i + 1);
      edge(GRID, i, GRID, i + 1);
      if (i !== ENTRANCE.x) edge(i, GRID, i + 1, GRID);
      else posts.push([i, GRID]);
    }
    posts.push([GRID, GRID]);
    const postMesh = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.03, 0.03, H + 0.1, 5), M(0x4a4a4a), posts.length);
    posts.forEach(([x, z], i) => postMesh.setMatrixAt(i, compose(x, (H + 0.1) / 2, z)));
    postMesh.castShadow = true;
    this.fence.add(postMesh);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(wires, 3));
    this.fence.add(new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0xaab0b6 })));
    // Razor coil: little crosses along the top.
    const coil = [];
    for (let k = 0; k < wires.length; k += 18) {
      const [x0, , z0, x1, , z1] = wires.slice(k + 12, k + 18);
      for (let s = 0; s < 4; s++) {
        const u = (s + 0.5) / 4, x = x0 + (x1 - x0) * u, z = z0 + (z1 - z0) * u;
        coil.push(x - 0.04, H + 0.08, z - 0.04, x + 0.04, H, z + 0.04, x + 0.04, H + 0.08, z - 0.04, x - 0.04, H, z + 0.04);
      }
    }
    const cg = new THREE.BufferGeometry();
    cg.setAttribute('position', new THREE.Float32BufferAttribute(coil, 3));
    this.fence.add(new THREE.LineSegments(cg, new THREE.LineBasicMaterial({ color: 0xd0d6dc })));
    // Gate bars (shown when locked).
    this.gate = new THREE.Group();
    for (let k = 0; k <= 7; k++) {
      const bar = box(0.04, 0.9, 0.04, 0x2b2b2b);
      bar.position.set(ENTRANCE.x + k / 7, 0.45, GRID);
      this.gate.add(bar);
    }
    const band = box(1, 0.08, 0.06, 0xb42318);
    band.position.set(ENTRANCE.x + 0.5, 0.55, GRID);
    this.gate.add(band);
    this.padlock = box(0.16, 0.16, 0.08, 0xffd23f, { emissive: 0x332200 });
    this.padlock.position.set(ENTRANCE.x + 0.5, 0.55, GRID + 0.05);
    this.gate.add(this.padlock);
    this.fence.add(this.gate);
  }

  buildBatches() {
    const s = this.scene;
    const white = new THREE.MeshStandardMaterial({ roughness: 0.8, flatShading: true });
    // Ground features.
    this.paths = new Batch(s, new THREE.BoxGeometry(1, 0.04, 1), white, GRID * GRID, { cast: false });
    this.paths.mesh.receiveShadow = true;
    this.pathEdges = new Batch(s, new THREE.BoxGeometry(1, 0.03, 1), new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1 }), GRID * GRID, { cast: false });
    this.litter = new Batch(s, new THREE.BoxGeometry(0.07, 0.02, 0.05), white.clone(), 4000, { cast: false });
    this.stains = new Batch(s, new THREE.CylinderGeometry(1, 1, 0.01, 10), new THREE.MeshStandardMaterial({ color: 0x8a0f12, roughness: 0.3, metalness: 0.1 }), 4000, { cast: false });
    // Scenery instancing.
    this.trunks = new Batch(s, new THREE.CylinderGeometry(0.05, 0.07, 0.5, 6), white.clone(), 2000);
    this.fronds = new Batch(s, new THREE.BoxGeometry(0.5, 0.02, 0.12), white.clone(), 3000);
    this.rocks = new Batch(s, new THREE.DodecahedronGeometry(0.3, 0), white.clone(), 1500);
    this.canopies = new Batch(s, new THREE.IcosahedronGeometry(0.32, 0), white.clone(), 4000);
    this.cones = new Batch(s, new THREE.ConeGeometry(0.3, 0.55, 7), white.clone(), 3000);
    this.blooms = new Batch(s, new THREE.SphereGeometry(0.04, 5, 4), white.clone(), 6000, { cast: false });
    this.beds = new Batch(s, new THREE.BoxGeometry(0.8, 0.06, 0.8), M(0x5a3f2b), 1000, { cast: false });
    // People.
    this.legs = new Batch(s, new THREE.BoxGeometry(0.05, 0.16, 0.05), M(0x2c3440), MAX_PEOPLE * 2);
    this.bodies = new Batch(s, new THREE.BoxGeometry(0.15, 0.17, 0.09), white.clone(), MAX_PEOPLE);
    this.heads = new Batch(s, new THREE.SphereGeometry(0.065, 10, 8), white.clone(), MAX_PEOPLE);
    this.hats = new Batch(s, new THREE.CylinderGeometry(0.07, 0.07, 0.03, 10), white.clone(), 400);
    this.guns = new Batch(s, new THREE.BoxGeometry(0.03, 0.03, 0.14), M(0x333333), 200);
    this.pandaWhite = new Batch(s, new THREE.SphereGeometry(1, 12, 10), M(0xf5f5f5), 120);
    this.pandaBlack = new Batch(s, new THREE.SphereGeometry(1, 10, 8), M(0x161616), 400);
    this.lootBags = new Batch(s, new THREE.SphereGeometry(0.05, 8, 6), M(0x8a6a3c), 60);
    this.markers = new Batch(s, new THREE.ConeGeometry(0.05, 0.1, 6), new THREE.MeshBasicMaterial(), 800, { cast: false });
    this.bars = new Batch(s, new THREE.BoxGeometry(1, 0.025, 0.025), new THREE.MeshBasicMaterial(), 400, { cast: false });
    this.orbs = new Batch(s, new THREE.SphereGeometry(0.025, 6, 4), new THREE.MeshBasicMaterial(), 2000, { cast: false });

    // Particles.
    const pg = new THREE.BufferGeometry();
    this.pPos = new Float32Array(2000 * 3);
    this.pCol = new Float32Array(2000 * 3);
    pg.setAttribute('position', new THREE.BufferAttribute(this.pPos, 3).setUsage(THREE.DynamicDrawUsage));
    pg.setAttribute('color', new THREE.BufferAttribute(this.pCol, 3).setUsage(THREE.DynamicDrawUsage));
    this.points = new THREE.Points(pg, new THREE.PointsMaterial({ size: 0.09, vertexColors: true, transparent: true, depthWrite: false }));
    this.points.frustumCulled = false;
    s.add(this.points);

    // Rain and snow: a box of falling points that follows the camera target.
    const wg = new THREE.BufferGeometry();
    this.wPos = new Float32Array(2500 * 3);
    for (let i = 0; i < 2500; i++) {
      this.wPos[i * 3] = (Math.random() - 0.5) * 40;
      this.wPos[i * 3 + 1] = Math.random() * 14;
      this.wPos[i * 3 + 2] = (Math.random() - 0.5) * 40;
    }
    wg.setAttribute('position', new THREE.BufferAttribute(this.wPos, 3).setUsage(THREE.DynamicDrawUsage));
    this.precip = new THREE.Points(wg, new THREE.PointsMaterial({ color: 0xaecbe6, size: 0.06, transparent: true, opacity: 0.7, depthWrite: false }));
    this.precip.frustumCulled = false;
    this.precip.visible = false;
    s.add(this.precip);
    this.flash = 0;
    this.umbrellas = new Batch(s, new THREE.ConeGeometry(0.2, 0.08, 8), white.clone(), 600, { cast: false });

    // Projectiles.
    this.hotdogs = new Batch(s, new THREE.CapsuleGeometry(0.03, 0.14, 3, 6), M(0xb5532b), 100, { cast: false });
    this.buns = new Batch(s, new THREE.CapsuleGeometry(0.04, 0.1, 3, 6), M(0xe8b86a), 100, { cast: false });
    this.bamboo = new Batch(s, new THREE.CylinderGeometry(0.018, 0.018, 0.32, 5), M(0x6aa84f), 100, { cast: false });
  }

  buildOverlays() {
    const plane = new THREE.PlaneGeometry(1, 1);
    plane.rotateX(-Math.PI / 2);
    this.overlay = new Batch(this.scene, plane, new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.45, depthWrite: false }), 600, { cast: false });
    this.overlay.mesh.renderOrder = 2;
    const ring = new THREE.TorusGeometry(0.2, 0.02, 6, 24);
    ring.rotateX(-Math.PI / 2);
    this.ring = mesh(ring, new THREE.MeshBasicMaterial({ color: 0xffe24d }), { cast: false, receive: false });
    this.ring.visible = false;
    this.scene.add(this.ring);
    // Coaster builder: arrow for the next piece.
    const arrow = new THREE.Group();
    const shaft = box(0.08, 0.04, 0.5, 0xffd23f, { emissive: 0x664400 });
    shaft.position.z = -0.1;
    const head = mesh(new THREE.ConeGeometry(0.16, 0.3, 4), M(0xffd23f, { emissive: 0x664400 }));
    head.rotation.x = -Math.PI / 2;
    head.position.z = -0.45;
    arrow.add(shaft, head);
    arrow.visible = false;
    this.cursorArrow = arrow;
    this.scene.add(arrow);
    this.preview = new THREE.Group();
    this.scene.add(this.preview);
  }

  // ------------------------------------------------------------------
  // Frame
  // ------------------------------------------------------------------

  render(park, view, dt) {
    const t = view.time;
    this.raid = !!park.raid;
    this.applyClimate(park.settings?.climate || 'temperate');
    this.weather = weatherOf(park);
    this.updateSky(view.dayProgress);
    this.updatePrecip(dt);
    for (const f of (park._fx || []).splice(0)) this.addFx(f);

    this.syncGround(park);
    this.syncObjects(park, t, dt);
    this.drawPeople(park, t, view);
    this.drawScenery(park, t);
    this.drawOverlay(park, view);
    this.drawCoasterPreview(park, view);
    this.drawShots(dt);
    this.drawParticles(dt);

    this.fence.visible = !!park.fence;
    this.gate.visible = !!park.locked;
    if (park.locked) this.padlock.material.emissive.setHex(Math.floor(t * 3) % 2 ? 0x662200 : 0x221100);
    const signMat = park.open ? this.signTex.open : this.signTex.closed;
    if (this.sign.material[4].map !== signMat) {
      this.sign.material[4].map = this.sign.material[5].map = signMat;
      this.sign.material[4].needsUpdate = this.sign.material[5].needsUpdate = true;
    }

    this.gl.render(this.scene, this.camera);
    this.drawFloaters(dt);
  }

  updateSky(p) {
    this.dusk = p > 0.75 ? Math.sin(((p - 0.75) / 0.25) * Math.PI) : 0;
    const d = this.dusk, W = this.weather || { sky: 0x9fd3f2, light: 1 };
    this.flash = Math.max(0, this.flash - 0.016);
    const flash = this.flash > 0.2 || (this.flash > 0.05 && this.flash < 0.12) ? 2.5 : 0;
    this.sun.intensity = 2.6 * W.light * (1 - d * 0.75) + flash;
    this.sun.color.setRGB(1, 0.95 - d * 0.35, 0.84 - d * 0.5);
    this.hemi.intensity = 1.1 * Math.min(1.2, 0.2 + W.light * 0.8) * (1 - d * 0.5) + flash * 0.6;
    this.gl.toneMappingExposure = 1.05 * (0.55 + Math.min(1.2, W.light) * 0.45);
    const sky = new THREE.Color(W.sky).lerp(new THREE.Color(0x3b2f6b), d * 0.85);
    this.scene.background.copy(sky);
    this.scene.fog.color.copy(sky);
    this.scene.fog.near = W.fog ? 8 : W.precip ? 30 : 60;
    this.scene.fog.far = W.fog ? 38 : W.precip ? 90 : 140;
    // Sun swings across the sky during the day.
    const a = (p - 0.5) * 1.6;
    this.sun.position.set(GRID / 2 + Math.sin(a) * 30, 40 - Math.abs(a) * 8, GRID / 2 - 14);
  }

  updatePrecip(dt) {
    const W = this.weather;
    const kind = W?.precip;
    this.precip.visible = !!kind;
    if (!kind) return;
    const snow = kind === 'snow';
    this.precip.material.color.setHex(snow ? 0xffffff : 0xaecbe6);
    this.precip.material.size = snow ? 0.1 : 0.07;
    this.precip.material.opacity = snow ? 0.95 : 0.85;
    const fall = (snow ? 1.2 : 9) * dt, drift = snow ? 0.3 * dt : 0.6 * dt;
    const pos = this.wPos;
    for (let i = 0; i < pos.length; i += 3) {
      pos[i + 1] -= fall * (0.7 + (i % 7) * 0.05);
      pos[i] += drift * Math.sin(i + pos[i + 1]);
      if (pos[i + 1] < 0) pos[i + 1] += 14;
    }
    this.precip.position.set(this.target.x, 0, this.target.z);
    this.precip.geometry.attributes.position.needsUpdate = true;
  }

  syncGround(park) {
    let sig = 0;
    for (let i = 0; i < park.tiles.length; i++) {
      sig = (sig * 31 + park.tiles[i] * 7 + park.litter[i] * 3 + park.stains[i] + (park.pathStyles?.[i] || 0) * 13) | 0;
    }
    if (sig === this.groundSig) return;
    this.groundSig = sig;
    this.paths.begin(); this.pathEdges.begin(); this.litter.begin(); this.stains.begin();
    for (let y = 0; y < GRID; y++) {
      for (let x = 0; x < GRID; x++) {
        const i = idx(x, y);
        const tile = park.tiles[i];
        if (tile === TILE.GRASS) continue;
        const style = PATH_STYLES[park.pathStyles?.[i] || 0] || PATH_STYLES[0];
        this.pathEdges.add(compose(x + 0.5, 0.015, y + 0.5), tile === TILE.ENTRANCE ? 0x9c8a6e : style.edge);
        this.paths.add(compose(x + 0.5, 0.025, y + 0.5, 0, 0.9, 1, 0.9), tile === TILE.ENTRANCE ? 0xd9b26a : style.color);
        for (let k = 0; k < park.litter[i]; k++) {
          this.litter.add(compose(x + 0.2 + hash(i * 7 + k) * 0.6, 0.055, y + 0.2 + hash(i * 13 + k) * 0.6, hash(i + k) * 3), k % 2 ? 0xf4f4f4 : 0xd6463c);
        }
        for (let k = 0; k < park.stains[i] * 2; k++) {
          const r = 0.06 + hash(i + k * 11) * 0.08 + park.stains[i] * 0.03;
          this.stains.add(compose(x + 0.2 + hash(i * 3 + k) * 0.6, 0.05, y + 0.2 + hash(i * 5 + k) * 0.6, 0, r * 1.3, 1, r));
        }
      }
    }
    this.paths.end(); this.pathEdges.end(); this.litter.end(); this.stains.end();
  }

  // ------------------------------------------------------------------
  // Objects
  // ------------------------------------------------------------------

  syncObjects(park, t, dt) {
    const seen = new Set();
    for (const o of park.objects) {
      if (INSTANCED.has(o.kind)) continue; // drawn by drawScenery
      seen.add(o.id);
      const looks = `${o.color || ''}|${o.trainColor || ''}|${o.cars || ''}`;
      const version = (o.kind === 'custom' ? `${o._version}|${o.building}` : o.kind === 'retribution' ? o.pit : o.kind === 'memorial' ? o.graves : 1) + looks;
      let entry = this.objects.get(o.id);
      if (entry && entry.version !== version) {
        this.scene.remove(entry.group);
        entry = null;
      }
      if (!entry) {
        entry = this.buildObject(o);
        entry.version = version;
        entry.group.userData.objId = o.id;
        entry.group.traverse((m) => { if (m.isMesh && m.userData.objId === undefined) m.userData.objId = o.id; });
        this.scene.add(entry.group);
        this.objects.set(o.id, entry);
      }
      entry.animate?.(o, t, dt);
      if (entry.badge) {
        const show = o.broken ? '⚠️' : o.open === false && !o.building ? '⛔' : o.exposed ? '💊' : null;
        entry.badge.visible = !!show;
        if (show && entry.badge.userData.emoji !== show) {
          entry.badge.material.map = emojiCache.get(show) || emojiSprite(show).material.map;
          entry.badge.material.needsUpdate = true;
          entry.badge.userData.emoji = show;
        }
        if (show) entry.badge.position.y = entry.badgeY + Math.sin(t * 4) * 0.05;
      }
    }
    for (const [id, entry] of this.objects) {
      if (!seen.has(id)) { this.scene.remove(entry.group); this.objects.delete(id); }
    }
  }

  buildObject(o) {
    const group = new THREE.Group();
    const cx = o.x + o.w / 2, cz = o.y + o.h / 2;
    let animate = null, badgeY = 0;
    const ride = RIDES[o.kind];
    if (o.kind === 'custom') {
      ({ animate, badgeY } = this.buildCustomCoaster(o, group));
    } else if (ride) {
      group.position.set(cx, 0, cz);
      ({ animate, badgeY } = this.buildRide(o, ride, group));
    } else if (STALLS[o.kind]) {
      group.position.set(cx, 0, cz);
      this.buildStall(o, STALLS[o.kind], group);
      badgeY = 1.3;
    } else if (o.kind === 'securityhq') {
      group.position.set(cx, 0, cz);
      animate = this.buildHQ(o, group);
    } else if (o.kind === 'retribution') {
      group.position.set(cx, 0, cz);
      animate = this.buildRig(o, group);
    } else if (o.kind === 'memorial') {
      group.position.set(cx, 0, cz);
      animate = this.buildMemorial(o, group);
    } else {
      group.position.set(cx, 0, cz);
      animate = this.buildSceneryObject(o, group);
    }
    let badge = null;
    if (ride || STALLS[o.kind] || o.kind === 'custom') {
      badge = new THREE.Sprite(new THREE.SpriteMaterial({ depthWrite: false, depthTest: false }));
      badge.scale.set(0.45, 0.45, 0.45);
      badge.visible = false;
      badge.renderOrder = 5;
      if (o.kind === 'custom') {
        const s = o._stationCells?.[0] || [o.x, o.y];
        badge.position.set(s[0] + 0.5, 0, s[1] + 0.5);
        badgeY = 1.6;
      }
      group.add(badge);
    }
    return { group, animate, badge, badgeY };
  }

  buildRide(o, baseDef, g) {
    const running = (obj) => obj.phase === 'running';
    const def = o.color ? { ...baseDef, color: o.color } : baseDef;
    switch (o.kind) {
      case 'teacups': {
        const base = cyl(0.95, 1, 0.12, 0xf7d6e6, 24); base.position.y = 0.06; g.add(base);
        const spin = new THREE.Group(); spin.position.y = 0.12; g.add(spin);
        const colors = [0xef6fa8, 0x5aa9e6, 0xf2b84b, 0x7bd389];
        const cups = colors.map((c, k) => {
          const cup = new THREE.Group();
          const body = cyl(0.22, 0.15, 0.22, c, 14); body.position.y = 0.11;
          const rim = mesh(new THREE.TorusGeometry(0.21, 0.025, 6, 16), M(0xffffff)); rim.rotation.x = Math.PI / 2; rim.position.y = 0.22;
          cup.add(body, rim);
          const a = (k / 4) * Math.PI * 2;
          cup.position.set(Math.cos(a) * 0.55, 0, Math.sin(a) * 0.55);
          spin.add(cup);
          return cup;
        });
        const hub = cyl(0.12, 0.15, 0.5, 0xffffff); hub.position.y = 0.25; g.add(hub);
        return { badgeY: 1.2, animate: (obj, t, dt) => { if (running(obj)) { spin.rotation.y += dt * 1.6; cups.forEach((c) => { c.rotation.y += dt * 4; }); } } };
      }
      case 'carousel': {
        const base = cyl(0.95, 0.95, 0.14, 0xf6e3b4, 24); base.position.y = 0.07; g.add(base);
        const spin = new THREE.Group(); g.add(spin);
        const pole = cyl(0.06, 0.06, 1.1, 0xd4af37); pole.position.y = 0.6; spin.add(pole);
        const roofMat = new THREE.MeshStandardMaterial({ map: stripeTexture('#e5484d', '#ffffff', 12), flatShading: true, roughness: 0.6 });
        const roof = mesh(new THREE.ConeGeometry(1, 0.45, 24), roofMat); roof.position.y = 1.3; spin.add(roof);
        const horses = [];
        for (let k = 0; k < 6; k++) {
          const a = (k / 6) * Math.PI * 2;
          const p = cyl(0.015, 0.015, 1.05, 0xd4af37, 6); p.position.set(Math.cos(a) * 0.7, 0.62, Math.sin(a) * 0.7); spin.add(p);
          const h = box(0.08, 0.12, 0.26, k % 2 ? 0xffffff : 0x8b5a2b); h.position.set(Math.cos(a) * 0.7, 0.45, Math.sin(a) * 0.7); h.rotation.y = -a; spin.add(h);
          horses.push(h);
        }
        return { badgeY: 1.8, animate: (obj, t, dt) => {
          if (!running(obj)) return;
          spin.rotation.y += dt * 1.2;
          horses.forEach((h, k) => { h.position.y = 0.45 + Math.sin(t * 4 + k) * 0.08; });
        } };
      }
      case 'skywheel': {
        const base = box(1.6, 0.12, 1.2, 0xc9d6e3); base.position.y = 0.06; g.add(base);
        const R = 1.25, hubY = 1.55;
        for (const sz of [-0.35, 0.35]) {
          for (const sx of [-1, 1]) {
            const leg = box(0.07, 1.75, 0.07, 0x5b6b7a);
            leg.position.set(sx * 0.42, 0.85, sz); leg.rotation.z = sx * 0.27; g.add(leg);
          }
        }
        const wheel = new THREE.Group(); wheel.position.y = hubY; g.add(wheel);
        for (const sz of [-0.25, 0.25]) {
          const rim = mesh(new THREE.TorusGeometry(R, 0.035, 6, 40), M(new THREE.Color(def.color).getHex())); rim.position.z = sz; wheel.add(rim);
        }
        const cabins = [];
        const colors = [0xe5484d, 0xf2b84b, 0x7bd389, 0x9b6bd6, 0xef6fa8, 0xffffff];
        for (let k = 0; k < 12; k++) {
          const a = (k / 12) * Math.PI * 2;
          const spoke = box(0.025, R, 0.025, 0xb8c4d0); spoke.position.set(Math.cos(a) * R / 2, Math.sin(a) * R / 2, 0); spoke.rotation.z = a - Math.PI / 2; wheel.add(spoke);
          const cab = box(0.22, 0.2, 0.3, colors[k % colors.length]); cab.position.set(Math.cos(a) * R, Math.sin(a) * R - 0.12, 0); wheel.add(cab);
          cabins.push(cab);
        }
        const axle = cyl(0.08, 0.08, 0.8, 0x333333); axle.rotation.x = Math.PI / 2; axle.position.y = hubY; g.add(axle);
        // Face the wheel along the longer side.
        return { badgeY: 3.2, animate: (obj, t, dt) => {
          if (running(obj)) wheel.rotation.z += dt * 0.35;
          cabins.forEach((c) => { c.rotation.z = -wheel.rotation.z; });
        } };
      }
      case 'bumper': {
        const floor = box(o.w - 0.1, 0.1, o.h - 0.1, 0x3b4a5a); floor.position.y = 0.05; g.add(floor);
        const inner = box(o.w - 0.4, 0.02, o.h - 0.4, 0x26323e); inner.position.y = 0.11; g.add(inner);
        for (const [x, z, w, d] of [[0, -(o.h / 2 - 0.1), o.w - 0.1, 0.06], [0, o.h / 2 - 0.1, o.w - 0.1, 0.06], [-(o.w / 2 - 0.1), 0, 0.06, o.h - 0.1], [o.w / 2 - 0.1, 0, 0.06, o.h - 0.1]]) {
          const wall = box(w, 0.18, d, 0xffd23f); wall.position.set(x, 0.18, z); g.add(wall);
        }
        for (const [x, z] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
          const p = cyl(0.03, 0.03, 0.9, 0x999999, 6); p.position.set(x * (o.w / 2 - 0.15), 0.5, z * (o.h / 2 - 0.15)); g.add(p);
        }
        const roof = box(o.w - 0.2, 0.03, o.h - 0.2, 0x555555, { transparent: true, opacity: 0.35 }); roof.position.y = 0.95; roof.castShadow = false; g.add(roof);
        const colors = [0xe5484d, 0xf2b84b, 0x5aa9e6, 0x7bd389, 0xef6fa8];
        const cars = colors.map((c) => {
          const car = new THREE.Group();
          const b = box(0.22, 0.1, 0.3, c); b.position.y = 0.17;
          const rod = cyl(0.008, 0.008, 0.75, 0x999999, 4); rod.position.set(0, 0.55, 0.1);
          car.add(b, rod);
          g.add(car);
          return car;
        });
        return { badgeY: 1.4, animate: (obj, t) => {
          cars.forEach((car, k) => {
            const a = (running(obj) ? t : 0) * (0.8 + k * 0.23) + k * 1.7;
            car.position.set(Math.cos(a) * (o.w / 2 - 0.45), 0, Math.sin(a * 1.3) * (o.h / 2 - 0.45));
            car.rotation.y = -a;
          });
        } };
      }
      case 'chairswing': {
        const base = cyl(0.95, 1, 0.12, 0xdfe8e6, 24); base.position.y = 0.06; g.add(base);
        const pole = cyl(0.09, 0.12, 2.1, 0x9aa4b0, 10); pole.position.y = 1.1; g.add(pole);
        const top = new THREE.Group(); top.position.y = 2.15; g.add(top);
        const canopy = mesh(new THREE.ConeGeometry(0.75, 0.4, 16), new THREE.MeshStandardMaterial({ map: stripeTexture(def.color, '#ffffff', 16), flatShading: true })); canopy.position.y = 0.15; top.add(canopy);
        const swings = [];
        for (let k = 0; k < 12; k++) {
          const arm = new THREE.Group(); arm.rotation.y = (k / 12) * Math.PI * 2; top.add(arm);
          const hanger = new THREE.Group(); hanger.position.x = 0.62; arm.add(hanger);
          const chain = cyl(0.006, 0.006, 1.1, 0x666666, 4); chain.position.y = -0.55; hanger.add(chain);
          const seat = box(0.12, 0.04, 0.12, k % 2 ? 0xffffff : new THREE.Color(def.color).getHex()); seat.position.y = -1.1; hanger.add(seat);
          swings.push(hanger);
        }
        let spin = 0;
        return { badgeY: 2.8, animate: (obj, t, dt) => {
          spin = running(obj) ? Math.min(1, spin + dt * 0.5) : Math.max(0, spin - dt * 0.5);
          top.rotation.y += dt * spin * 2.2;
          top.position.y = 2.15 + spin * 0.25;
          swings.forEach((h) => { h.rotation.z = spin * 0.85; });
        } };
      }
      case 'pirateship': {
        const base = box(o.w - 0.2, 0.1, o.h - 0.2, 0x6b7c8a); base.position.y = 0.05; g.add(base);
        for (const z of [-0.55, 0.55]) {
          for (const x of [-1, 1]) {
            const leg = box(0.08, 2.1, 0.08, 0x5b6b7a); leg.position.set(x * 0.55, 1.0, z); leg.rotation.z = -x * 0.28; g.add(leg);
          }
        }
        const pivot = new THREE.Group(); pivot.position.y = 1.95; g.add(pivot);
        const ship = new THREE.Group(); ship.position.y = -1.35; pivot.add(ship);
        const hull = mesh(new THREE.CylinderGeometry(0.42, 0.42, 2.4, 12, 1, false, Math.PI / 2, Math.PI), M(new THREE.Color(def.color).getHex()));
        hull.rotation.z = Math.PI / 2; ship.add(hull);
        const deck = box(2.3, 0.04, 0.8, 0xc9a26b); deck.position.y = 0.0; ship.add(deck);
        const mast = cyl(0.03, 0.03, 0.9, 0x6b4423, 6); mast.position.y = 0.45; ship.add(mast);
        const sail = box(0.02, 0.5, 0.5, 0xffffff); sail.position.set(0, 0.55, 0); sail.rotation.y = Math.PI / 2; ship.add(sail);
        for (const x of [-1.2, 1.2]) { const tip = mesh(new THREE.ConeGeometry(0.12, 0.35, 6), M(0xd4af37)); tip.position.set(x, 0.12, 0); tip.rotation.z = x > 0 ? -Math.PI / 2 : Math.PI / 2; ship.add(tip); }
        const arm = box(0.06, 1.35, 0.06, 0x444444); arm.position.y = -0.67; pivot.add(arm);
        return { badgeY: 2.8, animate: (obj) => {
          const p = running(obj) ? 1 - obj.timer / def.duration : 0;
          const amp = Math.sin(Math.min(1, p) * Math.PI) * 1.15;
          pivot.rotation.z = Math.sin(p * Math.PI * 10) * amp;
        } };
      }
      case 'droptower': {
        const base = box(1.6, 0.14, 1.6, 0xd9cdf0); base.position.y = 0.07; g.add(base);
        const tower = box(0.24, 4.2, 0.24, 0x9aa4b0); tower.position.y = 2.2; g.add(tower);
        const tip = sphere(0.07, 0xff3b30, { emissive: 0xff0000, emissiveIntensity: 0.6 }); tip.position.y = 4.35; g.add(tip);
        const car = new THREE.Group();
        const ring = cyl(0.5, 0.5, 0.18, def.color, 16); car.add(ring);
        for (let k = 0; k < 8; k++) {
          const seat = box(0.12, 0.2, 0.08, 0xffffff); const a = (k / 8) * Math.PI * 2;
          seat.position.set(Math.cos(a) * 0.52, -0.12, Math.sin(a) * 0.52); seat.rotation.y = -a; car.add(seat);
        }
        g.add(car);
        return { badgeY: 4.7, animate: (obj) => {
          let h = 0.35;
          if (running(obj)) {
            const p = 1 - obj.timer / def.duration;
            if (p < 0.55) h = 0.35 + (p / 0.55) * 3.4;
            else if (p < 0.7) h = 3.75;
            else if (p < 0.78) h = 3.75 - ((p - 0.7) / 0.08) * 3.4;
          }
          car.position.y = h;
        } };
      }
      default:
        if (def.coaster) return this.buildPrefabCoaster(o, def, g);
    }
    return { badgeY: 1.5 };
  }

  /** Prefab coasters: an elliptical circuit with hills (and a loop on the looper). */
  buildPrefabCoaster(o, def, g) {
    const rx = o.w / 2 - 0.45, rz = o.h / 2 - 0.45;
    const lift = def.loop ? 2.0 : 1.5;
    const pts = [];
    const N = 120;
    for (let k = 0; k < N; k++) {
      const th = (k / N) * Math.PI * 2;
      const h = 0.35 + (1 + Math.sin(th * 2 + 0.6)) * lift * 0.5 + Math.max(0, Math.sin(th)) * 0.4;
      pts.push(new THREE.Vector3(Math.cos(th) * rx, h, Math.sin(th) * rz));
    }
    const curve = new THREE.CatmullRomCurve3(pts, true);
    this.addTrack(g, curve, def.color, def.loop ? 0x8b98a6 : 0x8a5a33, !def.loop);
    if (def.loop) {
      const p = curve.getPointAt(0.1);
      const loop = mesh(new THREE.TorusGeometry(0.75, 0.04, 6, 32), M(def.color));
      loop.position.set(p.x, p.y + 0.75, p.z);
      loop.lookAt(new THREE.Vector3(p.x, p.y + 0.75, p.z).add(curve.getTangentAt(0.1).cross(new THREE.Vector3(0, 1, 0))));
      g.add(loop);
    }
    const station = box(Math.min(2, o.w - 0.4), 0.25, 0.7, 0xb9a27f);
    station.position.set(-o.w / 2 + 0.2 + Math.min(2, o.w - 0.4) / 2, 0.12, o.h / 2 - 0.55);
    g.add(station);
    const cars = this.makeTrain(g, 4);
    return { badgeY: 3, animate: (obj) => {
      const base = obj.phase === 'running' ? 0.25 + (1 - obj.timer / def.duration) * 2 : 0.25;
      cars.forEach((car, k) => {
        const u = (((base - k * 0.025) % 1) + 1) % 1;
        const p = curve.getPointAt(u), tan = curve.getTangentAt(u);
        car.position.copy(p).y += 0.08;
        car.lookAt(p.clone().add(tan));
      });
    } };
  }

  makeTrain(g, n, color = 0xffffff) {
    const cars = [];
    for (let k = 0; k < n; k++) {
      const car = new THREE.Group();
      const body = box(0.22, 0.12, 0.34, k === 0 ? 0xffd23f : color);
      body.position.y = 0.06;
      const seatA = box(0.18, 0.08, 0.06, 0x333333); seatA.position.set(0, 0.14, -0.06);
      const seatB = seatA.clone(); seatB.position.z = 0.08;
      car.add(body, seatA, seatB);
      g.add(car);
      cars.push(car);
    }
    return cars;
  }

  /** Twin rails, cross ties and supports along a curve. */
  addTrack(g, curve, railColor, supportColor, wooden, opts = {}) {
    const segs = opts.segments || 300;
    const frames = curve.computeFrenetFrames(segs, curve.closed);
    const left = [], right = [];
    const banks = opts.bank;
    for (let i = 0; i <= segs; i++) {
      const u = i / segs;
      const p = curve.getPointAt(u);
      const tan = curve.getTangentAt(u);
      let side = new THREE.Vector3().crossVectors(tan, opts.upAt ? opts.upAt(u) : new THREE.Vector3(0, 1, 0)).normalize();
      if (!Number.isFinite(side.x) || side.lengthSq() < 0.5) side = frames.binormals[i % frames.binormals.length].clone();
      if (banks) side.applyAxisAngle(tan, banks(u));
      left.push(p.clone().addScaledVector(side, 0.11));
      right.push(p.clone().addScaledVector(side, -0.11));
    }
    const closed = curve.closed;
    for (const pts of [left, right]) {
      const c = new THREE.CatmullRomCurve3(pts, closed);
      g.add(mesh(new THREE.TubeGeometry(c, segs, 0.025, 6, closed), M(railColor, { metalness: 0.4, roughness: 0.4 })));
    }
    // Ties and supports.
    const ties = [], supports = [];
    for (let i = 0; i < segs; i += 2) {
      const a = left[i], b = right[i];
      ties.push([a, b, opts.tieColor ? opts.tieColor(i / segs) : 0x5b4a3a]);
      if (i % (wooden ? 6 : 10) === 0) {
        const m = a.clone().add(b).multiplyScalar(0.5);
        if (m.y > 0.2 && (!opts.supportAt || opts.supportAt(i / segs))) supports.push(m);
      }
    }
    const tieMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 0.025, 0.05), new THREE.MeshStandardMaterial({ roughness: 0.8 }), ties.length);
    ties.forEach(([a, b, c], k) => {
      const mid = a.clone().add(b).multiplyScalar(0.5);
      const dir = b.clone().sub(a);
      const m = new THREE.Matrix4().lookAt(a, b, new THREE.Vector3(0, 1, 0));
      _q.setFromRotationMatrix(m);
      _q.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2));
      tieMesh.setMatrixAt(k, new THREE.Matrix4().compose(mid.setY(mid.y - 0.03), _q, new THREE.Vector3(dir.length() + 0.04, 1, 1)));
      tieMesh.setColorAt(k, new THREE.Color(c));
    });
    tieMesh.castShadow = true;
    g.add(tieMesh);
    const supMesh = new THREE.InstancedMesh(new THREE.CylinderGeometry(wooden ? 0.035 : 0.03, wooden ? 0.05 : 0.04, 1, 6), M(supportColor), supports.length * (wooden ? 2 : 1));
    let k = 0;
    for (const s of supports) {
      if (wooden) {
        for (const off of [-0.12, 0.12]) supMesh.setMatrixAt(k++, compose(s.x + off, s.y / 2 - 0.04, s.z, 0, 1, s.y, 1));
      } else {
        supMesh.setMatrixAt(k++, compose(s.x, s.y / 2 - 0.04, s.z, 0, 1, s.y, 1));
      }
    }
    supMesh.count = k;
    supMesh.castShadow = true;
    g.add(supMesh);
  }

  /** Player-designed coaster built from its track samples. */
  buildCustomCoaster(o, g) {
    const start = { x: o.x, y: o.y, dir: o.track.dir };
    const pieces = o.track.pieces;
    const pts = Coaster.samples(start, pieces);
    const complete = Coaster.isComplete(start, pieces);
    const design = o._design?.ok ? o._design : null;
    // Station platforms.
    for (const [x, y] of o._stationCells || []) {
      const plat = box(1, 0.2, 1, 0xb9a27f); plat.position.set(x + 0.5, 0.1, y + 0.5); g.add(plat);
      for (const [dx, dz] of [[0.1, 0.1], [0.9, 0.1], [0.1, 0.9], [0.9, 0.9]]) {
        const p = cyl(0.03, 0.03, 0.9, 0x888888, 6); p.position.set(x + dx, 0.55, y + dz); g.add(p);
      }
      const roof = box(1.1, 0.06, 1.1, 0x3a86ff); roof.position.set(x + 0.5, 1.0, y + 0.5); g.add(roof);
    }
    if (pts.length < 2) return { badgeY: 1.6, animate: null };
    const v3 = pts.map((p) => new THREE.Vector3(p.x, p.y + 0.12, p.z));
    if (!complete) {
      const last = Coaster.layout(start, pieces).cursor;
      v3.push(new THREE.Vector3(last.x + 0.5 - Coaster.DIRS[last.dir][0] * 0.5, last.h * Coaster.STEP + 0.12, last.y + 0.5 - Coaster.DIRS[last.dir][1] * 0.5));
    }
    const curve = new THREE.CatmullRomCurve3(v3, complete, 'centripetal');
    const n = pts.length;
    const at = (u) => pts[Math.min(n - 1, Math.floor(u * n))];
    const tieColor = (u) => {
      const p = at(u);
      return p.chain ? 0x333333 : p.boost ? 0xffc400 : p.brake ? 0xd62828 : p.station ? 0x777777 : 0x5b4a3a;
    };
    const bankArr = design?.bank;
    const railColor = o.color ? new THREE.Color(o.color).getHex() : 0x3a86ff;
    this.addTrack(g, curve, o.building ? new THREE.Color(railColor).lerp(new THREE.Color(0xffffff), 0.4).getHex() : railColor, 0xb0b8c4, false, {
      segments: Math.min(1600, Math.max(60, n * 2)),
      tieColor,
      upAt: (u) => { const p = at(u); return new THREE.Vector3(p.up[0], p.up[1], p.up[2]); },
      bank: bankArr ? (u) => -(bankArr[Math.min(n - 1, Math.floor(u * n))] || 0) : null,
      supportAt: (u) => !at(u).loop || at(u).y < 0.6,
    });
    // Loop pieces need a support under the bottom only; add a gantry.
    const cars = this.makeTrain(g, o.cars || 4, o.trainColor ? new THREE.Color(o.trainColor).getHex() : 0xe5484d);
    // Arc length lookup for positioning cars.
    const arc = new Float64Array(n + 1);
    for (let i = 1; i <= n; i++) {
      const a = pts[i - 1], b = pts[i % n];
      arc[i] = arc[i - 1] + Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
    }
    const total = arc[n];
    const posAt = (s) => {
      s = ((s % total) + total) % total;
      let lo = 0, hi = n;
      while (lo < hi - 1) { const mid = (lo + hi) >> 1; if (arc[mid] <= s) lo = mid; else hi = mid; }
      const a = pts[lo], b = pts[(lo + 1) % n];
      const f = (s - arc[lo]) / Math.max(1e-6, arc[lo + 1] - arc[lo]);
      return {
        p: new THREE.Vector3(a.x + (b.x - a.x) * f, a.y + (b.y - a.y) * f + 0.14, a.z + (b.z - a.z) * f),
        up: new THREE.Vector3(a.up[0], a.up[1], a.up[2]),
        bank: bankArr ? bankArr[lo] || 0 : 0,
      };
    };
    const timeToArc = (tt) => {
      const times = design.times;
      let lo = 0, hi = times.length - 1;
      while (lo < hi - 1) { const mid = (lo + hi) >> 1; if (times[mid] <= tt) lo = mid; else hi = mid; }
      const f = (tt - times[lo]) / Math.max(1e-6, times[lo + 1] - times[lo]);
      return arc[lo] + (arc[Math.min(lo + 1, n)] - arc[lo]) * f;
    };
    cars.forEach((c) => { c.visible = complete; });
    const stationArc = 0.6;
    return {
      badgeY: 1.6,
      animate: (obj) => {
        if (!complete) return;
        let head = stationArc;
        if (design && obj.phase === 'running') {
          const dur = design.duration + 2;
          const elapsed = Math.max(0, dur - obj.timer - 1); // 1 s dwell each end
          head = timeToArc(Math.min(design.duration, elapsed)) + stationArc;
        }
        cars.forEach((car, k) => {
          const s = head - k * 0.42;
          const { p, up, bank } = posAt(s);
          const ahead = posAt(s + 0.1).p;
          car.position.copy(p);
          car.up.copy(up);
          car.lookAt(ahead);
          car.rotateZ(-bank);
        });
      },
    };
  }

  buildStall(o, baseDef, g) {
    const def = o.color ? { ...baseDef, color: o.color } : baseDef;
    const restroom = def.sells === 'restroom' || def.sells === 'firstaid';
    const body = box(0.72, 0.62, 0.72, restroom ? 0xdfe6ec : 0xf4efe6); body.position.y = 0.31; g.add(body);
    const counter = box(0.76, 0.06, 0.2, 0x8b5a2b); counter.position.set(0, 0.42, 0.38); g.add(counter);
    const awningMat = new THREE.MeshStandardMaterial({ map: stripeTexture(def.color, '#ffffff', 8), roughness: 0.6, side: THREE.DoubleSide });
    const awning = mesh(new THREE.BoxGeometry(0.84, 0.03, 0.4), awningMat); awning.position.set(0, 0.72, 0.42); awning.rotation.x = 0.35; g.add(awning);
    const roof = box(0.8, 0.08, 0.8, new THREE.Color(def.color).getHex()); roof.position.y = 0.66; g.add(roof);
    const sign = emojiSprite(def.icon, 0.42); sign.position.y = 1.0; g.add(sign);
  }

  buildSceneryObject(o, g) {
    switch (o.kind) {
      case 'fountain': {
        const basin = cyl(0.95, 1, 0.22, 0xb8b2a7, 24); basin.position.y = 0.11; g.add(basin);
        const water = cyl(0.85, 0.85, 0.04, 0x4fa3d9, 24, { roughness: 0.15, metalness: 0.2 }); water.position.y = 0.2; water.castShadow = false; g.add(water);
        const col = cyl(0.08, 0.12, 0.6, 0x9b9488); col.position.y = 0.45; g.add(col);
        const drops = [];
        for (let k = 0; k < 14; k++) { const d = sphere(0.025, 0xc8ebff, { transparent: true, opacity: 0.85 }); d.castShadow = false; g.add(d); drops.push(d); }
        return (obj, t) => drops.forEach((d, k) => {
          const ph = (t * 1.2 + k / 14) % 1, a = (k / 14) * Math.PI * 2;
          d.position.set(Math.cos(a) * ph * 0.6, 0.75 + Math.sin(ph * Math.PI) * 0.4 - ph * 0.5, Math.sin(a) * ph * 0.6);
        });
      }
      case 'bench': {
        const seat = box(0.5, 0.04, 0.18, 0x8b5a2b); seat.position.y = 0.14; g.add(seat);
        const back = box(0.5, 0.16, 0.03, 0x7a4b22); back.position.set(0, 0.24, -0.08); g.add(back);
        for (const x of [-0.2, 0.2]) { const l = box(0.03, 0.14, 0.16, 0x333333); l.position.set(x, 0.07, 0); g.add(l); }
        return null;
      }
      case 'bin': {
        const b = cyl(0.1, 0.09, 0.3, 0x2d5a3d); b.position.y = 0.15; g.add(b);
        const lid = cyl(0.11, 0.11, 0.03, 0x3d7a52); lid.position.y = 0.31; g.add(lid);
        return null;
      }
      case 'lamp': {
        const pole = cyl(0.025, 0.035, 1.2, 0x2f3540, 6); pole.position.y = 0.6; g.add(pole);
        const bulbMat = new THREE.MeshStandardMaterial({ color: 0xfff5d6, emissive: 0xffd27a, emissiveIntensity: 0 });
        const bulb = mesh(new THREE.SphereGeometry(0.08, 10, 8), bulbMat); bulb.position.y = 1.24; g.add(bulb);
        const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(), color: 0xffd27a, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }));
        glow.scale.set(1.6, 1.6, 1); glow.position.y = 1.2; g.add(glow);
        return () => { bulbMat.emissiveIntensity = 0.2 + this.dusk * 3; glow.material.opacity = this.dusk * 0.5; };
      }
      case 'camera': {
        const pole = cyl(0.02, 0.03, 0.95, 0x5c6470, 6); pole.position.y = 0.48; g.add(pole);
        const head = new THREE.Group(); head.position.y = 0.98; g.add(head);
        const cam = box(0.1, 0.08, 0.2, 0xe8ecf0); cam.position.z = 0.06; head.add(cam);
        const lens = cyl(0.03, 0.03, 0.04, 0x20252b, 8); lens.rotation.x = Math.PI / 2; lens.position.z = 0.17; head.add(lens);
        const led = sphere(0.015, 0xff3b30, { emissive: 0xff0000 }); led.position.set(0.04, 0.05, 0.1); head.add(led);
        return (obj, t) => { head.rotation.y = Math.sin(t * 0.8 + o.id) * 0.9; led.visible = Math.floor(t * 2) % 2 === 0; };
      }
      case 'hedge': {
        const h = box(0.92, 0.42, 0.92, 0x2f6b34); h.position.y = 0.21; g.add(h);
        const top = box(0.86, 0.06, 0.86, 0x3a8040); top.position.y = 0.44; g.add(top);
        return null;
      }
      case 'statue': {
        const plinth = box(0.5, 0.35, 0.5, 0xb8b2a7); plinth.position.y = 0.17; g.add(plinth);
        const col = o.color ? new THREE.Color(o.color).getHex() : 0xc9a24a;
        const body = cyl(0.09, 0.12, 0.5, col, 8, { metalness: 0.5, roughness: 0.35 }); body.position.y = 0.6; g.add(body);
        const head = sphere(0.09, col, { metalness: 0.5, roughness: 0.35 }); head.position.y = 0.93; g.add(head);
        const arm = box(0.06, 0.32, 0.06, col, { metalness: 0.5, roughness: 0.35 }); arm.position.set(0.13, 0.85, 0); arm.rotation.z = -0.6; g.add(arm);
        return null;
      }
      case 'snowman': {
        const b1 = sphere(0.2, 0xffffff); b1.position.y = 0.2; g.add(b1);
        const b2 = sphere(0.14, 0xffffff); b2.position.y = 0.5; g.add(b2);
        const b3 = sphere(0.1, 0xffffff); b3.position.y = 0.72; g.add(b3);
        const nose = mesh(new THREE.ConeGeometry(0.02, 0.1, 6), M(0xff8a3d)); nose.rotation.x = Math.PI / 2; nose.position.set(0, 0.72, 0.13); g.add(nose);
        const hat = cyl(0.07, 0.07, 0.12, 0x222222); hat.position.y = 0.86; g.add(hat);
        return null;
      }
      default: {
        const b = box(0.5, 0.3, 0.5, 0x999999); b.position.y = 0.15; g.add(b);
        return null;
      }
    }
  }

  buildHQ(o, g) {
    const body = box(1.8, 0.95, 1.8, 0x5b7aa6); body.position.y = 0.48; g.add(body);
    const roof = box(1.9, 0.1, 1.9, 0x2b4c7e); roof.position.y = 1.0; g.add(roof);
    const door = box(0.4, 0.55, 0.04, 0x1d2f4d); door.position.set(0, 0.28, 0.91); g.add(door);
    const signMat = new THREE.MeshStandardMaterial({ map: textTexture('SECURITY', { bg: '#1d2f4d', color: '#ffd23f' }) });
    const sign = mesh(new THREE.PlaneGeometry(1.2, 0.3), signMat); sign.position.set(0, 0.78, 0.911); g.add(sign);
    const sirenMat = new THREE.MeshStandardMaterial({ color: 0x777777, emissive: 0x000000 });
    const siren = mesh(new THREE.SphereGeometry(0.12, 12, 8), sirenMat); siren.position.y = 1.15; g.add(siren);
    const light = new THREE.PointLight(0xff2d2d, 0, 6);
    light.position.y = 1.4; g.add(light);
    const pole = cyl(0.015, 0.015, 0.8, 0xcccccc, 6); pole.position.set(-0.7, 1.4, -0.7); g.add(pole);
    const flag = box(0.4, 0.22, 0.01, 0xffd23f); flag.position.set(-0.5, 1.68, -0.7); g.add(flag);
    const dog = box(0.24, 0.06, 0.012, 0xb5532b); dog.position.set(-0.5, 1.68, -0.69); g.add(dog);
    return (obj, t) => {
      const on = Math.floor(t * 6) % 2;
      if (this.raid) {
        sirenMat.color.setHex(on ? 0xff2d2d : 0x2d6bff);
        sirenMat.emissive.setHex(on ? 0xff0000 : 0x0044ff);
        light.color.setHex(on ? 0xff2d2d : 0x2d6bff);
        light.intensity = 6;
      } else {
        sirenMat.color.setHex(0x777777); sirenMat.emissive.setHex(0); light.intensity = 0;
      }
      flag.rotation.y = Math.sin(t * 3) * 0.2;
    };
  }

  buildRig(o, g) {
    const fire = o.pit !== 'water';
    const deck = box(o.w - 0.1, 0.18, o.h - 0.1, 0x3d2b26); deck.position.y = 0.09; g.add(deck);
    const pitX = o.w / 2 - 0.9;
    const flames = [];
    let flameLight = null;
    if (fire) {
      const pit = cyl(0.75, 0.6, 0.12, 0x140805, 20); pit.position.set(pitX, 0.2, 0); g.add(pit);
      const coals = cyl(0.62, 0.62, 0.02, 0xff5a1f, 20, { emissive: 0xff3300, emissiveIntensity: 1.2 }); coals.position.set(pitX, 0.27, 0); g.add(coals);
      for (let k = 0; k < 12; k++) {
        const f = mesh(new THREE.ConeGeometry(0.12, 0.6, 6), new THREE.MeshBasicMaterial({ color: k % 2 ? 0xffc828 : 0xff5a14, transparent: true, opacity: 0.85 }), { cast: false, receive: false });
        const a = (k / 12) * Math.PI * 2;
        f.position.set(pitX + Math.cos(a) * 0.35 * (k % 3 ? 1 : 0.3), 0.55, Math.sin(a) * 0.35 * (k % 3 ? 1 : 0.3));
        g.add(f); flames.push(f);
      }
      flameLight = new THREE.PointLight(0xff7a2a, 4, 5);
      flameLight.position.set(pitX, 1, 0); g.add(flameLight);
    } else {
      const tank = box(1.3, 1.1, 1.3, 0x7fb6d6, { transparent: true, opacity: 0.35, roughness: 0.1 }); tank.position.set(pitX, 0.73, 0); g.add(tank);
      const water = box(1.2, 0.9, 1.2, 0x2f7fb8, { transparent: true, opacity: 0.6 }); water.position.set(pitX, 0.65, 0); water.castShadow = false; g.add(water);
      flames.push(water);
    }
    // Catapult.
    const catX = -o.w / 2 + 0.9;
    const frame = box(0.5, 0.45, 0.5, 0x5a3a1e); frame.position.set(catX, 0.4, 0); g.add(frame);
    const arm = new THREE.Group(); arm.position.set(catX, 0.65, 0); g.add(arm);
    const beam = box(0.08, 1.2, 0.08, 0x7a4b22); beam.position.y = 0.6; arm.add(beam);
    const cup = box(0.25, 0.06, 0.25, 0x4a2d16); cup.position.y = 1.2; arm.add(cup);
    // Cage.
    const cage = new THREE.Group(); cage.position.set(catX, 0.18, o.h / 2 - 0.5); g.add(cage);
    for (let k = 0; k < 8; k++) {
      const bar = cyl(0.012, 0.012, 0.6, 0x999999, 4);
      const a = (k / 8) * Math.PI * 2; bar.position.set(Math.cos(a) * 0.3, 0.3, Math.sin(a) * 0.2); cage.add(bar);
    }
    const cageTop = box(0.66, 0.03, 0.46, 0x777777); cageTop.position.y = 0.6; cage.add(cageTop);
    const flyer = this.makePanda(); g.add(flyer);
    const waiting = [0, 1, 2, 3].map(() => { const p = this.makePanda(0.8); cage.add(p); return p; });
    const per = PANDEMONIUM.showSecondsPerVictim;
    let lastBurst = -1;
    return (obj, t) => {
      flames.forEach((f, k) => {
        if (fire) { f.scale.y = 0.6 + Math.abs(Math.sin(t * 7 + k * 1.7)) * 0.8 + (obj.show ? 0.6 : 0); f.position.y = 0.3 + f.scale.y * 0.3; }
        else f.material.color.setHex(obj.show ? 0x7a1f2a : 0x2f7fb8);
      });
      if (flameLight) flameLight.intensity = 3 + Math.sin(t * 13) * 1.2 + (obj.show ? 3 : 0);
      const show = obj.show;
      const k = show ? Math.floor(show.t / per) : -1;
      const u = show ? (show.t % per) / per : 0;
      let ang = -0.3;
      if (show && k < show.victims.length) ang = u < 0.5 ? -0.3 - u * 1.4 : u < 0.6 ? -1 + ((u - 0.5) / 0.1) * 2.4 : 1.4 - Math.min(1, (u - 0.6) / 0.4) * 1.7;
      arm.rotation.z = -ang;
      const waitingN = show ? Math.max(0, show.victims.length - k - 1) : 0;
      waiting.forEach((p, i) => { p.visible = i < waitingN; p.position.set(-0.15 + (i % 2) * 0.3, 0.05, -0.05 + Math.floor(i / 2) * 0.12); });
      flyer.visible = !!show && k < show.victims.length;
      if (!flyer.visible) return;
      const tip = new THREE.Vector3(0, 1.25, 0).applyAxisAngle(new THREE.Vector3(0, 0, 1), -ang).add(arm.position);
      const pit = new THREE.Vector3(pitX, fire ? 0.35 : 1.0, 0);
      flyer.rotation.set(0, 0, 0);
      flyer.scale.setScalar(1);
      if (u < 0.6) {
        flyer.position.copy(tip);
        flyer.rotation.z = -ang;
      } else if (u < 0.75) {
        const v = (u - 0.6) / 0.15;
        flyer.position.lerpVectors(tip, pit, v);
        flyer.position.y += Math.sin(v * Math.PI) * 2.2;
        flyer.rotation.set(v * 9, 0, v * 14);
      } else {
        const v = (u - 0.75) / 0.25;
        flyer.position.copy(pit);
        if (fire) {
          flyer.position.y -= v * 0.3;
          flyer.rotation.x = Math.PI / 2 * Math.min(1, v * 2);
          const char = Math.round(Math.min(1, v * 1.6) * 8) / 8; // quantised so materials stay cached
          flyer.traverse((m) => { if (m.isMesh) m.material = M(m.userData.black ? 0x111111 : new THREE.Color(0xf5f5f5).lerp(new THREE.Color(0x1a1410), char).getHex()); });
        } else {
          flyer.position.y -= v * 0.7;
          flyer.rotation.z = Math.sin(t * 14) * 0.4 * (1 - v);
        }
        if (k !== lastBurst) {
          lastBurst = k;
          const wx = obj.x + obj.w / 2 + pitX, wz = obj.y + obj.h / 2;
          this.addFx({ type: fire ? 'burn' : 'splash', x: wx, y: wz });
        }
      }
      if (u < 0.75) flyer.traverse((m) => { if (m.isMesh) m.material = M(m.userData.black ? 0x161616 : 0xf5f5f5); });
    };
  }

  /** Mass grave and memorial: a stone plaza, obelisk, and a headstone per fallen officer. */
  buildMemorial(o, g) {
    const plaza = box(1.9, 0.08, 1.9, 0x9a9890); plaza.position.y = 0.04; g.add(plaza);
    const soil = box(1.3, 0.05, 0.75, 0x4a3524); soil.position.set(0, 0.1, 0.35); g.add(soil); // the mass grave
    const plinth = box(0.5, 0.18, 0.5, 0x6d717a); plinth.position.set(0, 0.17, -0.5); g.add(plinth);
    const obelisk = mesh(new THREE.CylinderGeometry(0.06, 0.16, 1.5, 4), M(0xc9ccd2)); obelisk.position.set(0, 1.0, -0.5); obelisk.rotation.y = Math.PI / 4; g.add(obelisk);
    const tip = mesh(new THREE.ConeGeometry(0.085, 0.16, 4), M(0xd8b04a, { metalness: 0.6, roughness: 0.3 })); tip.position.set(0, 1.83, -0.5); tip.rotation.y = Math.PI / 4; g.add(tip);
    const plaque = mesh(new THREE.PlaneGeometry(0.42, 0.14), new THREE.MeshStandardMaterial({ map: textTexture('IN MEMORIAM', { bg: '#3b3f46', color: '#e8d18a', font: 'bold 34px Georgia, serif' }) }));
    plaque.position.set(0, 0.2, -0.24); g.add(plaque);
    const wreath = mesh(new THREE.TorusGeometry(0.12, 0.035, 6, 14), M(0x2f6b3a)); wreath.position.set(0, 0.42, -0.24); g.add(wreath);
    const bow = box(0.06, 0.06, 0.02, 0xc81d25); bow.position.set(0, 0.3, -0.22); g.add(bow);
    // One headstone per fallen officer, in rows on the grave.
    const n = Math.min(o.graves || 0, 24);
    for (let k = 0; k < n; k++) {
      const row = Math.floor(k / 6), col = k % 6;
      const stone = box(0.12, 0.2, 0.04, 0xb8bcc4);
      stone.position.set(-0.55 + col * 0.22, 0.2, 0.1 + row * 0.2);
      g.add(stone);
      const top = mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.04, 10, 1, false, 0, Math.PI), M(0xb8bcc4));
      top.rotation.set(Math.PI / 2, 0, Math.PI / 2);
      top.position.set(-0.55 + col * 0.22, 0.3, 0.1 + row * 0.2);
      g.add(top);
    }
    for (let k = 0; k < 10; k++) {
      const f = sphere(0.03, [0xffffff, 0xe5484d, 0xffd23f][k % 3]);
      f.position.set(-0.85 + hash(o.id + k) * 1.7, 0.1, 0.85 - hash(o.id * 3 + k) * 0.15);
      g.add(f);
    }
    const flame = sphere(0.04, 0xffb347, { emissive: 0xff7a00, emissiveIntensity: 1.5 });
    flame.position.set(0, 0.32, -0.5);
    g.add(flame);
    return (obj, t) => { flame.scale.setScalar(0.8 + Math.abs(Math.sin(t * 9)) * 0.5); };
  }

  makePanda(scale = 1) {
    const g = new THREE.Group();
    const add = (geo, black, x, y, z) => {
      const m = mesh(geo, M(black ? 0x161616 : 0xf5f5f5));
      m.userData.black = black;
      m.position.set(x, y, z);
      g.add(m);
      return m;
    };
    add(new THREE.SphereGeometry(0.12, 10, 8), false, 0, 0.16, 0);
    add(new THREE.SphereGeometry(0.09, 10, 8), false, 0, 0.34, 0);
    add(new THREE.SphereGeometry(0.035, 6, 5), true, -0.07, 0.42, 0);
    add(new THREE.SphereGeometry(0.035, 6, 5), true, 0.07, 0.42, 0);
    add(new THREE.SphereGeometry(0.025, 6, 5), true, -0.035, 0.35, 0.075);
    add(new THREE.SphereGeometry(0.025, 6, 5), true, 0.035, 0.35, 0.075);
    add(new THREE.BoxGeometry(0.05, 0.12, 0.05), true, -0.13, 0.17, 0);
    add(new THREE.BoxGeometry(0.05, 0.12, 0.05), true, 0.13, 0.17, 0);
    g.scale.setScalar(scale);
    return g;
  }

  // ------------------------------------------------------------------
  // Scenery (instanced trees and flowers)
  // ------------------------------------------------------------------

  drawScenery(park) {
    let sig = 0;
    for (const o of park.objects) if (INSTANCED.has(o.kind)) sig = (sig * 31 + o.id) | 0;
    if (sig === this.scenerySig) return;
    this.scenerySig = sig;
    for (const b of [this.trunks, this.canopies, this.cones, this.blooms, this.beds, this.fronds, this.rocks]) b.begin();
    const greens = CLIMATES[this.climate]?.foliage || [0x2f7d32, 0x3a8f3c, 0x358a37, 0x45a047];
    const blooms = [0xff5d8f, 0xffd23f, 0xffffff, 0xb07cff, 0xff8a3d];
    for (const o of park.objects) {
      const x = o.x + 0.5, z = o.y + 0.5, r = hash(o.id), s = 0.85 + r * 0.4;
      if (o.kind === 'tree') {
        this.trunks.add(compose(x, 0.25 * s, z, 0, s, s, s), 0x6b4423);
        for (let k = 0; k < 3; k++) {
          const a = r * 6 + k * 2.1;
          this.canopies.add(compose(x + Math.cos(a) * 0.12 * s, (0.62 + k * 0.1) * s, z + Math.sin(a) * 0.12 * s, a, s * (1 - k * 0.15), s * (1 - k * 0.15), s * (1 - k * 0.15)), greens[(o.id + k) % 4]);
        }
      } else if (o.kind === 'palm') {
        this.trunks.add(compose(x, 0.55 * s, z, 0, s * 0.7, s * 2.2, s * 0.7), 0x8b6b3e);
        for (let k = 0; k < 6; k++) {
          const a = r * 6 + (k / 6) * Math.PI * 2;
          this.fronds.add(compose(x + Math.cos(a) * 0.22 * s, 1.12 * s, z + Math.sin(a) * 0.22 * s, -a, s, s, s, 0, 0.5), k % 2 ? 0x2f8f3a : 0x3aa046);
        }
      } else if (o.kind === 'cactus') {
        this.cones.add(compose(x, 0.32 * s, z, 0, s * 0.35, s * 1.3, s * 0.35), 0x4f8a3a);
        this.cones.add(compose(x + 0.13 * s, 0.38 * s, z, 0, s * 0.18, s * 0.6, s * 0.18), 0x5a9a42);
        this.cones.add(compose(x - 0.12 * s, 0.3 * s, z, 0, s * 0.16, s * 0.5, s * 0.16), 0x5a9a42);
      } else if (o.kind === 'cherry') {
        this.trunks.add(compose(x, 0.25 * s, z, 0, s, s, s), 0x5a3a2a);
        for (let k = 0; k < 4; k++) {
          const a = r * 6 + k * 1.6;
          this.canopies.add(compose(x + Math.cos(a) * 0.14 * s, (0.6 + k * 0.08) * s, z + Math.sin(a) * 0.14 * s, a, s * 0.85, s * 0.8, s * 0.85), k % 2 ? 0xf7b6d2 : 0xffd1e3);
        }
      } else if (o.kind === 'rock') {
        this.rocks.add(compose(x, 0.12 * s, z, r * 6, s * 0.9, s * 0.6, s * 0.8), 0x8a8580);
      } else if (o.kind === 'pine') {
        this.trunks.add(compose(x, 0.15 * s, z, 0, s * 0.8, s * 0.6, s * 0.8), 0x5a3a1e);
        for (let k = 0; k < 3; k++) this.cones.add(compose(x, (0.45 + k * 0.28) * s, z, r * 5, s * (1 - k * 0.22), s * 0.9, s * (1 - k * 0.22)), k % 2 ? 0x2b6b3a : 0x24603a);
      } else {
        this.beds.add(compose(x, 0.03, z));
        for (let k = 0; k < 16; k++) {
          this.blooms.add(compose(o.x + 0.15 + hash(o.id * 31 + k) * 0.7, 0.1 + hash(o.id * 7 + k) * 0.05, o.y + 0.15 + hash(o.id * 17 + k) * 0.7), blooms[k % blooms.length]);
        }
      }
    }
    for (const b of [this.trunks, this.canopies, this.cones, this.blooms, this.beds, this.fronds, this.rocks]) b.end();
  }

  // ------------------------------------------------------------------
  // People
  // ------------------------------------------------------------------

  drawPeople(park, t, view) {
    for (const b of [this.legs, this.bodies, this.heads, this.hats, this.guns, this.pandaWhite, this.pandaBlack, this.lootBags, this.markers, this.bars, this.orbs, this.umbrellas]) b.begin();
    this.ring.visible = false;
    for (const g of park.guests) {
      if (g.state === 'ride') continue;
      const p = actorPos(g);
      let x = p.x, z = p.y;
      if (g.state === 'queue') {
        const a = hash(g.id) * Math.PI * 2;
        x += Math.cos(a) * 0.28; z += Math.sin(a) * 0.28;
      }
      const heading = Math.atan2(g.nx - g.x, g.ny - g.y) || hash(g.id) * 6;
      if (view.selected === g.id) { this.ring.visible = true; this.ring.position.set(x, 0.06, z); }
      if (g.crime === 'panda') { this.drawPanda(g, x, z, heading, t); continue; }
      this.person(x, z, heading, g.state === 'walk' ? t : 0, g.id, g.shirt, { sitting: g.state === 'sit' });
      if (g.umbrella && this.weather?.precip) this.umbrellas.add(compose(x, 0.62, z), [0xe5484d, 0x3a86ff, 0xf2b84b, 0x7bd389][g.id % 4]);
      const top = 0.55;
      if (g.crime && g.spotted) this.markers.add(compose(x, top + 0.06 + Math.sin(t * 5) * 0.02, z, 0, 1, -1, 1), 0xe5484d);
      else if (g.high > 0) {
        for (let k = 0; k < 4; k++) {
          const a = t * 5 + k * Math.PI / 2 + g.id;
          this.orbs.add(compose(x + Math.cos(a) * 0.1, top + Math.sin(t * 3 + k) * 0.02, z + Math.sin(a) * 0.1), [0xff5dd8, 0x5dffb0, 0xffe45d, 0x5db8ff][k]);
        }
      } else if (g.injured) {
        this.bars.add(compose(x, top, z, this.yaw, 0.12, 2.5, 1), 0xffffff);
        this.bars.add(compose(x, top + 0.001, z, this.yaw, 0.04, 2.6, 1.2), 0xe5484d);
      }
    }
    for (const s of park.staff) {
      const p = actorPos(s);
      const heading = Math.atan2(s.nx - s.x, s.ny - s.y) || 0;
      const col = park.uniforms?.[s.role] || STAFF[s.role].color;
      if (view.selected === s.id) { this.ring.visible = true; this.ring.position.set(p.x, 0.06, p.y); }
      const down = s.down > 0;
      this.person(p.x, p.y, heading, s.busy > 0 || down ? 0 : t, s.id, col, { hat: s.role === 'squad' ? 0xffd23f : new THREE.Color(col).multiplyScalar(0.6).getHex(), lying: down });
      if (s.role === 'squad' && !down) {
        this.guns.add(compose(p.x + Math.cos(heading) * 0.1, 0.32, p.y - Math.sin(heading) * 0.1, heading));
      }
      if (down) for (let k = 0; k < 3; k++) {
        const a = t * 4 + (k * Math.PI * 2) / 3;
        this.orbs.add(compose(p.x + Math.cos(a) * 0.15, 0.25, p.y + Math.sin(a) * 0.15), 0xffd23f);
      } else if (s.hp < s.maxHp && (s.role === 'squad' || s.role === 'guard')) {
        this.healthBar(p.x, 0.62, p.y, s.hp / s.maxHp, 0x4dabf7);
      }
    }
    for (const b of [this.legs, this.bodies, this.heads, this.hats, this.guns, this.pandaWhite, this.pandaBlack, this.lootBags, this.markers, this.bars, this.orbs, this.umbrellas]) b.end();
  }

  healthBar(x, y, z, frac, color) {
    this.bars.add(compose(x, y, z, this.yaw, 0.3, 2, 2), 0x222222);
    this.bars.add(compose(x - 0.15 * (1 - frac) * Math.cos(this.yaw), y + 0.002, z + 0.15 * (1 - frac) * Math.sin(this.yaw), this.yaw, 0.3 * frac, 2.2, 2.2), color);
  }

  person(x, z, heading, t, id, shirt, { sitting = false, hat = null, lying = false } = {}) {
    const bob = Math.abs(Math.sin(t * 9 + id)) * 0.02;
    const swing = Math.sin(t * 9 + id) * 0.5;
    if (lying) {
      this.bodies.add(compose(x, 0.06, z, heading, 1, 1, 1, Math.PI / 2), shirt);
      this.heads.add(compose(x - Math.sin(heading) * 0.0 + Math.sin(heading) * 0.15, 0.06, z + Math.cos(heading) * 0.15), SKIN[id % SKIN.length]);
      return;
    }
    const legY = sitting ? 0.14 : 0.08 + bob;
    for (const side of [-1, 1]) {
      const lx = x + Math.cos(heading) * 0.035 * side, lz = z - Math.sin(heading) * 0.035 * side;
      this.legs.add(compose(lx, legY, lz, heading, 1, 1, 1, sitting ? Math.PI / 2 : swing * side));
    }
    const by = (sitting ? 0.22 : 0.245) + bob;
    this.bodies.add(compose(x, by, z, heading), shirt);
    this.heads.add(compose(x, by + 0.15, z), SKIN[id % SKIN.length]);
    if (hat !== null) this.hats.add(compose(x, by + 0.215, z), hat);
  }

  drawPanda(g, x, z, heading, t) {
    const W = this.pandaWhite, B = this.pandaBlack;
    if (g.state === 'downed') {
      W.add(compose(x, 0.09, z, heading, 0.13, 0.09, 0.2));
      W.add(compose(x + Math.sin(heading) * 0.22, 0.08, z + Math.cos(heading) * 0.22, 0, 0.09, 0.08, 0.09));
      for (let k = 0; k < 6; k++) this.orbs.add(compose(x - 0.15 + hash(g.id + k) * 0.3, 0.13, z - 0.1 + hash(g.id * 3 + k) * 0.2), k % 2 ? 0xffd23f : 0xc81d25);
      for (let k = 0; k < 3; k++) {
        const a = t * 4 + (k * Math.PI * 2) / 3;
        this.orbs.add(compose(x + Math.cos(a) * 0.15, 0.3, z + Math.sin(a) * 0.15), 0xffd23f);
      }
      return;
    }
    const bob = g.state === 'walk' ? Math.abs(Math.sin(t * 11 + g.id)) * 0.03 : 0;
    const cs = Math.cos(heading), sn = Math.sin(heading);
    const off = (side, fwd) => [x + cs * side + sn * fwd, z - sn * side + cs * fwd];
    W.add(compose(x, 0.2 + bob, z, heading, 0.13, 0.15, 0.12));
    W.add(compose(x, 0.42 + bob, z, heading, 0.1, 0.095, 0.1));
    for (const side of [-1, 1]) {
      let [ex, ez] = off(side * 0.075, 0);
      B.add(compose(ex, 0.51 + bob, ez, 0, 0.038, 0.038, 0.038));
      [ex, ez] = off(side * 0.04, 0.08);
      B.add(compose(ex, 0.43 + bob, ez, 0, 0.028, 0.034, 0.02));
      [ex, ez] = off(side * 0.14, 0);
      B.add(compose(ex, 0.22 + bob, ez, 0, 0.04, 0.09, 0.04));
      [ex, ez] = off(side * 0.06, 0);
      B.add(compose(ex, 0.06, ez, 0, 0.045, 0.07, 0.05));
    }
    if (g.loot > 0) {
      const [lx, lz] = off(0, -0.15);
      this.lootBags.add(compose(lx, 0.25 + bob, lz));
    }
    this.healthBar(x, 0.68, z, g.hp / g.maxHp, 0xe5484d);
  }

  // ------------------------------------------------------------------
  // Overlays & builder preview
  // ------------------------------------------------------------------

  drawOverlay(park, view) {
    const o = this.overlay;
    o.begin();
    const tile = (x, y, color) => o.add(compose(x + 0.5, 0.07, y + 0.5, 0, 0.98, 1, 0.98), color);
    if (view.selected) {
      const sel = park._byId.get(view.selected);
      if (sel) for (const [x, y] of cellsOf(sel)) tile(x, y, 0xffe24d);
    }
    const h = view.hover;
    if (h) {
      if (view.ghost) {
        const { x, y, w, hgt, ok } = view.ghost;
        for (let yy = y; yy < y + hgt; yy++) for (let xx = x; xx < x + w; xx++) tile(xx, yy, ok ? 0x50dc78 : 0xf04646);
      } else if (view.tool === 'bulldoze') {
        const obj = park._byId.get(park._objAt[idx(h.x, h.y)]);
        if (obj) for (const [x, y] of cellsOf(obj)) tile(x, y, 0xf04646);
        else tile(h.x, h.y, 0xf04646);
      } else if (view.tool === 'coaster-start') {
        tile(h.x, h.y, view.coasterStartOk ? 0x50dc78 : 0xf04646);
      } else {
        tile(h.x, h.y, 0xffffff);
      }
    }
    o.end();
  }

  drawCoasterPreview(park, view) {
    const b = view.builder;
    const arrow = this.cursorArrow;
    const pointAlong = (dir) => { const [dx, dz] = Coaster.DIRS[dir]; arrow.rotation.y = Math.atan2(-dx, -dz); };
    const obj = b ? park._byId.get(b.id) : null;
    const key = obj?.building && b.hoverPiece ? `${obj.id}|${obj._version}|${b.hoverPiece}|${b.hoverOk}` : '';
    if (key !== this.previewKey) {
      this.previewKey = key;
      for (const m of this.preview.children) m.geometry.dispose();
      this.preview.clear();
    }
    if (view.tool === 'coaster-start' && view.hover) {
      arrow.visible = true;
      arrow.position.set(view.hover.x + 0.5, 0.15, view.hover.y + 0.5);
      pointAlong(view.coasterDir || 0);
      return;
    }
    if (!obj?.building) { arrow.visible = false; return; }
    const c = obj._layout.cursor;
    const [dx, dz] = Coaster.DIRS[c.dir];
    arrow.visible = true;
    arrow.position.set(c.x + 0.5 - dx * 0.3, c.h * Coaster.STEP + 0.3, c.y + 0.5 - dz * 0.3);
    pointAlong(c.dir);
    // Ghost of the hovered piece (rebuilt only when it changes).
    if (key && !this.preview.children.length) {
      const start = { x: obj.x, y: obj.y, dir: obj.track.dir };
      const all = Coaster.samples(start, [...obj.track.pieces, b.hoverPiece]);
      const lay = Coaster.layout(start, [...obj.track.pieces, b.hoverPiece]);
      const segIndex = lay.segs.length - 1;
      const pts = all.filter((p) => p.seg === segIndex).map((p) => new THREE.Vector3(p.x, p.y + 0.12, p.z));
      if (pts.length > 1) {
        const curve = new THREE.CatmullRomCurve3(pts);
        const ghost = new THREE.Mesh(new THREE.TubeGeometry(curve, pts.length * 2, 0.07, 6), new THREE.MeshBasicMaterial({ color: b.hoverOk ? 0x50dc78 : 0xf04646, transparent: true, opacity: 0.6 }));
        this.preview.add(ghost);
      }
    }
  }

  // ------------------------------------------------------------------
  // Effects
  // ------------------------------------------------------------------

  addFx(f) {
    if (f.type === 'shot' || f.type === 'bamboo') { this.shots.push({ ...f, age: 0 }); return; }
    if (f.type === 'lightning') { this.flash = 0.35; return; }
    const rnd = Math.random;
    const burst = (n, make) => { for (let i = 0; i < n && this.particles.length < 2000; i++) this.particles.push(make()); };
    if (f.type === 'blood') {
      burst(14 * (f.amount || 1), () => ({ x: f.x, y: 0.3, z: f.y, vx: (rnd() - 0.5) * 1.6, vy: 0.6 + rnd() * 1.6, vz: (rnd() - 0.5) * 1.6, g: 6, life: 0, max: 0.7 + rnd() * 0.5, c: rnd() < 0.5 ? [0.6, 0.04, 0.06] : [0.82, 0.1, 0.12] }));
    } else if (f.type === 'burn') {
      burst(60, () => ({ x: f.x + (rnd() - 0.5) * 0.8, y: 0.4, z: f.y + (rnd() - 0.5) * 0.8, vx: (rnd() - 0.5) * 0.3, vy: 1 + rnd() * 2.5, vz: (rnd() - 0.5) * 0.3, g: -0.5, life: 0, max: 0.6 + rnd() * 1, c: [[1, 0.87, 0.33], [1, 0.54, 0.12], [1, 0.24, 0.12], [0.3, 0.3, 0.3]][Math.floor(rnd() * 4)] }));
    } else if (f.type === 'splash') {
      burst(50, () => ({ x: f.x, y: 1.1, z: f.y, vx: (rnd() - 0.5) * 2, vy: 1 + rnd() * 2.2, vz: (rnd() - 0.5) * 2, g: 7, life: 0, max: 0.8 + rnd() * 0.4, c: rnd() < 0.7 ? [0.62, 0.84, 1] : [0.9, 0.96, 1] }));
    } else if (f.type === 'condiment') {
      burst(10, () => ({ x: f.x, y: 0.35, z: f.y, vx: (rnd() - 0.5) * 1.2, vy: 0.5 + rnd(), vz: (rnd() - 0.5) * 1.2, g: 6, life: 0, max: 0.5, c: rnd() < 0.5 ? [1, 0.82, 0.25] : [0.78, 0.11, 0.15] }));
    }
  }

  drawShots(dt) {
    const FLIGHT = 0.3;
    for (const b of [this.hotdogs, this.buns, this.bamboo]) b.begin();
    this.shots = this.shots.filter((s) => {
      s.age += dt;
      if (s.age < FLIGHT) return true;
      if (s.hit) this.addFx({ type: s.type === 'shot' ? 'condiment' : 'blood', x: s.x1, y: s.y1, amount: 0.4 });
      return false;
    });
    for (const s of this.shots) {
      const v = s.age / FLIGHT, end = s.hit ? 1 : 1.3;
      const x = s.x0 + (s.x1 - s.x0) * v * end, z = s.y0 + (s.y1 - s.y0) * v * end;
      const y = 0.35 + Math.sin(v * Math.PI) * 0.35;
      const heading = Math.atan2(s.x1 - s.x0, s.y1 - s.y0);
      if (s.type === 'shot') {
        this.buns.add(compose(x, y, z, heading, 1, 1, 1, Math.PI / 2));
        this.hotdogs.add(compose(x, y + 0.02, z, heading, 1, 1, 1, Math.PI / 2));
      } else {
        this.bamboo.add(compose(x, y, z, heading, 1, 1, 1, v * 20));
      }
    }
    for (const b of [this.hotdogs, this.buns, this.bamboo]) b.end();
  }

  drawParticles(dt) {
    this.particles = this.particles.filter((q) => (q.life += dt) < q.max && q.y > -0.05);
    let i = 0;
    for (const q of this.particles) {
      q.vy -= q.g * dt;
      q.x += q.vx * dt; q.y += q.vy * dt; q.z += q.vz * dt;
      if (q.y < 0.05 && q.g > 0) { q.y = 0.05; q.vx *= 0.3; q.vz *= 0.3; q.vy = 0; }
      const fade = 1 - q.life / q.max;
      this.pPos[i * 3] = q.x; this.pPos[i * 3 + 1] = q.y; this.pPos[i * 3 + 2] = q.z;
      this.pCol[i * 3] = q.c[0] * fade + 0.0; this.pCol[i * 3 + 1] = q.c[1] * fade; this.pCol[i * 3 + 2] = q.c[2] * fade;
      i++;
    }
    const geo = this.points.geometry;
    geo.setDrawRange(0, i);
    geo.attributes.position.needsUpdate = true;
    geo.attributes.color.needsUpdate = true;
  }

  drawFloaters(dt) {
    this.floaters = this.floaters.filter((f) => {
      f.age += dt;
      if (f.age > 1.6) { f.el.remove(); return false; }
      const p = this.tileToScreen(f.fx, f.fy, 0.8 + f.age * 0.6);
      f.el.style.transform = `translate(${p.x}px, ${p.y}px) translate(-50%, -50%)`;
      f.el.style.opacity = String(1 - f.age / 1.6);
      return true;
    });
  }
}

/** True if this browser can run the WebGL renderer. */
export function webglAvailable() {
  try {
    const c = document.createElement('canvas');
    return !!(c.getContext('webgl2') || c.getContext('webgl'));
  } catch {
    return false;
  }
}

export { rideDef };
