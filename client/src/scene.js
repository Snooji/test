import * as THREE from 'three';
import { ITEM_TYPES, GRID, footprint, shapeCells, SUITS } from '../../shared/logic.js';
import { TRUCK, CELL, gridToWorld } from '../../shared/world.js';
import { levelFromSnapshot, STOREY_H, FLOOR_DZ } from '../../shared/level.js';
import { makeMover, makeItem, makeCat, sprite, labelTexture, mat } from './models.js';
import * as VX from './voxel.js';

const damp = (a, b, k, dt) => a + (b - a) * (1 - Math.exp(-k * dt));
/** cells [x,y,z] a loaded item occupies relative to its grid anchor */
const cellsOf = (it) => {
  if (it.g.cells) return it.g.cells;
  const out = [];
  for (let x = 0; x < it.g.w; x++) for (let y = 0; y < (it.g.h || 1); y++) for (let z = 0; z < it.g.d; z++) out.push([x, y, z]);
  return out;
};

// Walls are tall enough to hide what's behind them. Movers stay findable: wherever a wall (not the mover itself) is in front
// of one, a soft warm silhouette shows through. Stencil 1 = "a mover drew this pixel", so a mover never ghosts over itself.
const XRAY = new THREE.MeshBasicMaterial({ color: 0xffc27a, transparent: true, opacity: 0.45, depthWrite: false, depthFunc: THREE.GreaterDepth,
  stencilWrite: true, stencilRef: 1, stencilFunc: THREE.NotEqualStencilFunc, stencilZPass: THREE.KeepStencilOp, stencilFail: THREE.KeepStencilOp, stencilZFail: THREE.KeepStencilOp });
function addXray(body) {
  if (!body) return;
  body.traverse(o => {
    if (!o.isMesh || o.isSprite || o.userData.xr || o.userData.isXray) return;
    for (const m of [].concat(o.material)) { m.stencilWrite = true; m.stencilRef = 1; m.stencilFunc = THREE.AlwaysStencilFunc; m.stencilZPass = THREE.ReplaceStencilOp; }
    const c = new THREE.Mesh(o.geometry, XRAY);
    c.userData.isXray = true; c.renderOrder = 20; c.castShadow = c.receiveShadow = false;
    o.userData.xr = c; o.add(c);
  });
}

export class GameScene {
  constructor(container) {
    const mobile = matchMedia('(pointer: coarse)').matches;
    this.renderer = new THREE.WebGLRenderer({ antialias: !mobile, powerPreference: 'high-performance', stencil: true }); // stencil: movers show through walls
    this.maxPR = Math.min(devicePixelRatio, mobile ? 1.5 : 2); this.minPR = mobile ? 0.75 : 1;
    this.renderer.setPixelRatio(this.maxPR);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x1a1410); // warm night
    this.scene.fog = new THREE.Fog(0x1a1410, 45, 90);
    this.camera = new THREE.PerspectiveCamera(42, 1, 0.1, 200);
    this.camTarget = new THREE.Vector3(11, 0, 0);
    this.camera.position.set(11, 22, 13);
    this.shakeT = 0;

    this.scene.add(new THREE.HemisphereLight(0xffe6c8, 0x3a2e24, 1.4));
    const sun = new THREE.DirectionalLight(0xfff1dd, 2.2);
    sun.position.set(12, 30, 14);
    sun.castShadow = true;
    sun.shadow.mapSize.set(mobile ? 1024 : 2048, mobile ? 1024 : 2048);
    // the shadow map only covers the area round the camera (it follows the player): sharper shadows for the same cost
    Object.assign(sun.shadow.camera, { left: -22, right: 22, top: 18, bottom: -18, near: 1, far: 80 });
    this.sun = sun; this.scene.add(sun); this.scene.add(sun.target);

    this.buildWorld();
    this.players = new Map(); // id → {root, label, char, carried}
    this.items = new Map();   // id → {obj, key, bar}
    this.cat = makeCat(); this.scene.add(this.cat);
    // ghost = one translucent cube per cell, so shaped pieces (the r-lamp) preview exactly
    this.ghost = new THREE.Group();
    this.ghost.visible = false;
    this.ghostMat = new THREE.MeshBasicMaterial({ color: 0x55ffcc, transparent: true, opacity: 0.4, depthWrite: false });
    this.ghostLine = new THREE.LineBasicMaterial({ color: 0xffffff });
    this.cellGeo = new THREE.BoxGeometry(CELL * 0.98, CELL * 0.98, CELL * 0.98);
    this.cellEdges = new THREE.EdgesGeometry(this.cellGeo);
    this.ghostKey = '';
    this.scene.add(this.ghost);
    this.emotes = [];
    this.pings = [];
    this.parts = [];
    this.puffs = [];
    { // soft round dust texture
      const c = document.createElement('canvas'); c.width = c.height = 64;
      const g = c.getContext('2d'), gr = g.createRadialGradient(32, 32, 2, 32, 32, 30);
      gr.addColorStop(0, 'rgba(255,255,255,.95)'); gr.addColorStop(.5, 'rgba(255,255,255,.45)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
      this.dustTex = new THREE.CanvasTexture(c);
    }
    this.partGeo = new THREE.BoxGeometry(0.14, 0.14, 0.14);
    // guide arrow at your feet: to the truck when carrying, else to the nearest item
    const arrowShape = new THREE.Shape();
    arrowShape.moveTo(0, 0.9); arrowShape.lineTo(0.45, 0.25); arrowShape.lineTo(0.16, 0.25); arrowShape.lineTo(0.16, -0.4);
    arrowShape.lineTo(-0.16, -0.4); arrowShape.lineTo(-0.16, 0.25); arrowShape.lineTo(-0.45, 0.25); arrowShape.closePath();
    this.arrow = new THREE.Mesh(new THREE.ShapeGeometry(arrowShape), new THREE.MeshBasicMaterial({ color: 0x55ffcc, transparent: true, opacity: 0.85, depthWrite: false }));
    this.arrow.rotation.x = -Math.PI / 2; this.arrow.visible = false; this.arrow.renderOrder = 5;
    this.arrowPivot = new THREE.Group(); this.arrowPivot.add(this.arrow); this.arrow.position.set(0, 0.06, 0);
    this.scene.add(this.arrowPivot);
    // stack-height numbers over each truck column (load mode)
    this.colLabels = [];
    for (let gx = 0; gx < GRID.W; gx++) for (let gz = 0; gz < GRID.D; gz++) {
      const sp = sprite('0', { fg: '#55ffcc', stroke: '#171310', font: 'bold 60px system-ui', w: 96, h: 96 }, [0.55, 0.55]);
      sp.visible = false; sp.userData = { gx, gz, v: '0' };
      this.scene.add(sp); this.colLabels.push(sp);
    }
    this.raycaster = new THREE.Raycaster();
    // training objective: a bouncing arrow + pulsing ring over whatever the Coach wants next
    this.objective = new THREE.Group();
    const cone = new THREE.Mesh(new THREE.ConeGeometry(0.42, 0.8, 4), new THREE.MeshBasicMaterial({ color: 0x55ffcc }));
    cone.rotation.x = Math.PI; cone.position.y = 2.9; this.objective.add(cone);
    this.objRing = new THREE.Mesh(new THREE.RingGeometry(0.9, 1.15, 40), new THREE.MeshBasicMaterial({ color: 0x55ffcc, transparent: true, side: THREE.DoubleSide, depthWrite: false }));
    this.objRing.rotation.x = -Math.PI / 2; this.objRing.position.y = 0.07; this.objective.add(this.objRing);
    this.objCone = cone; this.objective.visible = false;
    this.scene.add(this.objective);

    addEventListener('resize', () => this.resize());
    this.resize();
  }

