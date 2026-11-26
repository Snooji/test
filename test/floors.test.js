// Multi-floor houses: 1–4 floors joined by stairs. Each floor lives in its own strip of the server's flat map (z + 40·k);
// the browser stacks them. These tests walk the stairs, check nothing ends up in a wall or between floors, and that
// everything upstairs can be reached and carried down.
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateLevel, levelFromSnapshot, ROOM_SIZES } from '../shared/level.js';
import { ITEM_TYPES } from '../shared/logic.js';
import { createNav } from '../server/nav.js';

const cells = (t) => { const it = ITEM_TYPES[t]; return it.cells ? it.cells.length : it.w * it.d * (it.h || 1); };
const SEEDS = Array.from({ length: 25 }, (_, i) => 5000 + i * 7919);

test('one floor is exactly the house it always was', () => {
  for (const s of SEEDS.slice(0, 8)) {
    const a = generateLevel(s), b = generateLevel(s, { floors: 1 });
    assert.deepEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)));
    assert.equal(a.floors, 1);
    assert.equal(a.stairs.length, 0);
  }
});

test('n floors: rooms on every floor, n-1 staircases, items spread over every floor, deterministic', () => {
  for (const n of [2, 3, 4]) for (const s of SEEDS) for (const opts of [{}, { mansion: true }, { exact: true }]) {
    const L = generateLevel(s, { ...opts, floors: n });
    const tag = `seed ${s} floors ${n} ${JSON.stringify(opts)}`;
    assert.equal(L.floors, n, tag);
    assert.equal(L.stairs.length, n - 1, tag);
    for (let k = 0; k < n; k++) {
      const rs = L.rooms.filter(r => r.storey === k);
      assert.ok(rs.length >= 3, `${tag}: floor ${k} has ${rs.length} rooms`);
      assert.ok(rs.some(r => r.role === 'stairs'), `${tag}: floor ${k} has the stairwell`);
      assert.ok(L.items.some(([, x, z]) => L.floorOf(z) === k && x <= L.house.x1), `${tag}: something to carry on floor ${k}`);
      for (const r of rs) assert.equal(L.floorOf((r.z0 + r.z1) / 2), k, `${tag}: ${r.name} sits in floor ${k}'s strip`);
    }
    assert.ok(L.rooms.filter(r => r.storey === 0).some(r => r.role === 'living'), `${tag}: the living room is downstairs`);
    for (const r of L.rooms.filter(r => r.storey > 0)) assert.ok(!['living', 'dining', 'kitchen'].includes(r.role), `${tag}: ${r.name} upstairs`);
    assert.ok(L.rooms.some(r => r.role === 'bedroom' && r.storey > 0), `${tag}: bedrooms upstairs`);
    assert.deepEqual(JSON.parse(JSON.stringify(L)), JSON.parse(JSON.stringify(generateLevel(s, { ...opts, floors: n }))), tag);
  }
});

test('multi-floor furnishing: bed + dresser per bedroom, the truck still fits it all, nothing in halls or stairwells', () => {
  for (const n of [2, 3, 4]) for (const s of SEEDS) {
    const L = generateLevel(s, { floors: n });
    const tag = `seed ${s} floors ${n}`;
    const inRoom = (r, x, z) => x > r.x0 && x < r.x1 && z > r.z0 && z < r.z1;
    for (const r of L.rooms.filter(r => r.role === 'bedroom')) {
      const here = L.items.filter(([, x, z]) => inRoom(r, x, z)).map(([t]) => t);
      assert.equal(here.filter(t => t === 'bed').length, 1, `${tag}: ${r.name} has one bed`);
      assert.equal(here.filter(t => t === 'dresser').length, 1, `${tag}: ${r.name} has one dresser`);
    }
    const total = L.items.reduce((a, [t]) => a + cells(t), 0);
    assert.ok(total <= 56, `${tag}: ${total} cells won't fit the truck with room to spare`);
    for (const r of L.rooms.filter(r => r.role === 'hall' || r.role === 'stairs')) {
      for (const [t, x, z] of L.items) {
        const it = ITEM_TYPES[t], hw = Math.max(it.w, 1) / 2, hd = Math.max(it.d, 1) / 2;
        assert.ok(!(x + hw > r.x0 && x - hw < r.x1 && z + hd > r.z0 && z - hd < r.z1), `${tag}: ${t} in the ${r.name}`);
      }
    }
  }
});

test('room sizes stay in range on every floor (stairwells included)', () => {
  for (const n of [2, 4]) for (const s of SEEDS) for (const opts of [{}, { mansion: true }]) {
    const L = generateLevel(s, { ...opts, floors: n });
    for (const r of L.rooms) {
      const lim = ROOM_SIZES[r.role];
      assert.ok(lim, `${r.role} has limits`);
      const a = r.z1 - r.z0, b = r.x1 - r.x0, inR = (v, [lo, hi]) => v >= lo - 0.01 && v <= hi + 0.01; // rooms can be turned either way
      assert.ok((inR(a, lim.len) && inR(b, lim.dep)) || (inR(b, lim.len) && inR(a, lim.dep)), `seed ${s}: ${r.name} (floor ${r.storey}) ${b.toFixed(2)} × ${a.toFixed(2)} outside ${lim.len} / ${lim.dep}`);
    }
  }
});

