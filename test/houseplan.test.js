// House plans: every match gets a different floor plan, not just a resized one. Hallways come in different shapes and
// directions, rooms are turned both ways, the living room moves around, and every door joins rooms that really touch.
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateLevel } from '../shared/level.js';
import { sizeOk } from '../shared/houseplan.js';

const SEEDS = Array.from({ length: 160 }, (_, i) => 31 + i * 104729);
const halls = (L) => L.rooms.filter(r => r.role === 'hall');

test('plans differ in shape: several hallway layouts, hallways both ways, rooms both ways round, the living room all along the front', () => {
  const layouts = {}, hallDir = { z: 0, x: 0 }, bedTurn = { long_z: 0, long_x: 0 }, livingAt = new Set(), shapes = new Set();
  for (const s of SEEDS) {
    const L = generateLevel(s);
    layouts[L.variant.layout] = (layouts[L.variant.layout] || 0) + 1;
    for (const h of halls(L)) hallDir[h.z1 - h.z0 > h.x1 - h.x0 ? 'z' : 'x']++;
    for (const b of L.rooms.filter(r => r.role === 'bedroom')) if (Math.abs((b.z1 - b.z0) - (b.x1 - b.x0)) > 0.6) bedTurn[b.z1 - b.z0 > b.x1 - b.x0 ? 'long_z' : 'long_x']++;
    const lv = L.rooms.find(r => r.role === 'living');
    livingAt.add(Math.round(((lv.z0 + lv.z1) / 2 - L.house.z0) / (L.house.z1 - L.house.z0) * 4)); // which quarter of the front
    // the plan's shape, ignoring sizes: each room's role and which other rooms it opens onto
    shapes.add(L.rooms.map(r => r.role + ':' + L.rooms.filter(o => o !== r && L.doorsBetween(r, o)).map(o => o.role).sort().join('+')).sort().join('|'));
  }
  assert.ok(Object.keys(layouts).length >= 5, `layouts: ${JSON.stringify(layouts)}`);
  for (const [k, n] of Object.entries(layouts)) assert.ok(n >= 8, `${k} only ${n} of ${SEEDS.length}`);
  assert.ok(hallDir.z > 20 && hallDir.x > 20, `hallways along z ${hallDir.z}, along x ${hallDir.x}`);
  assert.ok(bedTurn.long_z > 15 && bedTurn.long_x > 15, `bedrooms long along z ${bedTurn.long_z}, along x ${bedTurn.long_x}`);
  assert.ok(livingAt.size >= 3, `living room only at ${[...livingAt]} (start, middle and end of the front expected)`);
  assert.ok(shapes.size > SEEDS.length * 0.5, // the old one-spine generator managed 31 in these 160, every hallway along z
    `${shapes.size} distinct room-connection shapes in ${SEEDS.length} houses`);
});

test('no seed fails to plan, in any house setup, and every room fits its type', () => {
  for (const opts of [{}, { mansion: true }, { exact: true }, { floors: 2 }, { floors: 3, mansion: true }, { floors: 4 }]) {
    for (let i = 0; i < 250; i++) {
      const s = 977 + i * 7919, L = generateLevel(s, opts);
      for (const r of L.rooms) assert.ok(sizeOk(r.kind, r.x1 - r.x0, r.z1 - r.z0), `seed ${s} ${JSON.stringify(opts)}: ${r.kind} ${(r.x1 - r.x0).toFixed(2)} × ${(r.z1 - r.z0).toFixed(2)}`);
    }
  }
});

test('every room is reachable from the front door through doors and openings, on every floor', () => {
  for (const opts of [{}, { mansion: true }, { exact: true }, { floors: 3 }]) {
    for (const s of SEEDS.slice(0, 80)) {
      const L = generateLevel(s, opts);
      for (const r of L.rooms) assert.ok(Number.isFinite(L.hopsFromFront(r)), `seed ${s} ${JSON.stringify(opts)}: ${r.name} (floor ${r.storey}) has no way in`);
    }
  }
});

test('doors sit in a gap in the wall the two rooms share, wherever the rooms ended up; walls never cross a room', () => {
  for (const opts of [{}, { mansion: true }, { floors: 2 }]) {
    for (const s of SEEDS.slice(0, 60)) {
      const L = generateLevel(s, opts);
      for (const d of L.doors) {
        const x = d.vertical ? d.at : d.c, z = d.vertical ? d.c : d.at;
        // a mover fits through the middle of the doorway, and there's a room on both sides of it
        assert.ok(!L.hitsWall(x, z, 0.45), `seed ${s}: doorway at ${x.toFixed(1)},${z.toFixed(1)} blocked`);
        const a = d.vertical ? [x - 0.5, z] : [x, z - 0.5], b = d.vertical ? [x + 0.5, z] : [x, z + 0.5];
        const inRoom = ([px, pz]) => L.rooms.some(r => px > r.x0 && px < r.x1 && pz > r.z0 && pz < r.z1);
        assert.ok(inRoom(a) && inRoom(b), `seed ${s}: doorway at ${x.toFixed(1)},${z.toFixed(1)} doesn't join two rooms`);
      }
      // no wall runs through the middle of a room (walls only on room edges)
      for (const w of L.houseWalls.filter(w => !w.rail)) {
        const cx = (w.x0 + w.x1) / 2, cz = (w.z0 + w.z1) / 2;
        for (const r of L.rooms) assert.ok(!(cx > r.x0 + 0.3 && cx < r.x1 - 0.3 && cz > r.z0 + 0.3 && cz < r.z1 - 0.3), `seed ${s}: a wall through the ${r.name}`);
      }
    }
  }
});