  /** graphics quality: 'auto' adapts resolution to the frame rate; 'high' = full resolution; 'low' = lowest resolution, no shadows */
  setQuality(q) {
    this.quality = q;
    this.renderer.shadowMap.enabled = q !== 'low'; this.sun.castShadow = q !== 'low';
    this.scene.traverse(o => { if (o.material) o.material.needsUpdate = true; }); // shader variants with/without shadows
    this.setPR(q === 'low' ? this.minPR : this.maxPR);
  }
  setPR(pr) { pr = Math.max(this.minPR, Math.min(this.maxPR, pr)); if (Math.abs(pr - this.renderer.getPixelRatio()) < 0.01) return; this.renderer.setPixelRatio(pr); this.resize(); }
  /** auto quality: called every frame during play; steps resolution down when frames are slow, back up when there's headroom */
  adapt(dt) {
    if (this.quality !== 'auto' && this.quality !== undefined) return;
    const a = this.adaptState ||= { t: 0, n: 0, sum: 0, good: 0 };
    a.t += dt; a.n++; a.sum += dt;
    if (a.t < 2) return;
    const fps = a.n / a.sum, pr = this.renderer.getPixelRatio();
    if (fps < 45 && pr > this.minPR) { this.setPR(pr - 0.25); a.good = 0; }
    else if (fps > 57) { if (++a.good >= 3 && pr < this.maxPR) { this.setPR(pr + 0.25); a.good = 0; } }
    else a.good = 0;
    a.t = 0; a.n = 0; a.sum = 0;
  }

  resize() {
    const w = innerWidth, h = innerHeight;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.fov = w < h ? 58 : 42; // portrait phones see more
    this.camera.updateProjectionMatrix();
  }

  buildWorld() { return VX.buildWorld(this); }

  /** (Re)build the house for a level. Every round can be a different, generated house. */
  buildHouse(level) {
    if (this.house) { this.scene.remove(this.house); this.house.traverse(o => { o.geometry?.dispose(); if (o.material?.map && o.material.transparent) o.material.map.dispose(); }); }
    return VX.buildHouse(this, level);
  }

  buildTruck() { return VX.buildTruck(this); }

  /** The truck rolls its shutter down and drives off; damaged pieces burst on the way. */
  startDriveOff(damagedIds) {
    this.drive = { t: 0, damaged: new Set(damagedIds), burst: false };
    for (const v of this.items.values()) v.obj.userData.baseX = v.obj.position.x;
    this.shutter.visible = true;
  }
  resetDrive() {
    if (!this.drive && this.truckGroup.position.x === 0) return;
    this.drive = null;
    this.truckGroup.position.x = 0;
    this.shutter.visible = false; this.shutter.scale.y = 0.001;
    if (this.ramp && this.rampHome) { this.ramp.position.set(this.rampHome.x, this.rampHome.y, 0); this.ramp.rotation.z = this.rampHome.rot; this.ramp.visible = true; }
  }

  // ---------- sync ----------
  /** server position → drawn position (adds fl and y; z moves back over the ground floor). Safe to call twice. */
  project(o) {
    const L = this.level;
    if (!o || o.x === undefined || o.fl !== undefined || !L) return o;
    o.fl = L.floorOf(o.z); o.y = L.renderY(o.x, o.z); o.z -= FLOOR_DZ * o.fl;
    return o;
  }

