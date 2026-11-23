import test from 'node:test';
import assert from 'node:assert/strict';
import { MoveRoom } from '../server/MoveRoom.js';

const DT = 0.05;
function setup() {
  const room = new MoveRoom();
  room.onMessage = () => {}; room.setSimulationInterval = () => {}; room.clients = [];
  const events = []; room.broadcast = (t, m) => { if (t === 'evt') events.push(m); };
  room.onCreate({ level: 'classic', dolly: true });
  for (const id of ['A', 'B']) { room.clients.push({ sessionId: id, send: (t, m) => events.push({ to: id, ...m }) }); room.onJoin({ sessionId: id }, {}, { name: id === 'A' ? 'Ada' : 'Bo', email: id + '@x.io' }); }
  room.startRound();
  while (room.phase !== 'playing') room.tick(DT);
  return { room, a: room.players.get('A'), events, fd: room.items.get('flatdolly') };
}
const tap = (room, p) => { p.pending.tapN = 1; room.tick(DT); };

test('furniture dolly: one per house, a tool (not something to load)', () => {
  const { room, fd } = setup();
  assert.ok(fd && fd.state === 'floor');
  assert.ok(!room.snapshot().items.some(i => i.type === 'flatdolly' && i.state === 'loaded'));
});

test('furniture dolly: carry a two-mover piece alone, place it yourself, full points; then it respawns 5 s later', () => {
  const { room, a, fd, events } = setup();
  const couch = [...room.items.values()].find(i => i.type === 'couch' && i.state === 'floor');
  a.x = fd.x; a.z = fd.z; tap(room, a);
  assert.equal(a.flatDolly, 'flatdolly');
  a.x = couch.x + 0.5; a.z = couch.z; tap(room, a);
  assert.equal(couch.state, 'flat', 'couch rides the dolly');
  assert.equal(fd.piece, couch.id);
  // push to the truck
  a.x = 10.2; a.z = 0; room.tick(DT);
  assert.ok(a.loadMode && a.carry === couch.id, 'placing it in the truck');
  assert.deepEqual(couch.carriers, ['A']);
  const before = a.score;
  for (let i = 0; i < 10; i++) room.tick(DT);
  a.cursor = { gx: 0, gz: 0, rot: 0 }; a.pending.tapN = 1; room.tick(DT);
  assert.equal(couch.state, 'loaded');
  assert.ok(a.score > before, 'all the points are yours');
  assert.equal(fd.state, 'gone', 'single use');
  assert.equal(a.flatDolly, null);
  for (let t = 0; t < 4.5; t += DT) room.tick(DT);
  assert.equal(fd.state, 'gone', 'still resetting');
  for (let t = 0; t < 1; t += DT) room.tick(DT);
  assert.equal(fd.state, 'floor', 'back after ~5 s');
  assert.ok(events.some(e => e.kind === 'toast' && /furniture dolly is waiting/i.test(e.text)));
});

test('furniture dolly: desks and tables must be taken apart first; boxes do not go on it', () => {
  const { room, a, fd } = setup();
  const desk = [...room.items.values()].find(i => i.type === 'desk' && i.state === 'floor');
  desk.assembled = true;
  a.x = fd.x; a.z = fd.z; tap(room, a);
  a.x = desk.x + 0.5; a.z = desk.z; tap(room, a);
  assert.equal(desk.state, 'floor', 'refused while assembled');
  assert.equal(fd.piece, null);
  desk.assembled = false; tap(room, a);
  assert.equal(desk.state, 'flat');
});

test('furniture dolly: BACK in the truck puts the piece back on the dolly', () => {
  const { room, a, fd } = setup();
  const bed = [...room.items.values()].find(i => i.type === 'bed' && i.state === 'floor');
  a.x = fd.x; a.z = fd.z; tap(room, a);
  a.x = bed.x + 0.5; a.z = bed.z; tap(room, a);
  a.x = 10.2; a.z = 0; room.tick(DT);
  assert.ok(a.loadMode);
  a.pending.dashN = 1; room.tick(DT);
  assert.equal(bed.state, 'flat'); assert.equal(fd.piece, bed.id); assert.equal(a.flatDolly, 'flatdolly'); assert.ok(!a.carry);
});
