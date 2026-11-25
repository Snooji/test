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
  assert.ok(Math.max(...widths) - Math.min(...widths) >= 8, 'house width varies');
  const gaps = SEEDS.map(s => generateLevel(s).yardDistance);
  assert.ok(Math.max(...gaps) - Math.min(...gaps) >= 5, 'distance to the truck varies');
});

test('every generated house has 3–6 rooms and stays clear of the truck', () => {
  for (const s of SEEDS) {
    const l = generateLevel(s);
    assert.ok(l.rooms.length >= 3 && l.rooms.length <= 6, `seed ${s}: ${l.rooms.length} rooms`);
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
    for (const r of L.rooms) assert.ok(L.items.some(([t, x, z]) => !ITEM_TYPES[t].furniture && roomOfItem(L, x, z) === r), `seed ${seed}: boxes in ${r.name}`);
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
