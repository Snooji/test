import test from 'node:test';
import assert from 'node:assert/strict';
import { generateLevel, classicLevel } from '../shared/level.js';
import { createNav } from '../server/nav.js';
import { ITEM_TYPES } from '../shared/logic.js';

const SEEDS = Array.from({ length: 40 }, (_, i) => 1000 + i * 7919);
const cells = (type) => { const t = ITEM_TYPES[type]; return t.cells ? t.cells.length : t.w * t.d * (t.h || 1); }; // shaped pieces (the lamp) count their real cells

test('same seed builds the exact same house (server and every client agree)', () => {
  assert.deepEqual(JSON.parse(JSON.stringify(generateLevel(42))), JSON.parse(JSON.stringify(generateLevel(42))));
});

test('different seeds build different houses: size, rooms and yard distance vary', () => {
  const sigs = new Set(SEEDS.map(s => { const l = generateLevel(s); return `${l.house.x0},${l.house.x1},${l.house.z0},${l.house.z1},${l.rooms.length}`; }));
  assert.ok(sigs.size >= 30, `only ${sigs.size} distinct layouts in 40 seeds`);
  const widths = SEEDS.map(s => { const h = generateLevel(s).house; return h.x1 - h.x0; });
  assert.ok(Math.max(...widths) - Math.min(...widths) >= 4, 'house width varies'); // rooms have size limits now (cottage ~15 m, family house ~19 m with a 1.5 m hallway)
  const gaps = SEEDS.map(s => generateLevel(s).yardDistance);
  assert.ok(Math.max(...gaps) - Math.min(...gaps) >= 5, 'distance to the truck varies');
});

test('every generated house has 3–9 rooms and stays clear of the truck', () => {
  for (const s of SEEDS) {
    const l = generateLevel(s);
    assert.ok(l.rooms.length >= 3 && l.rooms.length <= 9, `seed ${s}: ${l.rooms.length} rooms`);
    assert.ok(l.house.x1 <= 3, `seed ${s}: house overlaps yard`);
    assert.ok(l.house.z0 >= -14 && l.house.z1 <= 14, `seed ${s}: house out of bounds`);
  }
});

test('every item spawns outside walls and is reachable from the truck ramp', () => {
  for (const s of SEEDS) {
    const l = generateLevel(s);
    const nav = createNav(l);
    for (const [type, x, z] of l.items) {
      assert.equal(l.hitsWall(x, z, 0.45), false, `seed ${s}: ${type} at ${x},${z} is in a wall`);
      assert.ok(nav.findPath({ x: 11, z: 0 }, { x, z }), `seed ${s}: ${type} at ${x},${z} unreachable`);
    }
  }
});

test('every house has the full item mix and fits in the 64-cell truck with slack', () => {
  for (const s of SEEDS) {
    const l = generateLevel(s);
    const types = l.items.map(i => i[0]);
    for (const need of ['standard', 'heavy', 'fragile', 'lamp', 'couch', 'bed']) assert.ok(types.includes(need), `seed ${s} missing ${need}`);
    const total = types.reduce((a, t) => a + cells(t), 0);
    assert.ok(total <= 56, `seed ${s}: ${total} cells`);
  }
});

test('classic level keeps the original four-room house', () => {
  const l = classicLevel();
  assert.equal(l.rooms.length, 4);
  assert.equal(l.hitsWall(0, -9, 0.45), true);   // outer wall at x=0
  assert.equal(l.hitsWall(0, -4, 0.45), false);  // front door gap
});

test('roomAt names the room a point is in', () => {
  const l = classicLevel();
  assert.equal(l.roomAt(-5, -6), 'Living Room');
  assert.equal(l.roomAt(5, 5), 'Yard');
});

