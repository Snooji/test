import test from 'node:test';
import assert from 'node:assert/strict';
import { createGrid, dropHeight, placeItem, tallyVotes, ITEM_TYPES, footprint, orientations } from '../shared/logic.js';

const mk = (id, type, extra = {}) => ({ id, type, wrapped: false, assembled: false, ...extra });

test('drop on empty grid rests at y=0', () => {
  const g = createGrid();
  assert.equal(dropHeight(g, 0, 0, 1, 1), 0);
});

test('stacking increments height', () => {
  const g = createGrid();
  assert.equal(placeItem(g, mk('a', 'standard'), 1, 1, 0).y, 0);
  assert.equal(placeItem(g, mk('b', 'standard'), 1, 1, 0).y, 1);
  assert.equal(dropHeight(g, 1, 1, 1, 1), 2);
});

test('full column returns -1 and placement refused', () => {
  const g = createGrid();
  for (let i = 0; i < 4; i++) placeItem(g, mk('s' + i, 'standard'), 0, 0, 0);
  assert.equal(dropHeight(g, 0, 0, 1, 1), -1);
  assert.equal(placeItem(g, mk('x', 'standard'), 0, 0, 0).ok, false);
});

test('out of bounds footprint returns -1', () => {
  const g = createGrid();
  assert.equal(dropHeight(g, 3, 0, 2, 1), -1);
  assert.equal(dropHeight(g, -1, 0, 1, 1), -1);
});

test('multi-cell piece rests on max of its footprint', () => {
  const g = createGrid();
  placeItem(g, mk('a', 'standard'), 1, 0, 0);
  placeItem(g, mk('b', 'standard'), 1, 0, 0);
  const r = placeItem(g, mk('c', 'couch', { wrapped: true }), 0, 0, 0); // lying couch covers x=0,1,2
  assert.equal(r.y, 2);
});

test('couch is 3 long and has 3 orientations including standing up 3 high', () => {
  const o = orientations('couch');
  assert.equal(o.length, 3);
  assert.deepEqual(footprint('couch', 0), { w: 3, d: 1, h: 1 });
  assert.ok(o.some(f => f.w === 1 && f.d === 1 && f.h === 3), 'standing orientation exists');
});

test('bed is 2x3x1 and can be rotated/flipped into all 6 orientations', () => {
  assert.deepEqual(footprint('bed', 0), { w: 2, d: 3, h: 1 });
  const o = orientations('bed');
  assert.equal(o.length, 6);
  const keys = new Set(o.map(f => `${f.w}${f.d}${f.h}`));
  for (const k of ['231', '321', '213', '312', '123', '132']) assert.ok(keys.has(k), k);
});

test('boxes have a single orientation; rot wraps around', () => {
  assert.equal(orientations('standard').length, 1);
  assert.deepEqual(footprint('couch', 3), footprint('couch', 0));
});

test('standing couch fills 3 vertical cells', () => {
  const g = createGrid();
  const rot = orientations('couch').findIndex(f => f.h === 3);
  const r = placeItem(g, mk('c', 'couch', { wrapped: true }), 2, 2, rot);
  assert.ok(r.ok);
  assert.equal(r.y, 0);
  for (let y = 0; y < 3; y++) assert.equal(g.cells[2][2][y], 'c');
  assert.equal(g.cells[2][2][3], null);
  assert.equal(dropHeight(g, 2, 2, 1, 1, 1), 3);
});

test('standing couch will not fit on a stack of 2', () => {
  const g = createGrid();
  placeItem(g, mk('a', 'standard'), 0, 0, 0);
  placeItem(g, mk('b', 'standard'), 0, 0, 0);
  const rot = orientations('couch').findIndex(f => f.h === 3);
  assert.equal(placeItem(g, mk('c', 'couch', { wrapped: true }), 0, 0, rot).ok, false);
});

test('a flat bed fits in the 4x4 truck; a lying 3-long couch does not fit rotated off the edge', () => {
  const g = createGrid();
  assert.ok(placeItem(g, mk('bed', 'bed', { wrapped: true }), 0, 0, 0).ok);
  assert.equal(placeItem(createGrid(), mk('c', 'couch', { wrapped: true }), 2, 0, 0).ok, false);
});

