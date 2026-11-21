import test from 'node:test';
import assert from 'node:assert/strict';
import { MoveRoom } from '../server/MoveRoom.js';

function makeRoom() {
  const room = new MoveRoom();
  const handlers = {};
  const events = [];
  room.onMessage = (type, fn) => { handlers[type] = fn; };
  room.setSimulationInterval = () => {};
  room.broadcast = (type, msg) => { if (type === 'evt') events.push(msg); };
  room.clients = [];
  room.onCreate();
  const join = (id, name) => {
    room.clients.push({ sessionId: id, send: (t, m) => events.push({ ...m, to: id }) });
    room.onJoin({ sessionId: id }, {}, { name, email: name + '@x.io' });
    return room.players.get(id);
  };
  const send = (id, type, msg) => handlers[type]({ sessionId: id }, msg);
  return { room, join, send, events };
}

// carry an item straight into load mode at a chosen cell and drop it
function load(room, p, itemId, gx, gz) {
  const it = room.items.get(itemId);
  it.state = 'carried'; it.carriers = [p.id]; p.carry = it.id;
  p.loadMode = true; p.cursor = { gx, gz, rot: 0 };
  room.dropIntoTruck(p, it);
  return it;
}
const firstOf = (room, type) => [...room.items.values()].find(i => i.type === type && i.state === 'floor').id;

test('loading scores, heavy-on-fragile breaks, correct callout strikes culprit', () => {
  const { room, join, send, events } = makeRoom();
  const a = join('A', 'Ada'), b = join('B', 'Bo');
  send('A', 'start');
  assert.equal(room.phase, 'playing');

  const f = load(room, a, firstOf(room, 'fragile'), 0, 0);
  assert.equal(f.state, 'loaded');
  assert.equal(a.score, 15);

  load(room, b, firstOf(room, 'heavy'), 0, 0);
  assert.equal(f.state, 'broken');
  assert.equal(a.score, 0, 'fragile loader loses its points');
  assert.equal(b.score, 20);
  assert.ok(events.some(e => e.kind === 'crunch'));

  send('A', 'callout');
  assert.equal(room.phase, 'meeting');
  send('A', 'vote', { target: 'B' });
  send('B', 'vote', { target: 'A' }); // tie → caller's vote (B) wins
  room.tick(0.05);
  assert.equal(room.phase, 'playing');
  assert.equal(b.strikes, 1);
  assert.equal(b.score, 5);
  assert.equal(room.breaks[0].resolved, true);
});

test('wrong accusation penalizes caller; two strikes = off the truck', () => {
  const { room, join, send } = makeRoom();
  const a = join('A', 'Ada'), b = join('B', 'Bo'), c = join('C', 'Cy');
  send('A', 'start');
  load(room, a, firstOf(room, 'fragile'), 1, 1);
  load(room, b, firstOf(room, 'heavy'), 1, 1); // B is culprit
  for (let i = 0; i < 2; i++) {
    send('C', 'callout');
    for (const id of ['A', 'B', 'C']) send(id, 'vote', { target: 'A' }); // A is innocent
    room.tick(0.05);
  }
  assert.equal(c.strikes, 2);
  assert.equal(c.out, true);
  assert.equal(c.score, -30);
  // eliminated movers cannot call meetings
  send('C', 'callout');
  assert.equal(room.phase, 'playing');
});

test('unwrapped lamp shatters; unwrapped couch is scuffed for half', () => {
  const { room, join, send } = makeRoom();
  const a = join('A', 'Ada');
  send('A', 'start');
  const lamp = load(room, a, firstOf(room, 'lamp'), 3, 3);
  assert.equal(lamp.state, 'broken');
  assert.equal(a.score, 0);
  load(room, a, firstOf(room, 'couch'), 0, 0);
  assert.equal(a.score, 30);
});

test('full column refuses drop and keeps item carried', () => {
  const { room, join, send } = makeRoom();
  const a = join('A', 'Ada');
  send('A', 'start');
  const stds = [...room.items.values()].filter(i => i.type === 'standard');
  for (let i = 0; i < 4; i++) load(room, a, stds[i].id, 2, 2);
  const it = load(room, a, stds[4].id, 2, 2);
  assert.equal(it.state, 'carried');
  assert.equal(a.carry, it.id);
});

test('disconnect mid-carry drops item to floor', () => {
  const { room, join, send } = makeRoom();
  const a = join('A', 'Ada'); join('B', 'Bo');
  send('A', 'start');
  const it = room.items.get(firstOf(room, 'standard'));
  it.state = 'carried'; it.carriers = ['A']; a.carry = it.id;
  room.onLeave({ sessionId: 'A' });
  assert.equal(it.state, 'floor');
  assert.equal(it.carriers.length, 0);
});

test('late joiner during a round spectates', () => {
  const { room, join, send } = makeRoom();
  join('A', 'Ada');
  send('A', 'start');
  const late = join('L', 'Late');
  assert.equal(late.spectator, true);
});

test('round ends on timeout with winner among non-eliminated', () => {
  const { room, join, send } = makeRoom();
  const a = join('A', 'Ada'); join('B', 'Bo');
  send('A', 'start');
  load(room, a, firstOf(room, 'standard'), 0, 0);
  room.timeLeft = 0.01;
  room.tick(0.05);
  assert.equal(room.phase, 'results');
  assert.equal(room.results.winnerId, 'A');
});

test('releasing a team carry next to a wall never leaves a carrier stuck inside it', async () => {
  const { hitsWall } = await import('../shared/world.js');
  const { room, join, send } = makeRoom();
  const a = join('A', 'Ada'), b = join('B', 'Bo');
  send('A', 'start');
  const couch = [...room.items.values()].find(i => i.type === 'couch');
  couch.state = 'carried'; couch.carriers = ['A', 'B']; a.carry = b.carry = couch.id;
  couch.x = -1.3; couch.z = -9; // right next to the house's outer wall at x=0
  a.x = couch.x - 0.95; a.z = couch.z; b.x = couch.x + 0.95; b.z = couch.z; // B is inside the wall
  assert.ok(hitsWall(b.x, b.z, 0.45), 'precondition: B overlaps the wall');
  room.releaseCarry(a);
  for (const p of [a, b]) assert.equal(hitsWall(p.x, p.z, 0.45), false, `${p.name} stuck in wall at ${p.x},${p.z}`);
});