test('Full load houses hold exactly the 64-cell inventory, all of it reachable', () => {
  for (const s of SEEDS.slice(0, 25)) {
    const l = generateLevel(s, { exact: true });
    const total = l.items.reduce((a, [t]) => a + (ITEM_TYPES[t].cells ? ITEM_TYPES[t].cells.length : ITEM_TYPES[t].w * ITEM_TYPES[t].d * (ITEM_TYPES[t].h || 1)), 0);
    assert.equal(total, 64, `seed ${s}: ${total} cells`);
    assert.equal(l.exact, true);
    const nav = createNav(l);
    for (const [type, x, z] of l.items) {
      assert.equal(l.hitsWall(x, z, 0.45), false, `seed ${s}: ${type} in wall`);
      assert.ok(nav.findPath({ x: 11, z: 0 }, { x, z }), `seed ${s}: ${type} unreachable`);
    }
  }
});

test('same seed + exact flag is deterministic (clients rebuild the same house)', () => {
  assert.deepEqual(JSON.parse(JSON.stringify(generateLevel(9, { exact: true }))), JSON.parse(JSON.stringify(generateLevel(9, { exact: true }))));
});

test('decorations never sit in a doorway (kitchen counters, potted plants)', async () => {
  const { generateLevel } = await import('../shared/level.js');
  let counters = 0;
  for (let seed = 1; seed <= 300; seed++) {
    const L = generateLevel(seed * 7919);
    // a doorway = a gap in an inner wall: sample points along every room edge that aren't wall and aren't the outside
    for (const p of L.props) {
      if (p.kind !== 'counter' && p.kind !== 'plant') continue;
      if (p.kind === 'counter') counters++;
      const w = p.w || 0.8, d = p.d || 0.8;
      // walk a ring just outside the prop; if a door gap is right there, a mover would have to pass through the prop
      for (const r of L.rooms) for (const [x0, z0, x1, z1] of [[r.x0, r.z0, r.x1, r.z0], [r.x0, r.z1, r.x1, r.z1], [r.x0, r.z0, r.x0, r.z1], [r.x1, r.z0, r.x1, r.z1]]) {
        for (let t = 0; t <= 1; t += 0.02) {
          const x = x0 + (x1 - x0) * t, z = z0 + (z1 - z0) * t;
          const inside = Math.abs(x - p.x) < w / 2 + 0.5 && Math.abs(z - p.z) < d / 2 + 0.5;
          const isGap = !L.hitsWall(x, z, 0.05) && L.rooms.filter(q => x >= q.x0 - 0.01 && x <= q.x1 + 0.01 && z >= q.z0 - 0.01 && z <= q.z1 + 0.01).length === 2;
          assert.ok(!(inside && isGap), `seed ${seed * 7919}: ${p.kind} at ${p.x.toFixed(1)},${p.z.toFixed(1)} covers a doorway`);
        }
      }
    }
  }
  assert.ok(counters > 20, 'kitchens still get counters');
});

// ---- round 11: houses that read like homes ----
const ROLE = (L, name) => L.rooms.filter(r => r.role === name);
const roomOfItem = (L, x, z) => L.rooms.find(r => x >= r.x0 && x <= r.x1 && z >= r.z0 && z <= r.z1);
const cellsOf = (t) => (t.cells ? t.cells.length : t.w * t.d * (t.h || 1));

test('new pieces: dresser (standing, heavy, wrap) and coffee table (2x1) are real cargo', async () => {
  const { ITEM_TYPES, orientations } = await import('../shared/logic.js');
  const d = ITEM_TYPES.dresser, c = ITEM_TYPES.coffeetable;
  assert.ok(d && c);
  assert.equal(cellsOf(d), 2); assert.ok(d.heavy && d.furniture && d.needsWrap && !d.teamCarry && d.pts > 0);
  assert.equal(cellsOf(c), 2); assert.ok(c.furniture && !c.teamCarry && !c.heavy && c.pts > 0);
  assert.ok(orientations('dresser').length >= 2, 'stand it up or lay it down');
});

