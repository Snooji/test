import test from 'node:test';
import assert from 'node:assert/strict';
import { MoveRoom } from '../server/MoveRoom.js';

function makeRoom(opts = { level: 'classic' }) {
  const room = new MoveRoom();
  const handlers = {};
  const events = [];
  room.onMessage = (type, fn) => { handlers[type] = fn; };
  room.setSimulationInterval = () => {};
  room.broadcast = (type, msg) => { if (type === 'evt') events.push(msg); if (type === 'chat') events.push({ kind: 'chat', ...msg }); };
  room.clients = [];
  room.onCreate(opts);
  const join = (id, name) => {
    room.clients.push({ sessionId: id, send: (t, m) => events.push({ ...m, to: id }) });
    room.onJoin({ sessionId: id }, {}, { name, email: name + '@x.io' });
    return room.players.get(id);
  };
  const send = (id, type, msg) => {
    handlers[type]({ sessionId: id }, msg);
    if (type === 'start') for (let i = 0; i < 80 && room.phase === 'countdown'; i++) room.tick(0.05); // skip 3-2-1
  };
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
  assert.equal(a.score, 35);
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

test('round starts with a 3-2-1 countdown where nobody can move', () => {
  const { room, join } = makeRoom();
  const a = join('A', 'Ada');
  room.startRound();
  assert.equal(room.phase, 'countdown');
  a.in.mx = 1; const x0 = a.x;
  room.tick(0.5);
  assert.equal(a.x, x0);
  for (let i = 0; i < 60; i++) room.tick(0.05);
  assert.equal(room.phase, 'playing');
});

test('movers spawn spread out, not stacked', () => {
  const { room, join } = makeRoom();
  const ps = ['A', 'B', 'C', 'D'].map(id => join(id, id));
  for (let i = 0; i < ps.length; i++) for (let j = i + 1; j < ps.length; j++)
    assert.ok(Math.hypot(ps[i].x - ps[j].x, ps[i].z - ps[j].z) > 1.5);
});

test('solo mode fills the crew with 3 AI movers at the chosen difficulty', () => {
  const { room, join } = makeRoom({ level: 'classic', solo: true, difficulty: 'hard' });
  join('A', 'Ada');
  assert.equal(room.bots.size, 3);
  assert.equal(room.movers().length, 4);
  assert.ok([...room.bots.values()].every(b => b.difficulty === 'hard'));
  assert.equal(room.hostId, 'A');
});

test('host can change bot difficulty and add/remove bots in the lobby', () => {
  const { room, join, send } = makeRoom({ level: 'classic', solo: true });
  join('A', 'Ada');
  send('A', 'difficulty', { level: 'easy' });
  assert.ok([...room.bots.values()].every(b => b.difficulty === 'easy'));
  send('A', 'removeBot');
  assert.equal(room.bots.size, 2);
  send('A', 'addBot');
  assert.equal(room.bots.size, 3);
});

test('a friend joining a full solo lobby takes a bot seat', () => {
  const { room, join } = makeRoom({ level: 'classic', solo: true });
  join('A', 'Ada');
  const b = join('B', 'Bo');
  assert.equal(b.spectator, false);
  assert.equal(room.bots.size, 2);
});

test('host can re-roll the house in the lobby; play-again builds a fresh house', () => {
  const { room, join, send } = makeRoom({});
  join('A', 'Ada');
  const s0 = room.level.seed;
  send('A', 'reroll');
  assert.notEqual(room.level.seed, s0);
  const s1 = room.level.seed;
  send('A', 'start');
  assert.equal(room.level.seed, s1, 'the lobby house is the one you play');
  room.endRound('test');
  send('A', 'start');
  assert.notEqual(room.level.seed, s1);
});

function simulate(room, seconds) {
  for (let t = 0; t < seconds && room.phase !== 'results'; t += 0.05) room.tick(0.05);
}

test('4 hard AI movers load the classic house without breaking anything', () => {
  const { room } = makeRoom({ level: 'classic' });
  for (let i = 0; i < 4; i++) room.addBot();
  room.difficulty = 'hard'; for (const b of room.bots.values()) b.setDifficulty('hard');
  room.startRound();
  simulate(room, 180);
  const loaded = [...room.items.values()].filter(i => i.state === 'loaded').length;
  assert.ok(loaded >= 12, `hard bots loaded only ${loaded}`);
  assert.equal(room.breaks.length, 0, 'hard bots never crush');
});

test('AI movers can find and load items in randomly generated houses', () => {
  for (const seed of [11, 222, 3333, 44444]) {
    const { room } = makeRoom({ seed });
    for (let i = 0; i < 4; i++) room.addBot();
    room.startRound();
    simulate(room, 120);
    const loaded = [...room.items.values()].filter(i => i.state === 'loaded').length;
    assert.ok(loaded >= 6, `seed ${seed}: only ${loaded} loaded`);
  }
});

test('tapping to join a two-mover lift does not immediately drop it', () => {
  const { room, join, send } = makeRoom();
  const a = join('A', 'Ada'), b = join('B', 'Bo');
  send('A', 'start');
  const couch = [...room.items.values()].find(i => i.type === 'couch');
  couch.wrapped = true;
  a.x = couch.x - 1; a.z = couch.z; b.x = couch.x + 1; b.z = couch.z;
  a.pending.tapN = 1; room.tick(0.05);
  assert.deepEqual(couch.carriers, ['A']);
  b.pending.tapN = 1; room.tick(0.05);
  assert.deepEqual(couch.carriers, ['A', 'B'], 'B joined and the lift held');
  room.tick(0.05);
  assert.equal(couch.state, 'carried');
});

test('a player leaving posts a notice in chat', async () => {
  const { room, join, events } = makeRoom();
  join('A', 'Ada'); join('B', 'Bo');
  await room.onLeave({ sessionId: 'B' }, true);
  assert.ok(events.some(e => e.kind === 'chat' && e.system && /Bo left/.test(e.text)));
});

test('last human left in a multiplayer round wins by default', async () => {
  const { room, join, send } = makeRoom();
  join('A', 'Ada'); join('B', 'Bo'); join('C', 'Cy');
  send('A', 'start');
  room.players.get('B').score = 50; // even with a higher score, leaving forfeits
  await room.onLeave({ sessionId: 'B' }, true);
  assert.equal(room.phase, 'playing', 'two humans still playing');
  await room.onLeave({ sessionId: 'C' }, true);
  assert.equal(room.phase, 'results');
  assert.equal(room.results.winnerId, 'A');
  assert.match(room.results.reason, /wins by default/);
});

test('solo rounds do not auto-end when bots are the only others', async () => {
  const { room, join, send } = makeRoom({ level: 'classic', solo: true });
  join('A', 'Ada');
  send('A', 'start');
  room.tick(0.05);
  assert.equal(room.phase, 'playing');
});

test('help ping: only when holding one end of a two-mover lift alone, with a cooldown', () => {
  const { room, join, send, events } = makeRoom();
  const a = join('A', 'Ada'); join('B', 'Bo');
  send('A', 'start');
  send('A', 'help');
  assert.equal(events.filter(e => e.kind === 'help').length, 0, 'not holding anything');
  const couch = [...room.items.values()].find(i => i.type === 'couch');
  couch.state = 'carried'; couch.carriers = ['A']; a.carry = couch.id;
  send('A', 'help');
  const ping = events.find(e => e.kind === 'help');
  assert.ok(ping && ping.id === 'A' && typeof ping.x === 'number');
  send('A', 'help');
  assert.equal(events.filter(e => e.kind === 'help').length, 1, 'cooldown');
});

test('aim sets the drop column directly in load mode and is clamped to fit', () => {
  const { room, join, send } = makeRoom();
  const a = join('A', 'Ada');
  send('A', 'start');
  const couch = [...room.items.values()].find(i => i.type === 'couch');
  couch.state = 'carried'; couch.carriers = ['A']; a.carry = couch.id; a.loadMode = true; a.cursor = { gx: 0, gz: 0, rot: 0 };
  send('A', 'aim', { gx: 3, gz: 2 });
  assert.deepEqual([a.cursor.gx, a.cursor.gz], [1, 2], 'a 3-long couch clamps to gx=1');
  a.loadMode = false;
  send('A', 'aim', { gx: 0, gz: 0 });
  assert.deepEqual([a.cursor.gx, a.cursor.gz], [1, 2], 'ignored outside load mode');
});

test('nobody can join a two-mover lift that is already being placed in the truck', () => {
  const { room, join, send } = makeRoom();
  const a = join('A', 'Ada'), b = join('B', 'Bo');
  send('A', 'start');
  const couch = [...room.items.values()].find(i => i.type === 'couch');
  couch.state = 'carried'; couch.carriers = ['A']; a.carry = couch.id; a.loadMode = true;
  b.x = couch.x + 0.5; b.z = couch.z;
  room.onTap(b, null);
  assert.deepEqual(couch.carriers, ['A']);
});
