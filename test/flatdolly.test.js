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

test('furniture dolly with boxes: up to four (2x2), never mixed with furniture; a full load wobbles at speed and spills; falls break fragile at once, standard on the 2nd, heavy on the 3rd', async () => {
  const { MoveRoom } = await import('../server/MoveRoom.js');
  const room = new MoveRoom(); room.onMessage = () => {}; room.setSimulationInterval = () => {}; room.broadcast = () => {}; room.clients = [];
  room.onCreate({ dolly: true, seed: 4242 });
  room.clients.push({ sessionId: 'A', send: () => {} }); room.onJoin({ sessionId: 'A' }, {}, { name: 'Ada', email: 'a@x.io' });
  room.startRound(); room.phase = 'playing';
  const p = room.players.get('A'), fd = room.items.get('flatdolly');
  const boxes = [...room.items.values()].filter(i => ['standard', 'heavy', 'fragile'].includes(i.type) && i.state === 'floor').slice(0, 5);
  p.flatDolly = fd.id; fd.state = 'pushed'; fd.pusher = p.id;
  for (const b of boxes) { b.x = p.x + 0.3; b.z = p.z; room.flatTap(p); }
  assert.equal(fd.stack.length, 4, 'four boxes, no more');
  assert.ok(fd.stack.every(id => room.items.get(id).state === 'flat'));
  const couch = [...room.items.values()].find(i => i.type === 'couch'); couch.x = p.x + 0.3; couch.z = p.z;
  room.flatTap(p); assert.equal(fd.piece, null, 'no furniture on top of boxes');
  // gentle pushing: no spill
  p.in.mx = 0.4; p.in.mz = 0;
  for (let i = 0; i < 100; i++) room.flatWobble(p, fd, 0.05, p.x - 0.08, p.z, p.face);
  assert.equal(fd.stack.length, 4, 'steady does it');
  // flat out for long enough: the top box slides off
  p.in.mx = 1; const top = room.items.get(fd.stack[3]);
  for (let i = 0; i < 100 && fd.stack.length === 4; i++) room.flatWobble(p, fd, 0.05, p.x - 0.25, p.z, p.face);
  assert.equal(fd.stack.length, 3, 'a box slid off');
  assert.ok(top.state !== 'flat', 'the top one came off');
  // fall rules by type
  const fallTimes = (type) => {
    const b = boxes.find(x => x.type === type) || boxes[0]; b.type = type; b.falls = 0;
    const before = room.breaks.length;
    for (let n = 1; n <= 5; n++) { b.state = 'flat'; fd.stack.push(b.id); room.spillFromFlat(p, fd); if (room.breaks.length > before) return n; }
    return 99;
  };
  assert.equal(fallTimes('fragile'), 1, 'fragile breaks on the first fall');
  assert.equal(fallTimes('standard'), 2, 'standard on the second');
  assert.equal(fallTimes('heavy'), 3, 'heavy on the third');
});

test('furniture dolly fits a hallway: short (1.3 m) when empty or carrying boxes', async () => {
  const { MoveRoom } = await import('../server/MoveRoom.js');
  const room = new MoveRoom(); room.onMessage = () => {}; room.setSimulationInterval = () => {}; room.broadcast = () => {}; room.clients = [];
  room.onCreate({ dolly: true, seed: 4242 });
  const fd = room.items.get('flatdolly');
  assert.ok(room.flatReach(fd) <= 1.25, `reach ${room.flatReach(fd)}`);
});
