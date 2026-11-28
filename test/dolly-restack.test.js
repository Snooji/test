// Dollies in every mode: stack a third box while pushing; put a carried box (or piece) onto a parked dolly that has room;
// hold next to a parked, loaded dolly to take its top box (or its piece) off to restack.
import test from 'node:test';
import assert from 'node:assert/strict';
import { MoveRoom } from '../server/MoveRoom.js';

const DT = 0.05;
function setup() {
  const room = new MoveRoom();
  room.onMessage = () => {}; room.setSimulationInterval = () => {}; room.clients = []; room.broadcast = () => {};
  room.onCreate({ level: 'classic', dolly: true });
  for (const id of ['A', 'B']) { room.clients.push({ sessionId: id, send: () => {} }); room.onJoin({ sessionId: id }, {}, { name: id, email: id + '@x.io' }); }
  room.startRound();
  while (room.phase !== 'playing') room.tick(DT);
  return { room, a: room.players.get('A'), b: room.players.get('B'), d: room.items.get('dolly'), fd: room.items.get('flatdolly') };
}
const tap = (room, p) => { p.pending.tapN = 1; room.tick(DT); };
const boxes = (room) => [...room.items.values()].filter(i => ['standard', 'heavy', 'fragile'].includes(i.type) && i.state === 'floor');
/** park a dolly out in the open yard, with a mover beside it */
function parkInYard(room, dl, p, x = 3, z = 7) { dl.x = x; dl.z = z; dl.state = 'floor'; dl.pusher = null; p.x = x - 0.6; p.z = z; room.syncDollyStack?.(dl); }

test('pushing the two-wheel dolly, a third box goes on like the first two', () => {
  const { room, a, d } = setup();
  a.x = d.x; a.z = d.z; tap(room, a);
  assert.equal(a.dolly, 'dolly');
  for (let k = 0; k < 3; k++) {
    const b = boxes(room).find(x => x.type !== 'heavy') || boxes(room)[0];
    b.x = a.x + 0.5; b.z = a.z; tap(room, a);
  }
  assert.equal(d.stack.length, 3);
});

test('pushing the two-wheel dolly, a box just in front of the dolly (out of arm\'s reach of you) still goes on', () => {
  const { room, a, d } = setup();
  a.x = 3; a.z = 7; d.x = 3; d.z = 7; tap(room, a);
  assert.equal(a.dolly, 'dolly');
  a.face = Math.PI / 2; room.tick(DT); // facing +x: the dolly sits in front
  const b = boxes(room)[0]; b.x = d.x + 1.2; b.z = d.z;
  assert.ok(Math.hypot(b.x - a.x, b.z - a.z) > 1.7, `setup: ${Math.hypot(b.x - a.x, b.z - a.z).toFixed(2)} m from the mover`);
  tap(room, a);
  assert.deepEqual(d.stack, [b.id]);
});

test('carrying a box, tap by a parked two-wheel dolly with room: the box goes on top', () => {
  const { room, a, d } = setup();
  parkInYard(room, d, a);
  const b = boxes(room)[0]; b.x = a.x; b.z = a.z; tap(room, a);
  assert.equal(a.carry, b.id);
  tap(room, a);
  assert.equal(a.carry, null);
  assert.equal(b.state, 'dolly'); assert.deepEqual(d.stack, [b.id]);
});

test('a full two-wheel dolly takes no more: the box is set down on the floor instead', () => {
  const { room, a, d } = setup();
  parkInYard(room, d, a);
  const bs = boxes(room).slice(0, 4);
  for (const b of bs.slice(0, 3)) { b.state = 'dolly'; b.dollyId = d.id; d.stack.push(b.id); }
  const extra = bs[3]; extra.x = a.x; extra.z = a.z; tap(room, a);
  assert.equal(a.carry, extra.id);
  tap(room, a);
  assert.equal(d.stack.length, 3); assert.equal(extra.state, 'floor');
});

test('carrying a box, tap by the parked furniture dolly: it goes on its deck (up to 4)', () => {
  const { room, a, fd } = setup();
  parkInYard(room, fd, a);
  const b = boxes(room)[0]; b.x = a.x; b.z = a.z; tap(room, a); tap(room, a);
  assert.equal(b.state, 'flat'); assert.deepEqual(fd.stack, [b.id]);
});

test('carrying a piece of furniture alone, tap by the empty furniture dolly: the piece rides it', () => {
  const { room, a, fd } = setup();
  parkInYard(room, fd, a);
  const lamp = [...room.items.values()].find(i => i.type === 'lamp' && i.state === 'floor');
  lamp.wrapped = true; lamp.x = a.x; lamp.z = a.z; tap(room, a);
  assert.equal(a.carry, lamp.id);
  tap(room, a);
  assert.equal(fd.piece, lamp.id); assert.equal(lamp.state, 'flat'); assert.equal(a.carry, null);
});

test('hold by a parked, loaded dolly: the top box comes off into your hands (restack); tap still pushes it', () => {
  const { room, a, d } = setup();
  parkInYard(room, d, a);
  const [b1, b2] = boxes(room);
  for (const b of [b1, b2]) { b.state = 'dolly'; b.dollyId = d.id; d.stack.push(b.id); }
  a.in.hold = true; for (let i = 0; i < 12; i++) room.tick(DT); a.in.hold = false; room.tick(DT);
  assert.equal(a.carry, b2.id, 'the top box');
  assert.deepEqual(d.stack, [b1.id]);
  assert.equal(b2.state, 'carried');
  tap(room, a); // put it back on
  assert.deepEqual(d.stack, [b1.id, b2.id]);
  tap(room, a); // empty-handed tap by the dolly: push it
  assert.equal(a.dolly, 'dolly');
});

test('hold by the parked furniture dolly with a piece on it: you take the piece off', () => {
  const { room, a, fd } = setup();
  parkInYard(room, fd, a);
  const lamp = [...room.items.values()].find(i => i.type === 'lamp' && i.state === 'floor');
  Object.assign(lamp, { state: 'flat', flatId: fd.id, wrapped: true }); fd.piece = lamp.id;
  a.in.hold = true; for (let i = 0; i < 12; i++) room.tick(DT); a.in.hold = false; room.tick(DT);
  assert.equal(a.carry, lamp.id); assert.equal(fd.piece, null); assert.equal(lamp.state, 'carried');
});