test('room roles follow a real house: living room at the front door, dining next to it, kitchen next to dining, bedrooms furthest', async () => {
  const { generateLevel } = await import('../shared/level.js');
  for (let seed = 1; seed <= 120; seed++) {
    const L = generateLevel(seed * 104729);
    const fd = L.frontDoor;
    const living = ROLE(L, 'living');
    assert.equal(living.length, 1, `seed ${seed}: one living room`);
    const lr = living[0];
    assert.ok(Math.abs(lr.x1 - fd.x) < 0.01 && fd.z >= lr.z0 && fd.z <= lr.z1, `seed ${seed}: living room has the front door`);
    const adj = (a, b) => L.doorsBetween(a, b) > 0;
    const dining = ROLE(L, 'dining')[0], kitchen = ROLE(L, 'kitchen')[0];
    assert.ok(kitchen, `seed ${seed}: every house has a kitchen`);
    if (dining) { assert.ok(adj(lr, dining), `seed ${seed}: dining opens onto the living room`); assert.ok(adj(dining, kitchen) || adj(lr, kitchen), `seed ${seed}: kitchen next to dining`); }
    else assert.ok(adj(lr, kitchen), `seed ${seed}: kitchen next to the living room`);
    const beds = ROLE(L, 'bedroom');
    assert.ok(beds.length >= 1, `seed ${seed}: at least one bedroom`);
    for (const b of beds) assert.ok(L.hopsFromFront(b) >= L.hopsFromFront(kitchen) || L.rooms.length <= 3, `seed ${seed}: bedrooms are further in than the kitchen`);
  }
});

test('furnishing: each bedroom one bed + one dresser, dining table + lamp, living couch + lamp + coffee table, boxes in every room, fits the truck', async () => {
  const { generateLevel } = await import('../shared/level.js');
  const { ITEM_TYPES } = await import('../shared/logic.js');
  for (let seed = 1; seed <= 120; seed++) {
    const L = generateLevel(seed * 7907);
    const inRoom = (r, type) => L.items.filter(([t, x, z]) => t === type && roomOfItem(L, x, z) === r).length;
    for (const r of ROLE(L, 'bedroom')) { assert.equal(inRoom(r, 'bed'), 1, `seed ${seed}: ${r.name} bed`); assert.equal(inRoom(r, 'dresser'), 1, `seed ${seed}: ${r.name} dresser`); }
    for (const r of ROLE(L, 'dining')) { assert.equal(inRoom(r, 'table'), 1, `seed ${seed}: dining table`); assert.ok(inRoom(r, 'lamp') >= 1, `seed ${seed}: dining lamp`); }
    for (const r of ROLE(L, 'living')) { assert.equal(inRoom(r, 'couch'), 1, `seed ${seed}: couch`); assert.ok(inRoom(r, 'lamp') >= 1, `seed ${seed}: living lamp`); assert.equal(inRoom(r, 'coffeetable'), 1, `seed ${seed}: coffee table`); }
    for (const r of L.rooms.filter(r => r.role !== 'hall')) assert.ok(L.items.some(([t, x, z]) => !ITEM_TYPES[t].furniture && roomOfItem(L, x, z) === r), `seed ${seed}: boxes in ${r.name}`);
    const cells = L.items.reduce((a, [t]) => a + cellsOf(ITEM_TYPES[t]), 0);
    assert.ok(cells <= 56, `seed ${seed}: ${cells} cells must fit the 64-cell truck with slack`);
    for (const [t, x, z] of L.items) if (ITEM_TYPES[t].furniture) assert.ok(roomOfItem(L, x, z), `seed ${seed}: ${t} is inside the house`);
  }
});

test('every room gets its own tile set by type', async () => {
  const { generateLevel } = await import('../shared/level.js');
  const L = generateLevel(424242);
  for (const r of L.rooms) assert.ok(r.tiles && r.tiles.floor && r.tiles.wall, `${r.name} has floor + wall tiles`);
  const k = L.rooms.find(r => r.role === 'kitchen'), b = L.rooms.find(r => r.role === 'bedroom');
  assert.notEqual(k.tiles.floor, b.tiles.floor, 'kitchen and bedroom floors differ');
});