  apply(snap, myId) {
    this.snap = snap;
    this.myId = myId;
    const lv = snap.level;
    const lvKey = lv && JSON.stringify([lv.seed, lv.classic, lv.exact, lv.mansion, lv.tutorial, lv.floors || 1]);
    if (lv && this.levelKey !== lvKey) {
      this.levelKey = lvKey;
      this.buildHouse(levelFromSnapshot(lv));
      for (const v of this.items.values()) this.scene.remove(v.obj);
      this.items.clear();
    }
    // multi-floor houses: the server keeps each floor in its own strip of the map; draw everything stacked over the
    // ground floor instead (fl = floor, y = height, z back over the footprint). Done once per snapshot, in place.
    if ((this.level?.floors || 1) > 1) {
      for (const p of snap.players) this.project(p);
      for (const it of snap.items) if (it.state !== 'loaded') this.project(it);
      this.project(snap.cat);
    }
    // players
    const seen = new Set();
    for (const p of snap.players) {
      seen.add(p.id);
      let v = this.players.get(p.id);
      if (!v || v.char !== p.char || v.suit !== p.suit) {
        if (v) this.scene.remove(v.root);
        const root = makeMover(p.char, SUITS.find(x => x.id === p.suit)?.color ?? null);
        const label = sprite(p.name, { fg: '#fff', stroke: '#000', font: 'bold 40px system-ui' });
        label.position.y = 2.25; root.add(label);
        const ready = sprite('✅ READY', { fg: '#55ffcc', stroke: '#171310', font: 'bold 40px system-ui' }, [2, 0.5]);
        ready.position.y = 2.85; ready.visible = false; root.add(ready);
        root.position.set(p.x, 0, p.z);
        this.scene.add(root);
        v = { root, char: p.char, suit: p.suit, label, ready, face: p.face };
        this.players.set(p.id, v);
      }
      v.ready.visible = !!p.ready && (snap.phase === 'results' || snap.phase === 'lobby');
      v.data = p;
      // energy meter over the head: shows while it's below full, or while injured
      const en = p.energy ?? 1, hurt = p.injured > 0;
      const showE = (en < 0.99 || hurt) && snap.phase === 'playing' && !p.out;
      if (showE) {
        const bucket = hurt ? 'i' + Math.ceil(p.injured) : 'e' + Math.round(en * 20);
        if (!v.energy) { v.energy = sprite('', {}, [1.7, 0.31]); v.energy.position.y = 3.35; v.energy.renderOrder = 12; v.root.add(v.energy); }
        if (v.energyKey !== bucket) { v.energyKey = bucket; v.energy.material.map?.dispose(); v.energy.material.map = energyTexture(en, p.injured); v.energy.material.needsUpdate = true; }
      }
      if (v.energy) v.energy.visible = showE;
      v.root.traverse(o => { if (o.userData.isXray) { o.visible = !p.out; return; } if (o.userData.blob) return; /* the blob shadow stays soft */ if (o.material && o !== v.label) { o.material.transparent = p.out; o.material.opacity = p.out ? 0.35 : 1; } });
    }
    for (const [id, v] of this.players) if (!seen.has(id)) { this.scene.remove(v.root); this.players.delete(id); }

    // items
    const seenI = new Set();
    for (const it of snap.items) {
      seenI.add(it.id);
      const prevData = this.items.get(it.id)?.data; // before any rebuild below (for the before/after swap)
      const key = `${it.state === 'loaded'}|${it.wrapped}|${it.assembled}`;
      let v = this.items.get(it.id);
      if (!v || v.key !== key) {
        // before → after under a dust cloud: keep the old look until the cloud is thick, then swap
        const transform = v && prevData?.state === 'floor' && it.state === 'floor' && (prevData.assembled !== it.assembled || prevData.wrapped !== it.wrapped);
        if (v && !transform) this.scene.remove(v.obj);
        if (v?.oldObj) this.scene.remove(v.oldObj);
        const obj = makeItem(it.type, { wrapped: it.wrapped, assembled: it.assembled, loaded: it.state === 'loaded', dims: it.g });
        obj.position.set(it.x, 0, it.z);
        this.scene.add(obj);
        const bar = sprite('', {}, [1.4, 0.22]); bar.visible = false; bar.position.y = 1.9; obj.add(bar);
        const oldObj = transform ? v.obj : null;
        if (oldObj) { obj.visible = false; oldObj.children.forEach(c => { if (c.isSprite) c.visible = false; }); }
        v = { obj, key, bar, barP: -1, oldObj, swapT: oldObj ? 0.45 : 0 };
        this.items.set(it.id, v);
        if (it.state === 'loaded' && it.g) {
          const wp = gridToWorld(it.g.x, it.g.z, it.g.y, it.g.w, it.g.d);
          obj.position.set(wp.x, wp.y + 3, wp.z); // drops in from above
          obj.userData.dropTo = wp.y;
        }
      }
      if (prevData && prevData.state === 'floor') {
        if (prevData.assembled && !it.assembled) this.finishFx(it.x, it.z, it.type, 'disassemble');
        else if (!prevData.wrapped && it.wrapped) this.finishFx(it.x, it.z, it.type, 'wrap');
      }
      v.data = it;
      if (it.value !== undefined && it.state !== 'loaded') { // pulled out and left outside: losing value
        const pctV = Math.round(it.value * 100);
        if (v.valP !== pctV) {
          v.valP = pctV;
          if (!v.val) { v.val = sprite('', {}, [1.3, 0.42]); v.val.position.y = 2.2; v.obj.add(v.val); }
          v.val.material.map?.dispose();
          v.val.material.map = labelTexture(`${pctV <= 30 ? '🍂' : '⏳'} ${pctV}%`, { bg: pctV <= 30 ? '#7a3b12' : '#3a2a1a', fg: '#ffd166', font: 'bold 40px system-ui', w: 220, h: 72 });
          v.val.material.needsUpdate = true;
        }
        v.val.visible = true;
      } else if (v.val) v.val.visible = false;
      if (it.task) {
        const pct = Math.round(it.task.p * 10);
        if (pct !== v.barP) {
          v.barP = pct;
          v.bar.material.map?.dispose();
          v.bar.material.map = progressTexture(it.task.p, it.task.kind);
          v.bar.material.needsUpdate = true;
        }
        v.bar.visible = true;
      } else v.bar.visible = false;
    }
    for (const [id, v] of this.items) if (!seenI.has(id)) { this.scene.remove(v.obj); this.items.delete(id); }
  }

  setGhostCells(cells) {
    const key = JSON.stringify(cells);
    if (key === this.ghostKey) return;
    this.ghostKey = key;
    this.ghost.clear();
    for (const [cx, cy, cz] of cells) {
      const m = new THREE.Mesh(this.cellGeo, this.ghostMat);
      m.position.set(-cz * CELL, cy * CELL + CELL / 2, cx * CELL);
      this.ghost.add(m);
    }
  }

  /** occupancy from the snapshot: occ[x][z][y] = item id */
  occupancy() {
    const occ = Array.from({ length: GRID.W }, () => Array.from({ length: GRID.D }, () => new Array(GRID.H).fill(null)));
    for (const it of this.snap?.items || []) {
      if (!it.g) continue;
      for (const [cx, cy, cz] of cellsOf(it)) if (occ[it.g.x + cx]?.[it.g.z + cz]) occ[it.g.x + cx][it.g.z + cz][it.g.y + cy] = it.id;
    }
    return occ;
  }

