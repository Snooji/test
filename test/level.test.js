import test from 'node:test';
import assert from 'node:assert/strict';
import { generateLevel, classicLevel } from '../shared/level.js';
import { createNav } from '../server/nav.js';
import { ITEM_TYPES } from '../shared/logic.js';

const SEEDS = Array.from({ length: 40 }, (_, i) => 1000 + i * 7919);
const cells = (type) => { const t = ITEM_TYPES[type]; return t.w * t.d * (t.h || 1); };

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
    assert.ok(total <= 52, `seed ${s}: ${total} cells`);
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