/** Walk along a staircase lane from one landing to the other, the way the server moves a mover (wall check, then stairs). */
function walk(L, x, z, dir, steps, step = 0.15) {
  const R = 0.45, out = [];
  for (let i = 0; i < steps; i++) {
    const nz = z + dir * step;
    if (!L.hitsWall(x, nz, R)) z = nz;
    z += L.stairShift(x, z);
    out.push({ x, z, y: L.renderY(x, z), f: L.floorOf(z) });
  }
  return out;
}

test('walking up each staircase reaches the next floor and back down, never in a wall, never a visible jump', () => {
  for (const n of [2, 3, 4]) for (const s of SEEDS.slice(0, 10)) {
    const L = generateLevel(s, { floors: n });
    for (const st of L.stairs) {
      const x = (st.x0 + st.x1) / 2, base = 40 * st.b;
      const lowZ = (st.dir > 0 ? st.zl - 0.9 : st.zh + 0.9) + base; // on the landing in front of the bottom step
      assert.ok(!L.hitsWall(x, lowZ, 0.45), `seed ${s} stair ${st.b}: bottom landing is clear`);
      const up = walk(L, x, lowZ, st.dir, 60);
      const top = up[up.length - 1];
      assert.equal(top.f, st.b + 1, `seed ${s} stair ${st.b}: walked up to floor ${st.b + 1} (ended on ${top.f})`);
      assert.ok(Math.abs(top.y - 2.8 * (st.b + 1)) < 0.01, `seed ${s}: standing on floor ${st.b + 1}'s height`);
      let prev = { x, z: lowZ, y: L.renderY(x, lowZ) };
      for (const p of up) {
        const pz = p.z - 40 * p.f, qz = prev.z - 40 * L.floorOf(prev.z);
        assert.ok(Math.abs(pz - qz) <= 0.151 && Math.abs(p.y - prev.y) <= 0.2, `seed ${s} stair ${st.b}: jump ${(pz - qz).toFixed(2)} m / ${(p.y - prev.y).toFixed(2)} m up`);
        prev = p;
      }
      const down = walk(L, x, top.z, -st.dir, 60);
      assert.equal(down[down.length - 1].f, st.b, `seed ${s} stair ${st.b}: walked back down`);
    }
  }
});

test('the rails keep you on the stairs: no stepping off the side halfway up, and the stairwell edge upstairs is closed', () => {
  for (const s of SEEDS.slice(0, 10)) {
    const L = generateLevel(s, { floors: 3 });
    for (const st of L.stairs) {
      const midZ = (st.zl + st.zh) / 2;
      for (const k of [st.b, st.b + 1]) {
        const z = midZ + 40 * k + (k === st.b ? -0.6 : 0.6) * st.dir; // on the flight, on the floor you'd be on there
        // sideways walk from the centre of the flight hits a rail on both sides
        for (const side of [-1, 1]) {
          let x = (st.x0 + st.x1) / 2, moved = 0;
          for (let i = 0; i < 30; i++) { const nx = x + side * 0.1; if (L.hitsWall(nx, z, 0.45)) break; x = nx; moved += 0.1; }
          assert.ok(x > st.x0 - 0.05 && x < st.x1 + 0.05, `seed ${s} stair ${st.b} floor ${k}: walked off the side to x=${x.toFixed(2)}`);
        }
      }
      // upstairs, walking from the landing toward the hole (the low end) along the flight takes you down the stairs, never off a ledge
      const holeZ = (st.dir > 0 ? st.zl - 0.3 : st.zh + 0.3) + 40 * (st.b + 1);
      assert.ok(L.hitsWall((st.x0 + st.x1) / 2, holeZ, 0.45), `seed ${s} stair ${st.b}: the stairwell edge upstairs is railed off`);
    }
  }
});

test('bots can plan a route to every room on every floor and back to the truck', () => {
  for (const n of [2, 4]) for (const s of SEEDS.slice(0, 6)) for (const opts of [{}, { mansion: true }]) {
    const L = generateLevel(s, { ...opts, floors: n });
    const nav = createNav(L);
    for (const r of L.rooms.filter(r => r.role !== 'stairs')) {
      const c = { x: (r.x0 + r.x1) / 2, z: (r.z0 + r.z1) / 2 };
      const path = nav.findPath({ x: 11, z: 0 }, c);
      assert.ok(path, `seed ${s} floors ${n}: no route to ${r.name} on floor ${r.storey}`);
      const back = nav.findPath(c, { x: 11, z: 0 });
      assert.ok(back, `seed ${s}: no route back from ${r.name}`);
      // floor changes only happen on a staircase
      for (let i = 1; i < path.length; i++) {
        const a = path[i - 1], b = path[i];
        if (L.floorOf(a.z) !== L.floorOf(b.z)) assert.ok(L.stairs.some(st => a.x > st.x0 - 0.1 && a.x < st.x1 + 0.1), `seed ${s}: changed floor off the stairs at ${a.x},${a.z}`);
      }
    }
    for (const [t, x, z] of L.items) assert.ok(nav.findPath({ x: 11, z: 0 }, { x, z }), `seed ${s} floors ${n}: ${t} at ${x},${z} unreachable`);
  }
});

test('clients rebuild the same multi-floor house from the snapshot', () => {
  const L = generateLevel(777, { floors: 3, mansion: true });
  const C = levelFromSnapshot({ seed: 777, mansion: true, floors: 3 });
  assert.deepEqual(JSON.parse(JSON.stringify(C)), JSON.parse(JSON.stringify(L)));
});