  heights() {
    const h = Array.from({ length: GRID.W }, () => new Array(GRID.D).fill(0));
    for (const it of this.snap?.items || []) {
      if (!it.g) continue;
      for (const [cx, cy, cz] of cellsOf(it)) { const x = it.g.x + cx, z = it.g.z + cz; if (h[x]) h[x][z] = Math.max(h[x][z], it.g.y + cy + 1); }
    }
    return h;
  }

  /** a persistent sign over one mover (e.g. TRAINING COMPLETE) */
  setBanner(id, text) {
    const v = this.players.get(id);
    if (!v) return;
    if (v.banner) { v.root.remove(v.banner); v.banner = null; }
    if (!text) return;
    v.banner = sprite(text, { fg: '#171310', bg: '#55ffcc', font: 'bold 36px system-ui', w: 420, h: 72 }, [3.6, 0.62]);
    v.banner.position.y = 3.2; v.root.add(v.banner);
  }

  emote(id, text) {
    const v = this.players.get(id);
    if (!v) return;
    const s = sprite(text, { font: 'bold 52px system-ui', fg: '#fff', stroke: '#2a1a5e', w: 192, h: 80 }, [1.4, 0.58]);
    s.position.set(v.root.position.x, 2.7, v.root.position.z);
    this.scene.add(s);
    this.emotes.push({ s, t: 0 });
  }

  shake() { if (!this.noShake) this.shakeT = 0.4; }

  /** little physics particles: shards, dust, confetti */
  burst(x, y, z, colors, n = 18, speed = 4, life = 1.2, size = 1) {
    for (let i = 0; i < n; i++) {
      const m = new THREE.Mesh(this.partGeo, new THREE.MeshBasicMaterial({ color: colors[i % colors.length], transparent: true }));
      m.position.set(x, y, z); m.scale.setScalar(size * (0.6 + Math.random() * 0.8));
      const a = Math.random() * Math.PI * 2, up = 0.5 + Math.random();
      m.userData = { v: new THREE.Vector3(Math.cos(a) * speed * Math.random(), up * speed, Math.sin(a) * speed * Math.random()), life, t: 0, spin: (Math.random() - 0.5) * 12 };
      this.scene.add(m); this.parts.push(m);
    }
  }
  /** how big a dust cloud a piece kicks up: lamps/boxes small, beds/tables/desks/couches big */
  dustScale(type) {
    const t = ITEM_TYPES[type];
    if (!t) return 0.6;
    const size = (t.cells ? t.cells.length : t.w * t.d * (t.h || 1));
    return size >= 6 ? 1.9 : size >= 3 ? 1.5 : size >= 2 ? 1.25 : 0.65;
  }
  /** one soft billowing puff */
  puff(x, y, z, scale, color, life = 1.1, rise = 0.6) {
    const m = VX.puffMesh(color);
    m.position.set(x + (Math.random() - 0.5) * scale * 1.4, y + Math.random() * 0.3 * scale, z + (Math.random() - 0.5) * scale * 1.4);
    const s0 = (0.4 + Math.random() * 0.4) * scale;
    m.scale.setScalar(s0);
    m.userData = { t: 0, life: life * (0.8 + Math.random() * 0.4), s0, grow: 1.6 + Math.random(), vy: rise * (0.6 + Math.random() * 0.6), vx: (Math.random() - 0.5) * 0.6 * scale, vz: (Math.random() - 0.5) * 0.6 * scale };
    this.scene.add(m); this.puffs.push(m);
  }
  dustCloud(x, z, type, kind, n = 1) {
    const sc = this.dustScale(type);
    const colors = kind === 'wrap' ? [0xb9c1d9, 0x9aa6c8, 0xd5d9e6] : [0xb39f80, 0x8f826e, 0xcdc4b4];
    for (let i = 0; i < n; i++) this.puff(x, 0.15 + Math.random() * 0.4 * sc, z, sc, colors[i % colors.length], kind === 'wrap' ? 0.9 : 1.3, kind === 'wrap' ? 0.9 : 0.5);
  }
  finishFx(x, z, type, kind) { // the job's done: one big burst
    this.dustCloud(x, z, type, kind, Math.round(8 + 10 * this.dustScale(type)));
    if (kind === 'disassemble') this.burst(x, 0.8, z, [0x9aa3b8, 0x6b7080], 6, 3, 0.9, 0.5); // a few bolts
  }

  crunchFx() { this.burst(15.4, 2.2, 0, [0xf2d16b, 0xffffff, 0xe63946], 26, 5, 1.1); }
  dropFx(x, y, z) { this.burst(x, y, z, [0xbfb8d6, 0x8f88aa], 10, 1.6, 0.6, 0.7); }
  confetti(x, z) { this.burst(x, 4, z, [0xff8a3d, 0x55ffcc, 0xffd166, 0xa66cff, 0x7bd84a], 80, 6, 2.6, 0.8); }

  /** Where the training objective is right now: an item, or the truck ramp. */
  objectivePos() {
    const id = this.tutorialTarget;
    if (!id || !this.snap) return null;
    if (id === 'ramp') return { x: 11.2, z: 0 };
    const it = this.snap.items.find(i => i.id === id);
    return it && it.state !== 'loaded' ? { x: it.x, z: it.z } : null;
  }

