import test from 'node:test';
import assert from 'node:assert/strict';
import { createGrid, placeItem, cloneGrid } from '../shared/logic.js';
import { choosePlacement } from '../server/bot.js';

const mk = (id, type, extra = {}) => ({ id, type, wrapped: true, ...extra });
const seq = (...vals) => { let i = 0; return () => vals[i++ % vals.length]; };

test('cloneGrid is independent of the original', () => {
  const g = createGrid();
  placeItem(g, mk('a', 'standard'), 0, 0, 0);
  const c = cloneGrid(g);
  placeItem(c, mk('b', 'standard'), 0, 0, 0);
  assert.equal(g.items.size, 1);
  assert.equal(c.items.size, 2);
  assert.equal(g.cells[0][0][1], null);
});

test('hard AI never drops a heavy box onto a fragile one when another spot exists', () => {
  const g = createGrid();
  for (let x = 0; x < 4; x++) for (let z = 0; z < 4; z++) if (x || z) placeItem(g, mk(`f${x}${z}`, 'fragile'), x, z, 0);
  // only (0,0) is free of fragile tops
  const pick = choosePlacement(g, mk('h', 'heavy'), 'hard', Math.random);
  assert.deepEqual([pick.gx, pick.gz], [0, 0]);
});

test('hard AI puts heavy boxes on the floor when the floor has room', () => {
  const g = createGrid();
  placeItem(g, mk('s', 'standard'), 0, 0, 0);
  const pick = choosePlacement(g, mk('h', 'heavy'), 'hard', Math.random);
  const c = cloneGrid(g);
  assert.equal(placeItem(c, mk('h', 'heavy'), pick.gx, pick.gz, pick.rot).y, 0);
});

test('hard AI puts fragile boxes on top of the stack', () => {
  const g = createGrid();
  placeItem(g, mk('a', 'heavy'), 0, 0, 0);
  const pick = choosePlacement(g, mk('f', 'fragile'), 'hard', Math.random);
  assert.deepEqual([pick.gx, pick.gz], [0, 0]);
});

test('easy AI picks any valid spot (driven by rng) and can crush', () => {
  const g = createGrid();
  placeItem(g, mk('f', 'fragile'), 0, 0, 0);
  const pick = choosePlacement(g, mk('h', 'heavy'), 'easy', seq(0));
  assert.ok(pick);
});

test('returns null when nothing fits', () => {
  const g = createGrid();
  for (let x = 0; x < 4; x++) for (let z = 0; z < 4; z++) for (let y = 0; y < 4; y++) placeItem(g, mk(`s${x}${z}${y}`, 'standard'), x, z, 0);
  assert.equal(choosePlacement(g, mk('x', 'standard'), 'hard', Math.random), null);
});
