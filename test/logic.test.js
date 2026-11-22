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
  assert.equal(ITEM_TYPES.lamp.pts, 25);
  assert.equal(ITEM_TYPES.couch.pts, 70);
  assert.equal(ITEM_TYPES.bed.pts, 90);
  assert.equal(ITEM_TYPES.desk.pts, 50);
  assert.equal(ITEM_TYPES.table.pts, 40);
});
