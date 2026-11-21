import * as THREE from 'three';
import { ITEM_TYPES, GRID, footprint } from '../../shared/logic.js';
import { WALLS, ROOMS, PROPS, TRUCK, CELL, gridToWorld } from '../../shared/world.js';
import { makeMover, makeItem, makeCat, sprite, labelTexture, mat } from './models.js';

const damp = (a, b, k, dt) => a + (b - a) * (1 - Math.exp(-k * dt));

export class GameScene {
  constructor(container) {
    const mobile = matchMedia('(pointer: coarse)').matches;
    this.renderer = new THREE.WebGLRenderer({ antialias: !mobile, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, mobile ? 1.5 : 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0b0820);
    this.scene.fog = new THREE.Fog(0x0b0820, 45, 90);
    this.camera = new THREE.PerspectiveCamera(42, 1, 0.1, 200);
    this.camTarget = new THREE.Vector3(11, 0, 0);
    this.camera.position.set(11, 22, 13);
    this.shakeT = 0;

    this.scene.add(new THREE.HemisphereLight(0xbfb8ff, 0x2a2040, 1.4));
    const sun = new THREE.DirectionalLight(0xfff1dd, 2.2);
    sun.position.set(12, 30, 14);
    sun.castShadow = true;
    sun.shadow.mapSize.set(mobile ? 1024 : 2048, mobile ? 1024 : 2048);
    Object.assign(sun.shadow.camera, { left: -30, right: 30, top: 20, bottom: -20, near: 1, far: 80 });
    this.scene.add(sun);

    this.buildWorld();
    this.players = new Map(); // id → {root, label, char, carried}
    this.items = new Map();   // id → {obj, key, bar}
    this.cat = makeCat(); this.scene.add(this.cat);
    this.ghost = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({ color: 0x55ffcc, transparent: true, opacity: 0.4, depthWrite: false }));
    this.ghost.visible = false;
    this.ghostEdges = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)), new THREE.LineBasicMaterial({ color: 0xffffff }));
    this.ghost.add(this.ghostEdges);
    this.scene.add(this.ghost);
    this.emotes = [];

    addEventListener('resize', () => this.resize());
    this.resize();
  }

  resize() {
    const w = innerWidth, h = innerHeight;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.fov = w < h ? 58 : 42; // portrait phones see more
    this.camera.updateProjectionMatrix();
  }

  buildWorld() {
    const s = this.scene;
    // lunar ground
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(120, 80), mat(0x3a3358));
    ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true; s.add(ground);
    for (let i = 0; i < 26; i++) { // craters
      const r = 0.6 + Math.random() * 1.8;
      const c = new THREE.Mesh(new THREE.RingGeometry(r * 0.6, r, 20), new THREE.MeshBasicMaterial({ color: 0x2c2645 }));
      c.rotation.x = -Math.PI / 2;
      let x, z;
      do { x = -40 + Math.random() * 80; z = -30 + Math.random() * 60; } while (x > -24 && x < 24 && z > -15 && z < 15);
      c.position.set(x, 0.01, z); s.add(c);
    }
    // stars
    const starGeo = new THREE.BufferGeometry();
    const pts = [];
    for (let i = 0; i < 900; i++) pts.push((Math.random() - 0.5) * 200, 30 + Math.random() * 60, (Math.random() - 0.5) * 200);
    starGeo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    s.add(new THREE.Points(starGeo, new THREE.PointsMaterial({ color: 0xffffff, size: 0.4 })));
    // planet in the sky
    const planet = new THREE.Mesh(new THREE.SphereGeometry(8, 32, 24), mat(0xff8a3d, { emissive: 0x662200, emissiveIntensity: 0.4 }));
    planet.position.set(-30, 25, -60); s.add(planet);

    // yard path + driveway
    const drive = new THREE.Mesh(new THREE.PlaneGeometry(10, 5.2), mat(0x57507a));
    drive.rotation.x = -Math.PI / 2; drive.position.set(5, 0.015, -1); drive.receiveShadow = true; s.add(drive);
    const path = new THREE.Mesh(new THREE.PlaneGeometry(3, 4), mat(0x57507a));
    path.rotation.x = -Math.PI / 2; path.position.set(1, 0.015, -4); s.add(path);

    // room floors + labels
    for (const r of ROOMS) {
      const f = new THREE.Mesh(new THREE.PlaneGeometry(r.x1 - r.x0, r.z1 - r.z0), mat(r.floor));
      f.rotation.x = -Math.PI / 2; f.position.set((r.x0 + r.x1) / 2, 0.02, (r.z0 + r.z1) / 2); f.receiveShadow = true; s.add(f);
      const l = new THREE.Mesh(new THREE.PlaneGeometry(5, 1.25), new THREE.MeshBasicMaterial({ map: labelTexture(r.name.toUpperCase(), { fg: 'rgba(255,255,255,.35)', font: 'bold 44px system-ui', w: 512, h: 128 }), transparent: true }));
      l.rotation.x = -Math.PI / 2; l.position.set((r.x0 + r.x1) / 2, 0.03, r.z0 + 1.4); s.add(l);
    }
    // walls
    const wallMat = mat(0xe9e4ff), trimMat = mat(0x8f7bff);
    for (const w of WALLS) {
      if (w.invisible || w.x0 >= 13) continue;
      const h = 1.3;
      const m = new THREE.Mesh(new THREE.BoxGeometry(w.x1 - w.x0, h, w.z1 - w.z0), wallMat);
      m.position.set((w.x0 + w.x1) / 2, h / 2, (w.z0 + w.z1) / 2); m.castShadow = m.receiveShadow = true; s.add(m);
      const t = new THREE.Mesh(new THREE.BoxGeometry(w.x1 - w.x0 + 0.02, 0.08, w.z1 - w.z0 + 0.02), trimMat);
      t.position.set(m.position.x, h, m.position.z); s.add(t);
    }
    // props
    for (const p of PROPS) {
      let m;
      if (p.kind === 'rug') { m = new THREE.Mesh(new THREE.PlaneGeometry(p.w, p.d), mat(p.color)); m.rotation.x = -Math.PI / 2; m.position.set(p.x, 0.03, p.z); }
      else if (p.kind === 'counter') { m = new THREE.Mesh(new THREE.BoxGeometry(p.w, 0.9, p.d), mat(p.color)); m.position.set(p.x, 0.45, p.z); }
      else if (p.kind === 'bed') { m = new THREE.Group(); const b = new THREE.Mesh(new THREE.BoxGeometry(p.w, 0.5, p.d), mat(p.color)); b.position.y = 0.25; m.add(b); const pil = new THREE.Mesh(new THREE.BoxGeometry(p.w * 0.8, 0.15, 0.6), mat(0xffffff)); pil.position.set(0, 0.55, -p.d / 2 + 0.5); m.add(pil); m.position.set(p.x, 0, p.z); }
      else if (p.kind === 'plant') { m = new THREE.Group(); const pot = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.22, 0.4, 12), mat(0xff8a3d)); pot.position.y = 0.2; m.add(pot); const leaf = new THREE.Mesh(new THREE.IcosahedronGeometry(0.45, 0), mat(0x52d17c, { flatShading: true })); leaf.position.y = 0.7; m.add(leaf); m.position.set(p.x, 0, p.z); }
      else if (p.kind === 'mailbox') { m = new THREE.Group(); const post = new THREE.Mesh(new THREE.BoxGeometry(0.12, 1, 0.12), mat(0xcccccc)); post.position.y = 0.5; m.add(post); const box = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.35, 0.3), mat(0x2ec4b6)); box.position.y = 1.1; m.add(box); m.position.set(p.x, 0, p.z); }
      if (m) { m.traverse(o => { o.castShadow = true; o.receiveShadow = true; }); s.add(m); }
    }
    // front door mat
    const dm = new THREE.Mesh(new THREE.PlaneGeometry(1.2, 3.6), mat(0xffd166));
    dm.rotation.x = -Math.PI / 2; dm.position.set(0.8, 0.03, -4); s.add(dm);

    this.buildTruck();
  }

  buildTruck() {
    const s = this.scene;
    const g = new THREE.Group();
    const body = mat(0xf4f1ff), accent = mat(0x6b4dff), dark = mat(0x2a2640);
    const len = TRUCK.bayX1 - TRUCK.bayX0, wid = TRUCK.z1 - TRUCK.z0;
    const floor = new THREE.Mesh(new THREE.BoxGeometry(len, 0.2, wid + 0.8), dark);
    floor.position.set((TRUCK.bayX0 + TRUCK.bayX1) / 2, TRUCK.floorY - 0.1, 0); floor.receiveShadow = true; g.add(floor);
    // floor grid lines
    const lines = [];
    for (let i = 0; i <= GRID.W; i++) { const z = TRUCK.z0 + i * CELL; lines.push(TRUCK.bayX0, TRUCK.floorY + 0.01, z, TRUCK.bayX1, TRUCK.floorY + 0.01, z); }
    for (let i = 0; i <= GRID.D; i++) { const x = TRUCK.bayX0 + i * CELL; lines.push(x, TRUCK.floorY + 0.01, TRUCK.z0, x, TRUCK.floorY + 0.01, TRUCK.z1); }
    const lg = new THREE.BufferGeometry(); lg.setAttribute('position', new THREE.Float32BufferAttribute(lines, 3));
    g.add(new THREE.LineSegments(lg, new THREE.LineBasicMaterial({ color: 0x55ffcc, transparent: true, opacity: 0.5 })));
    // side walls (low so you can see the stack) + height markers
    for (const sz of [-1, 1]) {
      const w = new THREE.Mesh(new THREE.BoxGeometry(len, 1.4, 0.2), body);
      w.position.set((TRUCK.bayX0 + TRUCK.bayX1) / 2, TRUCK.floorY + 0.7, sz * (wid / 2 + 0.2)); w.castShadow = true; g.add(w);
      const stripe = new THREE.Mesh(new THREE.BoxGeometry(len, 0.2, 0.22), accent);
      stripe.position.set(w.position.x, TRUCK.floorY + 1.3, w.position.z); g.add(stripe);
      for (let y = 1; y <= GRID.H; y++) { // height posts
        const post = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.04, 0.12), mat(0x55ffcc, { emissive: 0x22aa88 }));
        post.position.set(TRUCK.bayX0 + 0.1, TRUCK.floorY + y * CELL, sz * (wid / 2 + 0.2)); g.add(post);
      }
      const pole = new THREE.Mesh(new THREE.BoxGeometry(0.1, GRID.H * CELL, 0.1), mat(0xbbbbcc));
      pole.position.set(TRUCK.bayX0 + 0.1, TRUCK.floorY + GRID.H * CELL / 2, sz * (wid / 2 + 0.2)); g.add(pole);
      // wheels
      for (const wx of [TRUCK.bayX0 + 1, TRUCK.cabX1 - 1.2]) {
        const wh = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 0.35, 18), mat(0x1a1a24));
        wh.rotation.x = Math.PI / 2; wh.position.set(wx, 0.5, sz * (wid / 2 + 0.45)); g.add(wh);
      }
    }
    // front bulkhead + cab
    const bulk = new THREE.Mesh(new THREE.BoxGeometry(0.2, GRID.H * CELL + 0.3, wid + 0.6), body);
    bulk.position.set(TRUCK.bayX1 + 0.1, TRUCK.floorY + (GRID.H * CELL) / 2, 0); bulk.castShadow = true; g.add(bulk);
    const cab = new THREE.Mesh(new THREE.BoxGeometry(TRUCK.cabX1 - TRUCK.bayX1 - 0.2, 2.6, wid + 0.6), accent);
    cab.position.set((TRUCK.bayX1 + TRUCK.cabX1) / 2 + 0.1, 1.6, 0); cab.castShadow = true; g.add(cab);
    const glass = new THREE.Mesh(new THREE.BoxGeometry(0.1, 1, wid), mat(0x9ad7ff, { metalness: 0.8, roughness: 0.1 }));
    glass.position.set(TRUCK.cabX1 + 0.01, 2.2, 0); g.add(glass);
    const logo = new THREE.Mesh(new THREE.PlaneGeometry(3.2, 1.6), new THREE.MeshBasicMaterial({ map: labelTexture('★ STARSIDE MOVERS', { fg: '#fff', font: 'bold 34px system-ui', w: 420, h: 100 }), transparent: true }));
    logo.rotation.x = -Math.PI / 2; logo.rotation.z = Math.PI / 2; logo.position.set((TRUCK.bayX1 + TRUCK.cabX1) / 2 + 0.1, 2.92, 0); g.add(logo);
    // ramp
    const r = TRUCK.ramp;
    const ramp = new THREE.Mesh(new THREE.BoxGeometry(r.x1 - r.x0, 0.12, r.z1 - r.z0 - 0.6), mat(0x8a86a6, { metalness: 0.5 }));
    ramp.position.set((r.x0 + r.x1) / 2, TRUCK.floorY / 2, 0); ramp.rotation.z = Math.atan2(TRUCK.floorY, r.x1 - r.x0); ramp.receiveShadow = true; g.add(ramp);
    const zone = new THREE.Mesh(new THREE.PlaneGeometry(r.x1 - r.x0, r.z1 - r.z0), new THREE.MeshBasicMaterial({ color: 0x55ffcc, transparent: true, opacity: 0.12 }));
    zone.rotation.x = -Math.PI / 2; zone.position.set((r.x0 + r.x1) / 2, 0.04, 0); g.add(zone);
    this.rampZone = zone;
    const sign = new THREE.Mesh(new THREE.PlaneGeometry(3.4, 0.8), new THREE.MeshBasicMaterial({ map: labelTexture('LOAD ZONE ▶', { fg: '#55ffcc', font: 'bold 40px system-ui', w: 400, h: 96 }), transparent: true }));
    sign.rotation.x = -Math.PI / 2; sign.position.set((r.x0 + r.x1) / 2 - 0.3, 0.06, r.z1 + 0.7); g.add(sign);
    s.add(g);
  }

  // ---------- sync ----------
  apply(snap, myId) {
    this.snap = snap;
    this.myId = myId;
    // players
    const seen = new Set();
    for (const p of snap.players) {
      seen.add(p.id);
      let v = this.players.get(p.id);
      if (!v || v.char !== p.char) {
        if (v) this.scene.remove(v.root);
        const root = makeMover(p.char);
        const label = sprite(p.name, { fg: '#fff', stroke: '#000', font: 'bold 40px system-ui' });
        label.position.y = 2.25; root.add(label);
        root.position.set(p.x, 0, p.z);
        this.scene.add(root);
        v = { root, char: p.char, label, face: p.face };
        this.players.set(p.id, v);
      }
      v.data = p;
      v.root.traverse(o => { if (o.material && o !== v.label) { o.material.transparent = p.out; o.material.opacity = p.out ? 0.35 : 1; } });
    }
    for (const [id, v] of this.players) if (!seen.has(id)) { this.scene.remove(v.root); this.players.delete(id); }

    // items
    const seenI = new Set();
    for (const it of snap.items) {
      seenI.add(it.id);
      const key = `${it.state === 'loaded'}|${it.wrapped}|${it.assembled}`;
      let v = this.items.get(it.id);
      if (!v || v.key !== key) {
        if (v) this.scene.remove(v.obj);
        const obj = makeItem(it.type, { wrapped: it.wrapped, assembled: it.assembled, loaded: it.state === 'loaded' });
        obj.position.set(it.x, 0, it.z);
        this.scene.add(obj);
        const bar = sprite('', {}, [1.4, 0.22]); bar.visible = false; bar.position.y = 1.9; obj.add(bar);
        v = { obj, key, bar, barP: -1 };
        this.items.set(it.id, v);
        if (it.state === 'loaded' && it.g) {
          const t = ITEM_TYPES[it.type];
          const wp = gridToWorld(it.g.x, it.g.z, it.g.y, it.g.w, it.g.d);
          obj.position.set(wp.x, wp.y + 3, wp.z); // drops in from above
          obj.userData.dropTo = wp.y;
          // geometry spans t.w along world-x, but grid width runs along world-z
          if (t.w !== t.d && it.g.w === t.w) obj.rotation.y = Math.PI / 2;
        }
      }
      v.data = it;
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

  heights() {
    const h = Array.from({ length: GRID.W }, () => new Array(GRID.D).fill(0));
    for (const it of this.snap?.items || []) {
      if (!it.g) continue;
      for (let x = it.g.x; x < it.g.x + it.g.w; x++) for (let z = it.g.z; z < it.g.z + it.g.d; z++) h[x][z] = Math.max(h[x][z], it.g.y + 1);
    }
    return h;
  }

  emote(id, text) {
    const v = this.players.get(id);
    if (!v) return;
    const s = sprite(text, { font: 'bold 52px system-ui', fg: '#fff', stroke: '#2a1a5e', w: 192, h: 80 }, [1.4, 0.58]);
    s.position.set(v.root.position.x, 2.7, v.root.position.z);
    this.scene.add(s);
    this.emotes.push({ s, t: 0 });
  }

  shake() { this.shakeT = 0.4; }

  frame(dt) {
    const snap = this.snap;
    const t = performance.now() / 1000;
    let me = null;
    for (const [id, v] of this.players) {
      const p = v.data;
      if (!p) continue;
      if (id === this.myId) me = p;
      const r = v.root;
      r.position.x = damp(r.position.x, p.x, 14, dt);
      r.position.z = damp(r.position.z, p.z, 14, dt);
      let df = p.face - v.face; df = Math.atan2(Math.sin(df), Math.cos(df));
      v.face += df * Math.min(1, dt * 12);
      v.root.userData.body.rotation.y = v.face;
      const moving = Math.hypot(r.position.x - p.x, r.position.z - p.z) > 0.03;
      const body = v.root.userData.body;
      body.position.y = p.out ? 0.6 + Math.sin(t * 2) * 0.15 : moving ? Math.abs(Math.sin(t * 12)) * 0.12 : (p.char === 'glorp' ? Math.sin(t * 3) * 0.04 + 0.04 : 0);
      body.rotation.z = moving ? Math.sin(t * 12) * 0.06 : 0;
      if (p.dashing) body.rotation.x = 0.3; else body.rotation.x = 0;
    }
    for (const v of this.items.values()) {
      const it = v.data;
      if (!it) continue;
      const o = v.obj;
      if (it.state === 'loaded') {
        if (o.userData.dropTo !== undefined) { o.position.y = Math.max(o.userData.dropTo, o.position.y - dt * 14); }
        continue;
      }
      const solo = it.state === 'carried' && !ITEM_TYPES[it.type].teamCarry;
      const team = it.state === 'carried' && ITEM_TYPES[it.type].teamCarry;
      const ty = solo ? 1.85 : team ? (it.n > 1 ? 0.9 : 0.25) : 0;
      o.position.x = damp(o.position.x, it.x, 14, dt);
      o.position.z = damp(o.position.z, it.z, 14, dt);
      o.position.y = damp(o.position.y, ty, 12, dt);
      if (solo) o.scale.setScalar(0.75); else o.scale.setScalar(1);
    }
    if (snap?.cat) {
      this.cat.position.x = damp(this.cat.position.x, snap.cat.x, 8, dt);
      this.cat.position.z = damp(this.cat.position.z, snap.cat.z, 8, dt);
      this.cat.rotation.y = snap.cat.face;
      this.cat.position.y = Math.abs(Math.sin(t * 8)) * 0.05;
    }
    // emotes
    this.emotes = this.emotes.filter(e => {
      e.t += dt; e.s.position.y += dt * 1.2; e.s.material.opacity = 1 - e.t / 1.4;
      if (e.t > 1.4) { this.scene.remove(e.s); e.s.material.map.dispose(); return false; }
      return true;
    });

    // ghost
    this.ghost.visible = false;
    if (me?.loadMode && me.cursor && me.carry) {
      const it = snap.items.find(i => i.id === me.carry);
      if (it) {
        const { w, d } = footprint(it.type, me.cursor.rot);
        const h = this.heights();
        let y = 0;
        for (let x = me.cursor.gx; x < me.cursor.gx + w; x++) for (let z = me.cursor.gz; z < me.cursor.gz + d; z++) y = Math.max(y, h[x]?.[z] ?? 9);
        const ok = y < GRID.H;
        const wp = gridToWorld(me.cursor.gx, me.cursor.gz, Math.min(y, GRID.H - 1), w, d);
        this.ghost.scale.set(d * CELL * 0.98, CELL * 0.98, w * CELL * 0.98);
        this.ghost.position.set(wp.x, wp.y + CELL / 2 + (ok ? 0 : CELL), wp.z);
        this.ghost.material.color.set(ok ? 0x55ffcc : 0xff4466);
        this.ghost.material.opacity = 0.3 + Math.sin(t * 6) * 0.1;
        this.ghost.visible = true;
        this.ghostOk = ok;
        this.ghostY = y;
      }
    }
    this.rampZone.material.opacity = me?.carry ? 0.2 + Math.sin(t * 4) * 0.1 : 0.1;

    // camera
    if (me) {
      if (me.loadMode) { this.camTarget.set(15.2, 1.5, 0); this.camOff = [-6, 11, 9]; }
      else { this.camTarget.set(me.x, 0, me.z); this.camOff = [0, 20, 12]; }
    } else { this.camTarget.set(-2, 0, 0); this.camOff = [0, 34, 20]; }
    const [ox, oy, oz] = this.camOff;
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
    this.renderer.render(this.scene, this.camera);
  }
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