test('every room type stays within its own size range (no giant bedrooms)', async () => {
  const { generateLevel, ROOM_SIZES } = await import('../shared/level.js');
  for (let seed = 1; seed <= 200; seed++) {
    for (const opts of [{}, { mansion: true }, { exact: true }]) {
      const L = generateLevel(seed * 31337, opts);
      for (const r of L.rooms) {
        const lim = ROOM_SIZES[r.role];
        assert.ok(lim, `seed ${seed}: ${r.role} has size limits`);
        const a = r.z1 - r.z0, b = r.x1 - r.x0, inR = (v, [lo, hi]) => v >= lo - 0.01 && v <= hi + 0.01; // either way round
        assert.ok((inR(a, lim.len) && inR(b, lim.dep)) || (inR(b, lim.len) && inR(a, lim.dep)), `seed ${seed} ${JSON.stringify(opts)}: ${r.name} ${b.toFixed(2)} × ${a.toFixed(2)} outside ${lim.len} / ${lim.dep}`);
      }
    }
  }
});

test('bedrooms, bathroom and office open onto a hallway; the hallway opens onto the living area', async () => {
  const { generateLevel } = await import('../shared/level.js');
  for (let seed = 1; seed <= 120; seed++) {
    const L = generateLevel(seed * 6151, seed % 3 === 0 ? { mansion: true } : {});
    const halls = L.rooms.filter(r => r.role === 'hall');
    if (!halls.length) continue; // cottages: bedroom straight off the living room
    for (const r of L.rooms.filter(r => ['bedroom', 'bathroom', 'office', 'laundry'].includes(r.role))) assert.ok(halls.some(h => L.doorsBetween(r, h)), `seed ${seed}: ${r.name} opens onto a hallway`);
    assert.ok(L.rooms.some(r => ['living', 'dining', 'kitchen'].includes(r.role) && halls.some(h => L.doorsBetween(r, h))), `seed ${seed}: a hallway reaches the living area`);
  }
});

test('hallways are narrow like a real home (about 1.5 movers wide) and nothing is left standing in them', async () => {
  const { generateLevel } = await import('../shared/level.js');
  const { ITEM_TYPES } = await import('../shared/logic.js');
  for (let seed = 1; seed <= 150; seed++) for (const opts of [{}, { mansion: true }, { exact: true }]) {
    const L = generateLevel(seed * 7919, opts);
    for (const h of L.rooms.filter(r => r.role === 'hall')) {
      const clear = Math.min(h.x1 - h.x0, h.z1 - h.z0) - 0.4; // across the hallway (it can run either way), wall centre to wall centre, minus one wall thickness
      assert.ok(clear >= 1.35 && clear <= 1.6, `seed ${seed}: hallway clear width ${clear.toFixed(2)} m`);
      for (const [t, x, z] of L.items) {
        const it = ITEM_TYPES[t], hw = Math.max(it.w, 1) / 2, hd = Math.max(it.d, 1) / 2;
        assert.ok(!(x + hw > h.x0 && x - hw < h.x1 && z + hd > h.z0 && z - hd < h.z1), `seed ${seed}: ${t} at ${x},${z} blocks the hallway`);
      }
      for (const p of L.props.filter(p => p.kind === 'plant')) assert.ok(!(p.x > h.x0 && p.x < h.x1 && p.z > h.z0 && p.z < h.z1), `seed ${seed}: plant in the hallway`);
    }
  }
});

test('respawns and tools (dollies) never land in a hallway', async () => {
  const { generateLevel, freeSpot } = await import('../shared/level.js');
  const { mulberryFor } = await import('../shared/logic.js');
  for (let seed = 1; seed <= 60; seed++) {
    const L = generateLevel(seed * 104729), rng = mulberryFor(seed);
    for (let k = 0; k < 20; k++) {
      const s = freeSpot(L, [], rng);
      assert.ok(!L.rooms.some(h => h.role === 'hall' && s.x > h.x0 - 0.3 && s.x < h.x1 + 0.3 && s.z > h.z0 && s.z < h.z1), `seed ${seed}: spot ${s.x},${s.z} in a hallway`);
    }
  }
});