test('standing couch on a fragile box crushes it', () => {
  const g = createGrid();
  placeItem(g, mk('f', 'fragile'), 1, 1, 0);
  const rot = orientations('couch').findIndex(f => f.h === 3);
  const r = placeItem(g, mk('c', 'couch', { wrapped: true }), 1, 1, rot);
  assert.deepEqual(r.broken, ['f']);
  assert.equal(r.y, 0);
});

test('heavy on fragile breaks the fragile box', () => {
  const g = createGrid();
  placeItem(g, mk('f', 'fragile'), 2, 2, 0);
  const r = placeItem(g, mk('h', 'heavy'), 2, 2, 0);
  assert.ok(r.ok);
  assert.deepEqual(r.broken, ['f']);
  assert.equal(g.items.has('f'), false);
  // heavy falls into the gap left by the broken box
  assert.equal(g.items.get('h').y, 0);
});

test('standard on fragile does not break', () => {
  const g = createGrid();
  placeItem(g, mk('f', 'fragile'), 2, 2, 0);
  const r = placeItem(g, mk('s', 'standard'), 2, 2, 0);
  assert.deepEqual(r.broken, []);
});

test('furniture on fragile breaks it', () => {
  const g = createGrid();
  placeItem(g, mk('f', 'fragile'), 0, 0, 0);
  const r = placeItem(g, mk('d', 'desk', { wrapped: true }), 0, 0, 0);
  assert.deepEqual(r.broken, ['f']);
});

test('unwrapped lamp breaks itself on load; wrapped lamp is fine', () => {
  const g = createGrid();
  assert.deepEqual(placeItem(g, mk('l', 'lamp'), 0, 0, 0).broken, ['l']);
  assert.deepEqual(placeItem(g, mk('l2', 'lamp', { wrapped: true }), 1, 0, 0).broken, []);
});

test('items resting on a broken box settle down', () => {
  const g = createGrid();
  placeItem(g, mk('a', 'standard'), 0, 0, 0);       // y0 at x0
  placeItem(g, mk('f', 'fragile'), 1, 0, 0);        // y0 at x1
  placeItem(g, mk('b', 'standard'), 1, 0, 0);       // y1 at x1 on fragile
  const r = placeItem(g, mk('h', 'heavy'), 1, 0, 0); // y2 — heavy is NOT directly on fragile
  assert.deepEqual(r.broken, []);
});

test('tallyVotes plurality wins, tie goes to caller vote', () => {
  assert.equal(tallyVotes({ a: 'x', b: 'x', c: 'y' }, 'c'), 'x');
  assert.equal(tallyVotes({ a: 'x', b: 'y' }, 'b'), 'y');
  assert.equal(tallyVotes({ a: 'skip', b: 'skip', c: 'x' }, 'c'), 'skip');
  assert.equal(tallyVotes({}, 'a'), 'skip');
});

test('point values match spec', () => {
  assert.equal(ITEM_TYPES.standard.pts, 10);
  assert.equal(ITEM_TYPES.heavy.pts, 20);
  assert.equal(ITEM_TYPES.fragile.pts, 15);
  assert.equal(ITEM_TYPES.lamp.pts, 30);
  assert.equal(ITEM_TYPES.couch.pts, 70);
  assert.equal(ITEM_TYPES.bed.pts, 90);
  assert.equal(ITEM_TYPES.desk.pts, 50);
  assert.equal(ITEM_TYPES.table.pts, 40);
});

// ---- wave 2: shaped items (the "r" floor lamp) ----
import { shapeCells } from '../shared/logic.js';

test('lamp is an r-shaped 3-block piece: a 2-high pole with an arm at the top', () => {
  const cells = shapeCells('lamp', 0).map(c => c.join(',')).sort();
  assert.deepEqual(cells, ['0,0,0', '0,1,0', '1,1,0']);
  assert.equal(ITEM_TYPES.lamp.cells.length, 3);
});

test('lamp has 12 distinct orientations (every way to turn and flip an L of three)', () => {
  assert.equal(orientations('lamp').length, 12);
  for (const o of orientations('lamp')) assert.equal(o.cells.length, 3);
});

test('cuboid orientations are unchanged by the shape system', () => {
  assert.equal(orientations('bed').length, 6);
  assert.equal(orientations('couch').length, 3);
  assert.deepEqual(footprint('couch', 0), { w: 3, d: 1, h: 1 });
});