  /** 🆘 beacon: a pulsing ring + light pillar where someone needs a hand. */
  ping(x, z, y = 0, fl = 0) {
    const g = new THREE.Group();
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.8, 1.1, 32), new THREE.MeshBasicMaterial({ color: 0xff4466, transparent: true, opacity: 0.9, side: THREE.DoubleSide, depthWrite: false }));
    ring.rotation.x = -Math.PI / 2; ring.position.y = 0.08; g.add(ring);
    const pillar = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 6, 8, 1, true), new THREE.MeshBasicMaterial({ color: 0xff4466, transparent: true, opacity: 0.5, depthWrite: false }));
    pillar.position.y = 3; g.add(pillar);
    const icon = sprite('🆘', { font: 'bold 64px system-ui', w: 96, h: 96 }, [1, 1]); icon.position.y = 3.4; g.add(icon);
    g.position.set(x, y, z);
    this.scene.add(g);
    this.pings.push({ g, ring, t: 0, fl });
  }

  /** Screen point → truck grid cell (for drag-to-aim). null when not over the truck. */
  pickGrid(clientX, clientY) {
    const v = new THREE.Vector2((clientX / innerWidth) * 2 - 1, -(clientY / innerHeight) * 2 + 1);
    this.raycaster.setFromCamera(v, this.camera);
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -(TRUCK.floorY + CELL));
    const hit = new THREE.Vector3();
    if (!this.raycaster.ray.intersectPlane(plane, hit)) return null;
    const gx = Math.floor((hit.z - TRUCK.z0) / CELL), gz = Math.floor((TRUCK.bayX1 - hit.x) / CELL);
    if (gx < -1 || gz < -1 || gx > GRID.W || gz > GRID.D) return null;
    return { gx: Math.max(0, Math.min(GRID.W - 1, gx)), gz: Math.max(0, Math.min(GRID.D - 1, gz)) };
  }

  /** Which grid step looks like "up/down/left/right" on screen right now (D-pad). */
  gridStepFor(sx, sy) {
    const base = gridToWorld(1.5, 1.5, 0);
    const proj = (w) => new THREE.Vector3(w.x, TRUCK.floorY, w.z).project(this.camera);
    const o = proj(base);
    let best = null, bestDot = -Infinity;
    for (const [dgx, dgz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const q = proj(gridToWorld(1.5 + dgx, 1.5 + dgz, 0));
      const dx = q.x - o.x, dy = -(q.y - o.y), l = Math.hypot(dx, dy) || 1;
      const dot = (dx / l) * sx + (dy / l) * sy;
      if (dot > bestDot) { bestDot = dot; best = { dgx, dgz }; }
    }
    return best;
  }

  frame(dt) {
    const snap = this.snap;
    const t = performance.now() / 1000;
    let me = null;
    const myFl = snap?.players.find(p => p.id === this.myId)?.fl || 0;
    (this.storeys || []).forEach((g, k) => { if (k) g.visible = k <= myFl; }); // floors above you are lifted off
    // only your floor's movers and things show (plus anyone on the stairs next to it); the floor below stays under the floorboards
    const seen = (o) => { const f = o.fl || 0; return f === myFl || (Math.abs(f - myFl) <= 1 && Math.abs((o.y || 0) - f * STOREY_H) > 0.01); };
    for (const pg of this.pings || []) pg.g.visible = (pg.fl || 0) === myFl;
    for (const [id, v] of this.players) {
      const p = v.data;
      if (!p) continue;
      if (id === this.myId) me = p;
      const r = v.root;
      r.position.x = damp(r.position.x, p.x, 14, dt);
      r.position.z = damp(r.position.z, p.z, 14, dt);
      r.position.y = damp(r.position.y, p.y || 0, 14, dt);
      r.visible = seen(p);
      let df = p.face - v.face; df = Math.atan2(Math.sin(df), Math.cos(df));
      v.face += df * Math.min(1, dt * 12);
      v.root.userData.body.rotation.y = v.face;
      const moving = Math.hypot(r.position.x - p.x, r.position.z - p.z) > 0.03;
      const body = v.root.userData.body;
      body.position.y = snap?.zeroG && !p.out ? 0.45 + Math.sin(t * 2.5 + r.position.x) * 0.2 : p.out ? 0.6 + Math.sin(t * 2) * 0.15 : moving ? Math.abs(Math.sin(t * 12)) * 0.12 : (p.char === 'glorp' ? Math.sin(t * 3) * 0.04 + 0.04 : 0);
      body.rotation.z = moving ? Math.sin(t * (p.injured > 0 ? 7 : 12)) * (p.injured > 0 ? 0.2 : 0.06) : 0; // injured: a limp
      if (p.dashing) body.rotation.x = 0.3; else body.rotation.x = 0;
    }
    for (const v of this.items.values()) {
      const it = v.data;
      if (!it) continue;
      const o = v.obj;
      if (it.state === 'loaded') {
        if (o.userData.dropTo !== undefined && !this.drive) {
          const before = o.position.y;
          o.position.y = Math.max(o.userData.dropTo, o.position.y - dt * 14);
          if (before > o.userData.dropTo && o.position.y === o.userData.dropTo) this.dropFx(o.position.x, o.position.y + 0.1, o.position.z);
        }
        continue;
      }
      // the "before" piece shudders while someone works on it, then disappears into the cloud
      if (v.oldObj) {
        v.swapT -= dt;
        v.oldObj.position.set(o.position.x + (Math.random() - 0.5) * 0.12, Math.random() * 0.06, o.position.z + (Math.random() - 0.5) * 0.12);
        if (v.swapT <= 0) {
          this.scene.remove(v.oldObj); v.oldObj = null;
          o.visible = true; o.userData.pop = 0.3;
        }
      }
      if (o.userData.pop > 0) { o.userData.pop = Math.max(0, o.userData.pop - dt); const k = 1 - o.userData.pop / 0.3; o.scale.setScalar(0.75 + 0.25 * k + Math.sin(k * Math.PI) * 0.12); }
      const worked = it.task && it.state === 'floor';
      if (worked) o.rotation.z = Math.sin(performance.now() / 45) * 0.03 * (it.task.kind === 'disassemble' ? 1.6 : 0.8);
      else if (o.rotation.z) o.rotation.z = 0;
      if (it.type === 'flatdolly') {
        o.visible = it.state !== 'gone' && it.state !== 'parked'; // resetting / parked at the truck
        if (!o.userData.tag) { o.userData.tag = sprite('🛞 FURNITURE DOLLY', { fg: '#ffd166', stroke: '#171310', font: 'bold 34px system-ui', w: 400 }, [2.4, 0.5]); o.userData.tag.position.y = 1.5; o.add(o.userData.tag); }
        o.userData.tag.visible = it.state === 'floor';
        if (it.state === 'floor') o.userData.tag.position.y = 1.5 + Math.sin(t * 3) * 0.12;
      }
      if (it.state === 'flat') { // riding the furniture dolly
        const dv = this.items.get(it.on);
        if (dv) {
          o.position.x = damp(o.position.x, dv.obj.position.x, 16, dt);
          o.position.z = damp(o.position.z, dv.obj.position.z, 16, dt);
          o.position.y = damp(o.position.y, 0.36 + (dv.data?.y || 0), 14, dt);
          o.visible = seen(it);
          o.rotation.y = dv.obj.rotation.y;
        }
        continue;
      }
      if (it.state === 'dolly') { // riding on a dolly: stacked in order, bottom first
        const d = this.snap.items.find(x => x.id === it.on), dv = d && this.items.get(d.id);
        if (dv) {
          const idx = d.stack.indexOf(it.id);
          o.position.x = damp(o.position.x, dv.obj.position.x, 16, dt);
          o.position.z = damp(o.position.z, dv.obj.position.z, 16, dt);
          o.position.y = damp(o.position.y, 0.14 + idx * 0.82 + (d.y || 0), 14, dt);
          o.visible = seen(it);
          o.rotation.y = dv.obj.rotation.y;
        }
        continue;
      }
      if (it.type === 'flatdolly') { const pu = it.pusher && this.players.get(it.pusher); if (pu) o.rotation.y = pu.face - Math.PI / 2; } // pushed lengthwise
      if (it.type === 'dolly') {
        const pusher = it.pusher && this.players.get(it.pusher);
        if (pusher) o.rotation.y = pusher.face + Math.PI;
        if (!o.userData.warn) { o.userData.warn = sprite('⚠️ CRUSHING!', { fg: '#ff4466', stroke: '#171310', font: 'bold 40px system-ui' }, [2.2, 0.55]); o.userData.warn.position.y = 3.1; o.add(o.userData.warn); }
        o.userData.warn.visible = it.strain > 0.25;
        if (it.strain > 0.25) o.userData.warn.material.opacity = 0.5 + Math.abs(Math.sin(t * (6 + it.strain * 10))) * 0.5;
      }
      const solo = it.state === 'carried' && !ITEM_TYPES[it.type].teamCarry;
      const team = it.state === 'carried' && ITEM_TYPES[it.type].teamCarry;
      const ty = (solo ? 1.85 : team ? (it.n > 1 ? 0.9 : 0.25) : 0) + (snap?.zeroG && it.state === 'floor' ? 0.6 + Math.sin(t * 2 + it.x) * 0.3 : 0);
      o.position.x = damp(o.position.x, it.x, 14, dt);
      o.position.z = damp(o.position.z, it.z, 14, dt);
      o.position.y = damp(o.position.y, ty + (it.y || 0), 12, dt);
      if (it.type !== 'flatdolly') o.visible = seen(it);
      if (!(o.userData.pop > 0)) { if (solo) o.scale.setScalar(0.75); else o.scale.setScalar(1); }
    }
    if (snap?.cat) {
      this.cat.visible = myFl === 0; // the cat lives downstairs
      this.cat.position.x = damp(this.cat.position.x, snap.cat.x, 8, dt);
      this.cat.position.z = damp(this.cat.position.z, snap.cat.z, 8, dt);
      this.cat.rotation.y = snap.cat.face;
      this.cat.position.y = Math.abs(Math.sin(t * 8)) * 0.05 + (snap.cat.y || 0);
    }
    // arms up while carrying, swinging while walking
    for (const v of this.players.values()) {
      const p = v.data; if (!p) continue;
      addXray(v.root.userData.body); // models arrive late: give new meshes a see-through-walls silhouette
      const carrying = !!p.carry;
      const walking = Math.hypot(v.root.position.x - p.x, v.root.position.z - p.z) > 0.03;
      v.root.userData.body.traverse(o => {
        if (o.userData.arm === undefined) return;
        const target = carrying ? -2.7 : walking ? Math.sin(t * 12 + o.userData.arm) * 0.6 : 0;
        o.rotation.x += (target - o.rotation.x) * Math.min(1, dt * 12);
      });
      if (carrying && !v.wasCarrying) v.squash = 0.25; // little squash when lifting
      v.wasCarrying = carrying;
      if (v.squash > 0) { v.squash = Math.max(0, v.squash - dt); const k = v.squash * 0.8; v.root.userData.body.scale.set(1 + k, 1 - k, 1 + k); }
      if (p.task) {
        const it = snap.items.find(i => i.id === p.task.id);
        if (it) {
          const sc = this.dustScale(it.type);
          if (Math.random() < dt * (5 + 7 * sc)) this.dustCloud(it.x, it.z, it.type, p.task.kind, 1);
          if (p.task.kind === 'disassemble' && Math.random() < dt * 3) this.burst(it.x, 0.9, it.z, [0x9aa3b8], 1, 2.2, 0.6, 0.45); // a stray bolt
        }
      }
    }
    // particles
    this.puffs = this.puffs.filter(m => {
      const u = m.userData; u.t += dt;
      const k = u.t / u.life;
      m.position.x += u.vx * dt; m.position.z += u.vz * dt; m.position.y += u.vy * dt;
      u.vx *= 0.97; u.vz *= 0.97;
      m.scale.setScalar(u.s0 * (1 + k * u.grow));
      m.material.opacity = 0.9 * (1 - k * k) * Math.min(1, u.t * 8);
      if (k >= 1) { this.scene.remove(m); m.material.dispose(); return false; }
      return true;
    });
    this.parts = this.parts.filter(m => {
      const u = m.userData; u.t += dt;
      u.v.y -= 9.8 * dt; m.position.addScaledVector(u.v, dt);
      if (m.position.y < 0.05) { m.position.y = 0.05; u.v.y *= -0.3; u.v.x *= 0.7; u.v.z *= 0.7; }
      m.rotation.x += u.spin * dt; m.rotation.y += u.spin * dt;
      m.material.opacity = Math.max(0, 1 - u.t / u.life);
      if (u.t > u.life) { this.scene.remove(m); m.material.dispose(); return false; }
      return true;
    });

    // emotes
    this.emotes = this.emotes.filter(e => {
      e.t += dt; e.s.position.y += dt * 1.2; e.s.material.opacity = 1 - e.t / 1.4;
      if (e.t > 1.4) { this.scene.remove(e.s); e.s.material.map.dispose(); return false; }
      return true;
    });

    // 🆘 beacons
    this.pings = this.pings.filter(pg => {
      pg.t += dt;
      const k = (pg.t * 1.5) % 1;
      pg.ring.scale.setScalar(1 + k * 1.5); pg.ring.material.opacity = 0.9 * (1 - k);
      if (pg.t > 7) { this.scene.remove(pg.g); return false; }
      return true;
    });

    // guide arrow
    this.arrow.visible = false;
    if (me && snap?.phase === 'playing' && !me.out && !me.spectator && !me.loadMode) {
      let tx = null, tz = null;
      const op = this.objectivePos();
      const fl = me.fl || 0, down = fl > 0 && this.level?.stairs?.find(st => st.b === fl - 1); // upstairs: the way down is the stairs
      if (op) { if (Math.hypot(op.x - me.x, op.z - me.z) > 1.8) { tx = op.x; tz = op.z; } }
      else if (this.showArrow === false) { /* guidance arrow turned off in settings */ }
      else if (me.carry || (me.dolly && snap.items.find(i => i.id === me.dolly)?.stack?.length >= 3)) {
        if (down) { tx = (down.x0 + down.x1) / 2; tz = down.dir > 0 ? down.zh + 0.6 : down.zl - 0.6; } else { tx = 11.2; tz = 0; }
      }
      else {
        let bd = Infinity;
        for (const it of snap.items) {
          if ((it.fl || 0) !== fl) continue; // only what's on your floor
          if (it.state !== 'floor' && !(it.state === 'carried' && it.n === 1 && !it.carriers?.includes?.(me.id) && ITEM_TYPES[it.type].teamCarry)) continue;
          const d = Math.hypot(it.x - me.x, it.z - me.z);
          if (d < bd) { bd = d; tx = it.x; tz = it.z; }
        }
        if (bd < 2.2) tx = null; // already there
      }
      if (tx !== null) {
        const pr = this.players.get(this.myId)?.root.position;
        if (pr) {
          this.arrowPivot.position.set(pr.x, pr.y, pr.z);
          this.arrowPivot.rotation.y = Math.atan2(tx - pr.x, tz - pr.z) + Math.PI;
          this.arrow.position.z = -1.25;
          this.arrow.material.color.set(me.carry ? 0x55ffcc : 0xffd166);
          this.arrow.material.opacity = 0.6 + Math.sin(t * 5) * 0.25;
          this.arrow.visible = true;
        }
      }
    }

    // training objective marker
    const op = this.objectivePos();
    this.objective.visible = !!op && snap?.phase === 'playing' && !me?.loadMode;
    if (op) {
      this.objective.position.set(op.x, op.y || 0, op.z);
      this.objCone.position.y = 2.9 + Math.abs(Math.sin(t * 4)) * 0.6;
      this.objCone.rotation.y += dt * 2;
      const k = (t * 1.2) % 1; this.objRing.scale.setScalar(0.8 + k * 0.9); this.objRing.material.opacity = 1 - k;
    }

    // column heights in load mode
    const showCols = false; // no floating column numbers (the see-through preview shows where it lands)
    const hts = showCols ? this.heights() : null;
    for (const sp of this.colLabels) {
      sp.visible = showCols;
      if (!showCols) continue;
      const hv = hts[sp.userData.gx][sp.userData.gz];
      const txt = hv >= GRID.H ? 'FULL' : String(hv);
      if (sp.userData.v !== txt) {
        sp.userData.v = txt;
        sp.material.map.dispose();
        sp.material.map = labelTexture(txt, { fg: hv >= GRID.H ? '#ff4466' : '#55ffcc', stroke: '#171310', font: `bold ${txt.length > 1 ? 34 : 60}px system-ui`, w: 96, h: 96 });
        sp.material.needsUpdate = true;
      }
      const wp = gridToWorld(sp.userData.gx, sp.userData.gz, Math.min(hv, GRID.H));
      sp.position.set(wp.x, wp.y + 0.35, wp.z);
    }

    // ghost: where the carried piece will land, or which piece you'd pull out
    this.ghost.visible = false;
    if (me?.loadMode && me.cursor && me.carry) {
      const it = snap.items.find(i => i.id === me.carry);
      if (it) {
        const cells = shapeCells(it.type, me.cursor.rot);
        const h = this.heights();
        let y = 0, top = 0;
        const low = new Map();
        for (const [cx, cy, cz] of cells) { top = Math.max(top, cy); const k = cx + ',' + cz; if (!low.has(k) || low.get(k)[2] > cy) low.set(k, [cx, cz, cy]); }
        for (const [cx, cz, lo] of low.values()) y = Math.max(y, (h[me.cursor.gx + cx]?.[me.cursor.gz + cz] ?? 9) - lo);
        const ok = y + top < GRID.H;
        this.setGhostCells(cells);
        const wp = gridToWorld(me.cursor.gx, me.cursor.gz, Math.min(y, GRID.H - 1 - top));
        this.ghost.position.set(wp.x, wp.y + (ok ? 0 : 0.4), wp.z);
        this.ghostMat.color.set(ok ? 0x55ffcc : 0xff4466);
        this.ghostMat.opacity = 0.3 + Math.sin(t * 6) * 0.1;
        this.ghost.visible = true;
        this.ghostOk = ok;
        this.ghostY = y;
      }
    } else if (me?.loadMode && me.unloading && me.cursor) {
      const occ = this.occupancy();
      const col = occ[me.cursor.gx]?.[me.cursor.gz] || [];
      let id = null;
      for (let y = GRID.H - 1; y >= 0; y--) if (col[y]) { id = col[y]; break; }
      const it = id && snap.items.find(i => i.id === id);
      this.pullTarget = it ? ITEM_TYPES[it.type].label : null;
      if (it) {
        this.setGhostCells(cellsOf(it));
        const wp = gridToWorld(it.g.x, it.g.z, it.g.y);
        this.ghost.position.set(wp.x, wp.y + 0.05, wp.z);
        this.ghostMat.color.set(0xffd166);
        this.ghostMat.opacity = 0.35 + Math.sin(t * 6) * 0.15;
        this.ghost.visible = true;
      } else {
        this.setGhostCells([[0, 0, 0]]);
        const wp = gridToWorld(me.cursor.gx, me.cursor.gz, 0);
        this.ghost.position.set(wp.x, wp.y, wp.z);
        this.ghostMat.color.set(0x888899); this.ghostMat.opacity = 0.2;
        this.ghost.visible = true;
      }
    }
    this.rampZone.material.opacity = me?.carry ? 0.2 + Math.sin(t * 4) * 0.1 : 0.1;

    // drive-off: shutter down, then the truck pulls away with the load
    if (this.drive) {
      const d = this.drive;
      d.t += dt;
      // 1) the ramp swings up level and slides away under the truck floor, 2) the shutter rolls down, 3) off it goes
      const ease = (k) => k * k * (3 - 2 * k), seg = (a, b) => ease(Math.min(1, Math.max(0, (d.t - a) / (b - a))));
      if (this.ramp && this.rampHome) {
        const h = this.rampHome, up = seg(0, 0.5), slide = seg(0.5, 1.3);
        this.ramp.rotation.z = h.rot * (1 - up);
        this.ramp.position.y = h.y - 0.1 * up;                      // just under the floor surface
        this.ramp.position.x = h.x + h.len * slide;                 // into the slot
        this.ramp.visible = slide < 0.98;
      }
      this.shutter.scale.y = Math.max(0.001, seg(1.3, 2.5));
      const go = Math.max(0, d.t - 2.7);
      const dx = Math.min(80, 3 * go * go);
      this.truckGroup.position.x = dx;
      this.truckGroup.position.y = go > 0 ? Math.abs(Math.sin(d.t * 18)) * 0.05 : 0;
      for (const v of this.items.values()) {
        if (v.data?.state !== 'loaded') continue;
        v.obj.position.x = (v.obj.userData.baseX ?? v.obj.position.x) + dx;
        if (d.damaged.has(v.data.id) && d.t > 3.4 && v.obj.visible) {
          if (!d.burst) { d.burst = true; this.shakeT = 0.5; }
          const b = sprite('💥', { font: 'bold 70px system-ui', w: 96, h: 96 }, [1.4, 1.4]);
          b.position.copy(v.obj.position); b.position.y += 1.2;
          this.scene.add(b); this.emotes.push({ s: b, t: 0 });
          v.obj.visible = false;
        }
      }
      this.camTarget.set(15.4 + dx * 0.6, 1, 0); this.camOff = [-9, 13, 14];
    }

    // camera
    if (this.drive) { /* following the truck (set above) */ }
    else if (me) {
      if (me.loadMode) { this.camTarget.set(15.2, 1.5, 0); this.camOff = [-6, 11, 9]; }
      else { this.camTarget.set(me.x, me.y || 0, me.z); this.camOff = [0, 13, 8]; } // close in: you see your room and the next, not the whole house
    } else if (this.demoMode && this.players.size) {
      // menu backdrop: drift between the AI movers; nudge left on wide screens so the action sits beside the menu
      const list = [...this.players.values()];
      const v = list[Math.floor(performance.now() / 9000) % list.length];
      const wide = innerWidth > 760;
      this.camTarget.set(v.root.position.x - (wide ? 7 : 0), 0, v.root.position.z + (wide ? 0 : 3));
      this.camOff = [-4, 15, 14];
    } else { this.camTarget.set(-2, 0, 0); this.camOff = [0, 34, 20]; }
    const zoom = me && !me.loadMode ? (this.camZoom || 1) : 1; // settings: Close / Normal / Far (walking around only)
    let [ox, oy, oz] = this.camOff.map(v => v * zoom);
    if (me && !me.loadMode && this.camYaw) { // middle-mouse drag turns the camera around you
      const c = Math.cos(this.camYaw), sn = Math.sin(this.camYaw);
      [ox, oz] = [ox * c + oz * sn, -ox * sn + oz * c];
    }
    const k = 4;
    this.camera.position.x = damp(this.camera.position.x, this.camTarget.x + ox, k, dt);
    this.camera.position.y = damp(this.camera.position.y, this.camTarget.y + oy, k, dt);
    this.camera.position.z = damp(this.camera.position.z, this.camTarget.z + oz, k, dt);
    this.lookAt = this.lookAt || this.camTarget.clone();
    this.lookAt.lerp(this.camTarget, 1 - Math.exp(-k * dt));
    this.camera.lookAt(this.lookAt);
    if (this.shakeT > 0) {
      this.shakeT -= dt;
      this.camera.position.x += (Math.random() - 0.5) * 0.5;
      this.camera.position.y += (Math.random() - 0.5) * 0.5;
    }
    // keep the sun (and its shadow map) centred on what the camera looks at, snapped to whole metres so shadows don't shimmer
    const fx = Math.round(this.camTarget.x), fz = Math.round(this.camTarget.z);
    this.sun.target.position.set(fx, 0, fz); this.sun.position.set(fx + 12, 30, fz + 14);
    this.renderer.render(this.scene, this.camera);
  }
}