test('every inner doorway is listed for the renderer, and sits in a gap in the walls', async () => {
  const { generateLevel } = await import('../shared/level.js');
  for (const s of [11, 222, 3333, 40404, 5150]) for (const opts of [{}, { floors: 3 }, { mansion: true }]) {
    const L = generateLevel(s, opts);
    assert.ok(L.doors.length >= L.rooms.length - L.floors - 2, `seed ${s}: ${L.doors.length} doorways for ${L.rooms.length} rooms`);
    for (const d of L.doors) {
      const x = d.vertical ? d.at : d.c, z = d.vertical ? d.c : d.at;
      assert.ok(!L.hitsWall(x, z, 0.3), `seed ${s}: doorway at ${x},${z} is blocked by a wall`);
      assert.ok(d.w >= 3, 'doorway width');
    }
  }
});

test('rooms get their built-ins (fridge, tub, washer…): against a wall, never in a doorway, never on top of cargo, and everything stays reachable', async () => {
  const { generateLevel } = await import('../shared/level.js');
  const { createNav } = await import('../server/nav.js');
  const seen = new Set();
  for (let seed = 1; seed <= 80; seed++) for (const opts of [{}, { floors: 2 }]) {
    const L = generateLevel(seed * 6007, opts);
    for (const f of L.fixtures) {
      seen.add(f.type);
      const room = L.rooms.find(r => (f.x0 + f.x1) / 2 > r.x0 && (f.x0 + f.x1) / 2 < r.x1 && (f.z0 + f.z1) / 2 > r.z0 && (f.z0 + f.z1) / 2 < r.z1);
      assert.ok(room, `seed ${seed}: ${f.type} outside any room`);
      const gap = Math.min(f.x0 - room.x0, room.x1 - f.x1, f.z0 - room.z0, room.z1 - f.z1);
      assert.ok(gap < 0.3, `seed ${seed}: ${f.type} isn't against a wall`);
      for (const d of L.doors) {
        const x = d.vertical ? d.at : d.c, z = d.vertical ? d.c : d.at;
        assert.ok(!(x > f.x0 - 1 && x < f.x1 + 1 && z > f.z0 - 1 && z < f.z1 + 1), `seed ${seed}: ${f.type} blocks a doorway`);
      }
      for (const [t, x, z] of L.items) assert.ok(!(x > f.x0 - 0.3 && x < f.x1 + 0.3 && z > f.z0 - 0.3 && z < f.z1 + 0.3), `seed ${seed}: ${t} spawned in the ${f.type}`);
    }
    const nav = createNav(L);
    for (const [t, x, z] of L.items) assert.ok(nav.findPath({ x: 11, z: 0 }, { x, z }), `seed ${seed}: ${t} unreachable`);
  }
  for (const t of ['fridge', 'stove', 'tub', 'toilet', 'sink', 'washer', 'dryer', 'bookcase', 'sideboard', 'nightstand']) assert.ok(seen.has(t), `no ${t} in 160 houses`);
});

test('new cargo: armchair, TV (fragile) and bookshelf turn up in homes and fit the truck budget', async () => {
  const { generateLevel } = await import('../shared/level.js');
  const { ITEM_TYPES } = await import('../shared/logic.js');
  assert.ok(ITEM_TYPES.tv.fragile && ITEM_TYPES.bookshelf.h === 2 && ITEM_TYPES.armchair.needsWrap);
  const count = { armchair: 0, tv: 0, bookshelf: 0 };
  for (let seed = 1; seed <= 100; seed++) {
    const L = generateLevel(seed * 4421);
    for (const [t] of L.items) if (t in count) count[t]++;
    const cells = L.items.reduce((a, [t]) => a + cellsOf(ITEM_TYPES[t]), 0);
    assert.ok(cells <= 56, `seed ${seed}: ${cells} cells`);
  }
  for (const [t, n] of Object.entries(count)) assert.ok(n >= 15, `${t} in only ${n} of 100 houses`);
});