test('one-floor homes: each private room opens straight onto a hallway, wherever it is (cottages: off the living room)', () => {
  for (const s of SEEDS) {
    const L = generateLevel(s);
    const hs = halls(L);
    for (const r of L.rooms.filter(r => ['bedroom', 'office', 'bathroom', 'laundry', 'den'].includes(r.role))) {
      if (!hs.length) { assert.ok(L.rooms.some(o => o !== r && L.doorsBetween(r, o)), `seed ${s}: ${r.name} has no door`); continue; }
      if (r.role === 'bathroom' && L.rooms.some(b => b.role === 'bedroom' && L.doorsBetween(r, b)) && !hs.some(h => L.doorsBetween(r, h))) continue; // an en-suite
      assert.ok(hs.some(h => L.doorsBetween(r, h)), `seed ${s} (${L.variant.layout}): ${r.name} doesn't open onto a hallway`);
    }
  }
});

/** corners of the ground floor's outline (4 = a rectangle, 6 = an L or a notch, 8+ = a T or stepped) */
function outlineCorners(L) {
  const rs = L.rooms.filter(r => !r.storey), S = 0.25, H = L.house;
  const nx = Math.round((H.x1 - H.x0) / S) + 2, nz = Math.round((H.z1 - H.z0) / S) + 2;
  const inside = (i, k) => { const x = H.x0 + (i - 0.5) * S, z = H.z0 + (k - 0.5) * S; return rs.some(r => x > r.x0 && x < r.x1 && z > r.z0 && z < r.z1); };
  const g = []; for (let i = 0; i <= nx; i++) { g.push([]); for (let k = 0; k <= nz; k++) g[i].push(inside(i, k)); }
  let c = 0;
  for (let i = 1; i <= nx; i++) for (let k = 1; k <= nz; k++) { const n = [g[i - 1][k - 1], g[i][k - 1], g[i - 1][k], g[i][k]].filter(Boolean).length; if (n === 1 || n === 3) c++; }
  return c;
}

test('house outlines vary: rectangles, L-shapes and notches, and T / stepped shapes', () => {
  const hist = {};
  for (let i = 0; i < 200; i++) { const c = outlineCorners(generateLevel(11 + i * 7919)); hist[c] = (hist[c] || 0) + 1; }
  const n = (k) => hist[k] || 0, more = Object.entries(hist).filter(([k]) => Number(k) >= 8).reduce((a, [, v]) => a + v, 0);
  assert.ok(n(4) >= 30 && n(4) <= 100, `rectangles: ${n(4)} of 200 (${JSON.stringify(hist)})`);
  assert.ok(n(6) >= 60, `L-shapes / notches: ${n(6)} of 200`);
  assert.ok(more >= 10, `T / stepped: ${more} of 200`);
});

test('irregular outlines stay sealed: outside walls everywhere except the front door, upstairs too', () => {
  for (const opts of [{}, { mansion: true }, { floors: 3 }]) for (const s of SEEDS.slice(0, 50)) {
    const L = generateLevel(s, opts), fd = L.frontDoor;
    for (const r of L.rooms) {
      const same = L.rooms.filter(q => q.storey === r.storey);
      const outside = (x, z) => !same.some(q => x > q.x0 && x < q.x1 && z > q.z0 && z < q.z1);
      const edges = [[r.x0, r.z0, r.x0, r.z1, -1, 0], [r.x1, r.z0, r.x1, r.z1, 1, 0], [r.x0, r.z0, r.x1, r.z0, 0, -1], [r.x0, r.z1, r.x1, r.z1, 0, 1]];
      for (const [ax, az, bx, bz, nx, nz] of edges) for (let t = 0.05; t < 0.96; t += 0.03) {
        const x = ax + (bx - ax) * t, z = az + (bz - az) * t;
        if (!outside(x + nx * 0.4, z + nz * 0.4)) continue; // an inside wall (or none, where halls join)
        const frontDoor = !r.storey && Math.abs(x - fd.x) < 0.01 && Math.abs(z - fd.z) < 2.1;
        assert.ok(frontDoor || L.hitsWall(x, z, 0.05), `seed ${s} ${JSON.stringify(opts)}: a hole in the outside wall of the ${r.name} at ${x.toFixed(1)},${z.toFixed(1)}`);
      }
    }
  }
});