test('upright lamp drops with its arm overhanging; arm rests on whatever is below it', () => {
  const g = createGrid();
  placeItem(g, mk('s', 'standard'), 1, 0, 0);              // box under where the arm goes
  const r = placeItem(g, mk('l', 'lamp', { wrapped: true }), 0, 0, 0);
  assert.ok(r.ok);
  assert.equal(r.y, 0);                                     // pole on the floor, arm sits on the box
  assert.equal(g.cells[0][0][0], 'l'); assert.equal(g.cells[0][0][1], 'l'); assert.equal(g.cells[1][0][1], 'l');
});

test('upright lamp over a taller stack lifts so the arm clears it', () => {
  const g = createGrid();
  placeItem(g, mk('a', 'standard'), 1, 0, 0);
  placeItem(g, mk('b', 'standard'), 1, 0, 0);               // column x=1 is 2 high
  const r = placeItem(g, mk('l', 'lamp', { wrapped: true }), 0, 0, 0);
  assert.equal(r.y, 1);                                     // arm (local y=1) must sit at y=2
});

test('lamp that would poke out the top is refused', () => {
  const g = createGrid();
  for (let i = 0; i < 3; i++) placeItem(g, mk('s' + i, 'standard'), 0, 0, 0);
  assert.equal(placeItem(g, mk('l', 'lamp', { wrapped: true }), 0, 0, 0).ok, false);
});

// ---- wave 2: exact-fill "Full load" inventories ----
import { buildExactLoad, mulberryFor, canFitAny, isRemovable, removeFromGrid } from '../shared/logic.js';

test('exact load: pieces fill all 64 cells and replaying the solution breaks nothing', () => {
  for (let seed = 1; seed <= 60; seed++) {
    const { pieces, solution } = buildExactLoad(mulberryFor(seed));
    const cells = pieces.reduce((a, t) => a + orientations(t)[0].cells.length, 0);
    assert.equal(cells, 64, `seed ${seed}`);
    const g = createGrid();
    for (const s of solution) {
      const r = placeItem(g, { id: s.id, type: s.type, wrapped: true }, s.gx, s.gz, s.rot);
      assert.ok(r.ok, `seed ${seed}: ${s.type} did not fit`);
      assert.deepEqual(r.broken, [], `seed ${seed}: ${s.type} crushed something`);
    }
    for (let x = 0; x < 4; x++) for (let z = 0; z < 4; z++) for (let y = 0; y < 4; y++) assert.ok(g.cells[x][z][y], `seed ${seed}: hole at ${x},${y},${z}`);
  }
});

test('exact load always includes the big furniture and a lamp', () => {
  for (let seed = 1; seed <= 30; seed++) {
    const { pieces } = buildExactLoad(mulberryFor(seed));
    for (const t of ['bed', 'couch', 'lamp']) assert.ok(pieces.includes(t), `seed ${seed} missing ${t}`);
    assert.ok(pieces.includes('fragile') && pieces.includes('heavy'));
  }
});

test('canFitAny: false once nothing left fits anywhere', () => {
  const g = createGrid();
  for (let x = 0; x < 4; x++) for (let z = 0; z < 4; z++) for (let y = 0; y < 3; y++) placeItem(g, mk(`s${x}${z}${y}`, 'standard'), x, z, 0);
  assert.equal(canFitAny(g, ['couch']), true, 'a flat couch fits on the top layer');
  for (let x = 0; x < 4; x++) for (let z = 0; z < 4; z++) placeItem(g, mk(`t${x}${z}`, 'standard'), x, z, 0);
  assert.equal(canFitAny(g, ['standard']), false);
});

test('only an item with nothing on top of it can be pulled back out', () => {
  const g = createGrid();
  placeItem(g, mk('a', 'standard'), 0, 0, 0);
  placeItem(g, mk('b', 'standard'), 0, 0, 0);
  assert.equal(isRemovable(g, 'a'), false);
  assert.equal(isRemovable(g, 'b'), true);
  removeFromGrid(g, 'b');
  assert.equal(isRemovable(g, 'a'), true);
  assert.equal(g.cells[0][0][1], null);
});
