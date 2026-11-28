// Sabotage: take flat boxes from the stack, pack them in rooms (7 s alone, 3 s with a partner holding alongside), work log.
import test from 'node:test';
import assert from 'node:assert/strict';
import { sabRoom } from './sabotage-setup.test.js';
import { SAB } from '../shared/sabotage.js';
import { FLOOR_DZ } from '../shared/level.js';

const DT = 0.05;
const BOXES = ['standard', 'heavy', 'fragile'];
/** stand a mover in the middle of a room (by index) */
function standIn(room, p, ri, dx = 0) {
  const r = room.level.rooms[ri];
  p.x = (r.x0 + r.x1) / 2 + dx; p.z = (r.z0 + r.z1) / 2 + FLOOR_DZ * (r.storey || 0);
}
const tap = (room, p) => { p.pending.tapN = 1; room.tick(DT); };
function hold(room, ps, secs) { for (const p of ps) p.in.hold = true; for (let t = 0; t < secs - 1e-6; t += DT) room.tick(DT); }
function takeFlatBox(room, p) {
  const st = room.items.get('flatstack'); p.x = st.x + 0.4; p.z = st.z; tap(room, p);
  return p.carry ? room.items.get(p.carry) : null;
}
const packRoom = (room) => [...room.sab.quota.entries()].find(([, n]) => n > 0)[0];
const looseBoxes = (room) => [...room.items.values()].filter(i => BOXES.includes(i.type) && i.state === 'floor');

test('tap the stack: you carry a flat box (the stack never runs out)', () => {
  const { room, P } = sabRoom();
  const a = P(0), fb = takeFlatBox(room, a);
  assert.equal(fb?.type, 'flatbox');
  assert.equal(fb.state, 'carried');
  assert.ok(room.items.get('flatstack'), 'the stack is still there');
  const b = P(1); assert.equal(takeFlatBox(room, b)?.type, 'flatbox');
});

test('packing alone takes 7 s and turns the flat box into the room\'s next box', () => {
  const { room, P } = sabRoom();
  const a = P(0); takeFlatBox(room, a);
  const ri = packRoom(room), before = room.sab.quota.get(ri), next = room.sab.bags.get(ri)[0];
  standIn(room, a, ri);
  hold(room, [a], SAB.PACK_SOLO - 0.1);
  assert.equal(looseBoxes(room).length, 0, 'not yet at 6.9 s');
  hold(room, [a], 0.15);
  const made = looseBoxes(room);
  assert.equal(made.length, 1);
  assert.equal(made[0].type, next);
  assert.ok(Math.hypot(made[0].x - a.x, made[0].z - a.z) < 1.2, 'at the packer\'s feet');
  assert.equal(room.sab.quota.get(ri), before - 1);
  assert.equal(a.carry, null);
  assert.ok(![...room.items.values()].some(i => i.type === 'flatbox'), 'the flat box was used up');
});

test('with a partner holding alongside it takes 3 s, both get a work-log entry', () => {
  const { room, P } = sabRoom();
  const a = P(0), b = P(1); takeFlatBox(room, a);
  const ri = packRoom(room); standIn(room, a, ri); standIn(room, b, ri, 0.8);
  hold(room, [a, b], SAB.PACK_PAIR + 0.1);
  assert.equal(looseBoxes(room).length, 1);
  assert.ok(room.sab.log.some(l => l.text.includes(a.name) && l.text.includes(b.name) && l.text.includes(room.level.rooms[ri].name)), JSON.stringify(room.sab.log));
});

test('no packing in a hallway or a finished room; you are told why', () => {
  const { room, P, events } = sabRoom();
  const a = P(0); takeFlatBox(room, a);
  const hall = room.level.rooms.findIndex(r => ['hall', 'passage'].includes(r.role));
  if (hall >= 0) { standIn(room, a, hall); hold(room, [a], SAB.PACK_SOLO + 0.5); assert.equal(looseBoxes(room).length, 0); }
  const ri = packRoom(room); room.sab.quota.set(ri, 0);
  standIn(room, a, ri); hold(room, [a], SAB.PACK_SOLO + 0.5);
  assert.equal(looseBoxes(room).length, 0);
  assert.ok(events.some(e => e.to === a.id && /packed|pack/i.test(e.text || '')), 'told why');
});

test('a mover who leaves while carrying a flat box takes nothing with them (no stray flat box, no half-packing)', () => {
  const { room, P } = sabRoom();
  const a = P(0); takeFlatBox(room, a);
  const ri = packRoom(room); standIn(room, a, ri); hold(room, [a], 2);
  room.onLeave({ sessionId: a.id });
  assert.ok(![...room.items.values()].some(i => i.type === 'flatbox'));
  assert.equal(room.sab.packing.has(a.id), false);
});

test('a flat box is not truck cargo: carrying one onto the ramp does not start loading', () => {
  const { room, P } = sabRoom();
  const a = P(0); takeFlatBox(room, a);
  a.x = 11.2; a.z = 0; room.tick(DT); room.tick(DT);
  assert.equal(a.loadMode, false);
});