function energyTexture(e, injured) {
  const c = document.createElement('canvas');
  c.width = 220; c.height = 40;
  const g = c.getContext('2d');
  g.fillStyle = 'rgba(23,19,16,.75)'; g.beginPath(); g.roundRect(0, 0, 220, 40, 20); g.fill();
  if (injured > 0) {
    g.fillStyle = '#ff4d5e'; g.font = 'bold 24px system-ui'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(`🤕 HURT ${Math.ceil(injured)}s`, 110, 21);
  } else {
    g.fillStyle = e > 0.5 ? '#55ffcc' : e > 0.25 ? '#ffd166' : '#ff4d5e';
    g.beginPath(); g.roundRect(4, 4, Math.max(20, 212 * Math.max(0, e)), 32, 16); g.fill();
    g.fillStyle = '#171310'; g.font = 'bold 20px system-ui'; g.textAlign = 'left'; g.textBaseline = 'middle'; g.fillText('⚡', 10, 21);
  }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}
function progressTexture(p, kind) {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 40;
  const g = c.getContext('2d');
  g.fillStyle = 'rgba(0,0,0,.6)'; g.beginPath(); g.roundRect(0, 0, 256, 40, 20); g.fill();
  g.fillStyle = kind === 'wrap' ? '#6f95ff' : '#ffd166'; g.beginPath(); g.roundRect(4, 4, Math.max(32, 248 * Math.min(1, p)), 32, 16); g.fill();
  g.fillStyle = '#fff'; g.font = 'bold 22px system-ui'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(kind === 'wrap' ? 'PAD-WRAPPING…' : 'DISASSEMBLING…', 128, 21);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}
