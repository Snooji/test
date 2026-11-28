// Sabotage (pack the house): the shared rules and numbers — room quotas, box mixes, pile value over time, and the endings.
import test from 'node:test';
import assert from 'node:assert/strict';
import { SAB, HOLD, BOX_MIX, roomQuotas, mixBag, pileValueFactor, sabotageOutcome } from '../shared/sabotage.js';
import { mulberry32 } from '../shared/level.js';

const room = (role, w, d) => ({ role, x0: 0, x1: w, z0: 0, z1: d });

test('numbers match the design', () => {
  assert.equal(SAB.PACK_SOLO, 7); assert.equal(SAB.PACK_PAIR, 3); assert.equal(SAB.LOSS_LINE, 0.35); assert.equal(SAB.SAFETY_LINE, 70);
  assert.equal(SAB.SAB_COOLDOWN, 20); assert.equal(HOLD.fixWheel, 3); assert.equal(HOLD.cutTape, 1.5);
  assert.deepEqual(BOX_MIX.bathroom, [0, 0, 1]); assert.deepEqual(BOX_MIX.kitchen, [0.25, 0.15, 0.6]);
  assert.deepEqual(BOX_MIX.kids, BOX_MIX.play);
  assert.equal(BOX_MIX.hall, undefined);
});

test('room quotas: add up to the box cells, nothing in halls, at least one in every other room, bigger rooms get more', () => {
  const rooms = [room('kitchen', 7, 8), room('hall', 2, 20), room('bathroom', 2.5, 3), room('living', 9, 9), room('stairs', 2, 4), room('office', 5, 6)];
  const q = roomQuotas(rooms, 40);
  assert.equal([...q.values()].reduce((a, b) => a + b, 0), 40);
  assert.equal(q.get(1) || 0, 0); assert.equal(q.get(4) || 0, 0);
  for (const i of [0, 2, 3, 5]) assert.ok(q.get(i) >= 1, `room ${i}`);
  assert.ok(q.get(3) > q.get(5) && q.get(3) > q.get(2));
  const tiny = roomQuotas(rooms, 3); // fewer boxes than rooms: still ≥1 where possible, never more than asked
  assert.equal([...tiny.values()].reduce((a, b) => a + b, 0), 3);
});

test('box mixes per room', () => {
  const rng = mulberry32(7);
  assert.ok(mixBag('bathroom', 5, rng).every(t => t === 'fragile'));
  const k = mixBag('kitchen', 20, rng), n = (t) => k.filter(x => x === t).length;
  assert.equal(n('fragile'), 12); assert.equal(n('standard'), 5); assert.equal(n('heavy'), 3);
  assert.equal(mixBag('garage', 10, rng).filter(t => t === 'fragile').length, 0);
  assert.equal(mixBag('unknownroom', 4, rng).length, 4, 'a room not in the table packs standard boxes');
});

test('a burst box pile keeps full value for 10 s, then fades to half by 40 s', () => {
  assert.equal(pileValueFactor(0), 1); assert.equal(pileValueFactor(10), 1);
  assert.equal(pileValueFactor(25), 0.75); assert.equal(pileValueFactor(40), 0.5); assert.equal(pileValueFactor(90), 0.5);
});

test('endings: damage line, outnumbering, all saboteurs out, the drive-off safety bar', () => {
  const base = { houseValue: 1000, lostValue: 0, saboteursAlive: 2, crewAlive: 4, houseEmpty: false, safety: 100, saboteursOut: false };
  assert.equal(sabotageOutcome(base), null);
  assert.equal(sabotageOutcome({ ...base, lostValue: 349 }), null);
  assert.equal(sabotageOutcome({ ...base, lostValue: 350 }).winner, 'saboteur');
  assert.equal(sabotageOutcome({ ...base, crewAlive: 2 }).winner, 'saboteur');
  assert.equal(sabotageOutcome({ ...base, saboteursAlive: 0, saboteursOut: true }).winner, 'crew');
  assert.equal(sabotageOutcome({ ...base, houseEmpty: true, safety: 70 }).winner, 'crew');
  const fail = sabotageOutcome({ ...base, houseEmpty: true, safety: 69 });
  assert.equal(fail.winner, 'saboteur'); assert.match(fail.reason, /Failed inspection/);
});
