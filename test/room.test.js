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
  room.onCreate({ dolly: false, ...opts }); // most tests run without the dolly
  const join = (id, name) => {
    room.clients.push({ sessionId: id, send: (t, m) => events.push({ ...m, to: id }) });
    room.onJoin({ sessionId: id }, {}, { name, email: name + '@x.io' });
    return room.players.get(id);
  };
  const send = (id, type, msg) => {
    if (type === 'start' && !room.noAutoReady && room.phase === 'lobby') for (const p of room.players.values()) if (!p.bot && p.id !== room.hostId) p.ready = true;
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
  const a = join('A', 'Ada'), b = join('B', 'Bo'); join('C', 'Cy'); // 3 movers: meetings need someone else to accuse
  send('A', 'start');
  assert.equal(room.phase, 'playing');

  const f = load(room, a, firstOf(room, 'fragile'), 0, 0);
  assert.equal(f.state, 'loaded');
  assert.equal(a.score, 15);

  load(room, b, firstOf(room, 'heavy'), 0, 0);
  assert.equal(room.breaks.length, 1);
  assert.equal(f.state, 'floor', 'broken box respawned in the house');
  assert.equal(a.score, 0, 'fragile loader loses its points');
  assert.equal(b.score, 20);
  assert.ok(events.some(e => e.kind === 'crunch'));

  send('A', 'callout');
  assert.equal(room.phase, 'meeting');
  send('A', 'vote', { target: 'B' });
  send('B', 'vote', { target: 'A' });
  send('C', 'vote', { target: 'skip' }); // B 1, A 1, skip 1: a tie, so the caller's vote (B) wins
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
  const lamp = load(room, a, firstOf(room, 'lamp'), 2, 3);
  assert.equal(room.breaks.length, 1);
  assert.equal(lamp.state, 'floor', 'respawned');
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
  driveAway(room);
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

function driveAway(room) { for (let i = 0; i < 400 && room.phase === 'driveoff'; i++) room.tick(0.05); }

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

// ---- wave 2 ----
import { placeItem as gridPlace } from '../shared/logic.js';

test('an item crushed in the truck respawns somewhere in the house as a fresh floor item', () => {
  const { room, join, send } = makeRoom();
  const a = join('A', 'Ada'), b = join('B', 'Bo');
  send('A', 'start');
  const f = load(room, a, firstOf(room, 'fragile'), 0, 0);
  load(room, b, firstOf(room, 'heavy'), 0, 0);
  assert.equal(f.state, 'floor', 'respawned');
  const h = room.level.house;
  assert.ok(f.x > h.x0 && f.x < h.x1 && f.z > h.z0 && f.z < h.z1, `respawned inside the house (${f.x},${f.z})`);
  assert.equal(room.level.hitsWall(f.x, f.z, 0.45), false);
  assert.equal(room.breaks.length, 1, 'the break still counts for call-outs');
});

test('a shattered unwrapped lamp respawns unwrapped', () => {
  const { room, join, send } = makeRoom();
  const a = join('A', 'Ada');
  send('A', 'start');
  const l = load(room, a, firstOf(room, 'lamp'), 0, 0);
  assert.equal(l.state, 'floor');
  assert.equal(l.wrapped, false);
});

test('timed round ends as soon as nothing left in the house fits in the truck', () => {
  const { room, join, send } = makeRoom();
  join('A', 'Ada');
  send('A', 'start');
  for (let x = 0; x < 4; x++) for (let z = 0; z < 4; z++) for (let y = 0; y < 4; y++) gridPlace(room.grid, { id: `d${x}${z}${y}`, type: 'standard' }, x, z, 0);
  room.tick(0.05);
  driveAway(room);
  assert.equal(room.phase, 'results');
  assert.match(room.results.reason, /Truck full/);
});

test('Full load mode: round ends only when all 64 cells are packed', () => {
  const { room, join, send } = makeRoom({});
  join('A', 'Ada');
  send('A', 'mode', { mode: 'load' });
  assert.equal(room.level.exact, true, 'switching to Full load builds an exact-fill house');
  send('A', 'start');
  for (let x = 0; x < 4; x++) for (let z = 0; z < 4; z++) for (let y = 0; y < 3; y++) gridPlace(room.grid, { id: `d${x}${z}${y}`, type: 'standard' }, x, z, 0);
  room.tick(0.05);
  assert.equal(room.phase, 'playing', 'not finished with gaps left');
  for (let x = 0; x < 4; x++) for (let z = 0; z < 4; z++) gridPlace(room.grid, { id: `e${x}${z}`, type: 'standard' }, x, z, 0);
  room.tick(0.05);
  driveAway(room);
  assert.equal(room.phase, 'results');
  assert.match(room.results.reason, /Perfect load/);
});

test('Full load mode: hold ACTION on the ramp to unload; pulling an item takes back its points', () => {
  const { room, join, send } = makeRoom({});
  const a = join('A', 'Ada');
  send('A', 'mode', { mode: 'load' });
  send('A', 'start');
  const box = [...room.items.values()].find(i => i.type === 'standard');
  load(room, a, box.id, 2, 2);
  assert.equal(a.score, 10);
  a.x = 11.2; a.z = 0; a.in.hold = true;
  for (let i = 0; i < 20; i++) room.tick(0.05);
  assert.ok(a.loadMode && a.unloading, 'holding on the ramp enters unload mode');
  a.in.hold = false;
  send('A', 'aim', { gx: 2, gz: 2 });
  a.pending.tapN = 1; room.tick(0.05);
  assert.equal(a.carry, box.id, 'pulled the box');
  assert.equal(box.state, 'carried');
  assert.equal(a.score, 0, 'points come back off');
  assert.equal(room.grid.cells[2][2][0], null);
});

test('unloading is only allowed in Full load (no point-stealing in competitive rounds)', () => {
  const { room, join, send } = makeRoom();
  const a = join('A', 'Ada');
  send('A', 'start');
  a.x = 11.2; a.z = 0; a.in.hold = true;
  for (let i = 0; i < 20; i++) room.tick(0.05);
  assert.ok(!a.unloading);
});

test('BACK really leaves the truck (you end up off the ramp, still holding the item)', () => {
  const { room, join, send } = makeRoom();
  const a = join('A', 'Ada');
  send('A', 'start');
  const box = room.items.get(firstOf(room, 'standard'));
  box.state = 'carried'; box.carriers = ['A']; a.carry = box.id; a.x = 11.2; a.z = 0;
  room.tick(0.05);
  assert.equal(a.loadMode, true);
  a.pending.dashN = 1; room.tick(0.05);
  for (let i = 0; i < 5; i++) room.tick(0.05);
  assert.equal(a.loadMode, false);
  assert.equal(a.carry, box.id);
});

// ---- sabotage mode ----
function sabotageRoom(n = 3) {
  const r = makeRoom({});
  const ids = ['A', 'B', 'C', 'D'].slice(0, n);
  ids.forEach(id => r.join(id, id));
  r.send('A', 'game', { game: 'sabotage' });
  r.send('A', 'start');
  return { ...r, ids };
}
const sab = (room) => [...room.players.values()].find(p => p.saboteur);

test('sabotage: exactly one secret saboteur, told privately, never in the shared snapshot', () => {
  const { room, events } = sabotageRoom(4);
  assert.equal(room.game, 'sabotage');
  assert.equal(room.level.exact, true);
  assert.equal([...room.players.values()].filter(p => p.saboteur).length, 1);
  const roles = events.filter(e => e.kind === 'role');
  assert.equal(roles.length, 4, 'everyone gets a private role card');
  assert.equal(roles.filter(r => r.saboteur).length, 1);
  assert.ok(!JSON.stringify(room.snapshot()).includes('saboteur'), 'role not leaked in snapshot');
});

test('sabotage needs at least 3 movers', () => {
  const r = makeRoom({});
  r.join('A', 'A'); r.join('B', 'B');
  r.send('A', 'game', { game: 'sabotage' });
  r.send('A', 'start');
  assert.equal(r.room.phase, 'lobby');
});

test('sabotage: the saboteur jams furniture, making disassembly take longer', () => {
  const { room } = sabotageRoom(3);
  const s = sab(room);
  const desk = [...room.items.values()].find(i => i.assembled);
  if (!desk) return; // some Full load houses have no desk/table
  s.x = desk.x + 0.8; s.z = desk.z; s.in.hold = true;
  for (let i = 0; i < 60; i++) room.tick(0.05);
  assert.ok(desk.jam > 0, 'jammed');
  assert.equal(desk.assembled, true, 'saboteur made no real progress');
});

test('sabotage: voting out the saboteur wins it for the crew', () => {
  const { room, send, ids } = sabotageRoom(3);
  const s = sab(room);
  const caller = ids.find(id => id !== s.id);
  send(caller, 'callout');
  assert.equal(room.phase, 'meeting', 'anyone can call a meeting in sabotage');
  for (const id of ids) send(id, 'vote', { target: s.id });
  room.tick(0.05);
  assert.equal(room.phase, 'results');
  assert.equal(room.results.winners, 'crew');
});

test('sabotage: voting out an innocent ejects them, no strikes', () => {
  const { room, send, ids } = sabotageRoom(4);
  const s = sab(room);
  const innocent = ids.filter(id => id !== s.id);
  send(innocent[0], 'callout');
  for (const id of ids) send(id, 'vote', { target: innocent[1] });
  room.tick(0.05);
  assert.equal(room.phase, 'playing');
  assert.equal(room.players.get(innocent[1]).out, true);
  assert.equal(room.players.get(innocent[0]).strikes, 0);
});

test('sabotage: after time runs out the crew score drains; at zero the saboteur wins', () => {
  const { room } = sabotageRoom(3);
  const box = [...room.items.values()].find(i => i.type === 'heavy');
  load(room, room.players.get('A'), box.id, 0, 0);
  assert.equal(room.crewScore(), 20);
  room.timeLeft = 0.01;
  room.tick(0.05);
  assert.equal(room.phase, 'playing', 'overtime, not game over');
  assert.ok(room.overtime);
  for (let i = 0; i < 40 && room.phase === 'playing'; i++) room.tick(0.5);
  assert.equal(room.phase, 'results');
  assert.equal(room.results.winners, 'saboteur');
});

// ---- deploy B ----
import { SUITS, dailySeed } from '../shared/logic.js';

test('training: tiny house, a Coach AI, and steps that advance as you play', () => {
  const { room, join, send, events } = makeRoom({ tutorial: true });
  const a = join('A', 'Ada');
  assert.equal(room.level.tutorial, true);
  assert.equal(room.bots.size, 1);
  assert.equal([...room.bots.values()][0].coach, true);
  send('A', 'start');
  const stepOf = () => room.tutorial.step;
  assert.equal(stepOf(), 0);
  const std = [...room.items.values()].find(i => i.type === 'standard');
  std.state = 'carried'; std.carriers = ['A']; a.carry = std.id;
  room.tick(0.05);
  assert.equal(stepOf(), 1, 'picked up → carry to the truck');
  a.x = 11.2; a.z = 0; room.tick(0.05);
  assert.equal(stepOf(), 2, 'in the load zone → drop it');
  a.pending.tapN = 1; room.tick(0.05);
  assert.equal(stepOf(), 3);
  assert.ok(events.some(e => e.kind === 'tutorial'), 'client is told about each step');
});

test('quick play: public lobby with AI fillers that auto-starts', () => {
  const { room, join } = makeRoom({ level: 'classic', quick: true });
  join('A', 'Ada');
  assert.equal(room.bots.size, 3);
  assert.ok(room.autoStartAt > 0);
  for (let i = 0; i < 31 * 20 && room.phase === 'lobby'; i++) room.tick(0.05);
  assert.equal(room.phase, 'countdown');
});

test('movers aiming in the truck get their own spots on the ramp', () => {
  const { room, join, send } = makeRoom();
  const a = join('A', 'Ada'), b = join('B', 'Bo');
  send('A', 'start');
  const [i1, i2] = [...room.items.values()].filter(i => i.type === 'standard');
  for (const [p, it] of [[a, i1], [b, i2]]) { it.state = 'carried'; it.carriers = [p.id]; p.carry = it.id; p.x = 11.2; p.z = 0; }
  room.tick(0.05);
  assert.ok(a.loadMode && b.loadMode);
  for (let i = 0; i < 12; i++) room.tick(0.05); // they walk to their spots (no teleport)
  assert.ok(a.loadMode && b.loadMode);
  assert.ok(Math.hypot(a.x - b.x, a.z - b.z) > 0.9, 'not stacked on the ramp');
});

test('results carry MVP awards', () => {
  const { room, join, send } = makeRoom();
  const a = join('A', 'Ada'); join('B', 'Bo');
  send('A', 'start');
  load(room, a, firstOf(room, 'standard'), 0, 0);
  room.endRound('test');
  driveAway(room);
  assert.ok(Array.isArray(room.results.awards));
  assert.ok(room.results.awards.some(w => w.id === 'A' && /loaded/i.test(w.title)));
});

test('daily house: same seed for everyone that day', () => {
  assert.equal(dailySeed('2026-11-22'), dailySeed('2026-11-22'));
  assert.notEqual(dailySeed('2026-11-22'), dailySeed('2026-11-23'));
  const { room, join } = makeRoom({ daily: '2026-11-22' });
  join('A', 'Ada');
  assert.equal(room.level.seed, dailySeed('2026-11-22'));
  assert.equal(room.level.daily, '2026-11-22');
  assert.equal(room.bots.size, 3, 'daily is a solo run vs AI');
});

test('Moon Mansion twist builds a big 6-room house', () => {
  const { room, join, send } = makeRoom({});
  join('A', 'Ada');
  send('A', 'twist', { twist: 'mansion' });
  const h = room.level.house;
  assert.ok(h.x1 - h.x0 >= 24.5 && room.level.rooms.length >= 5, `${h.x1 - h.x0} wide, ${room.level.rooms.length} rooms`);
});

test('Zero-G twist: gravity cuts out on a cycle and floor items drift', () => {
  const { room, join, send } = makeRoom({});
  join('A', 'Ada');
  send('A', 'twist', { twist: 'zerog' });
  send('A', 'start');
  const it = [...room.items.values()].find(i => i.state === 'floor');
  const x0 = it.x, z0 = it.z;
  let sawZeroG = false;
  for (let i = 0; i < 40 * 20; i++) { room.tick(0.05); if (room.zeroG) sawZeroG = true; }
  assert.ok(sawZeroG);
  assert.ok(Math.hypot(it.x - x0, it.z - z0) > 0.05, 'floor items drift in zero-G');
  assert.equal(room.level.hitsWall(it.x, it.z, 0.4), false, 'never drift into walls');
});

test('suit colors: locked until earned', () => {
  const { room, join, send } = makeRoom();
  const a = join('A', 'Ada');
  a.profile = { games: 0, wins: 0 };
  send('A', 'suit', { id: 'gold' });
  assert.equal(a.suit, 'classic');
  a.profile = { games: 5, wins: 0 };
  send('A', 'suit', { id: 'gold' });
  assert.equal(a.suit, 'gold');
  assert.ok(SUITS.find(s => s.id === 'neon').wins > 0);
});

test('drive-off: a badly loaded truck loses points for what slid and what it smashed', () => {
  const { room, join, send } = makeRoom();
  const a = join('A', 'Ada'), b = join('B', 'Bo');
  send('A', 'start');
  load(room, b, firstOf(room, 'fragile'), 1, 0);                 // Bo's fragile box in the gap
  load(room, b, firstOf(room, 'standard'), 0, 0);
  load(room, b, firstOf(room, 'standard'), 0, 0);
  const couch = room.items.get(firstOf(room, 'couch')); couch.wrapped = true;
  load(room, a, couch.id, 0, 0);                                  // Ada's couch balanced on one stack
  const aBefore = a.score, bBefore = b.score;
  room.timeLeft = 0.01; room.tick(0.05);
  assert.equal(room.phase, 'driveoff', 'the truck drives off first');
  assert.ok(room.driveoff.damaged.length >= 2);
  for (let i = 0; i < 200 && room.phase === 'driveoff'; i++) room.tick(0.05);
  assert.equal(room.phase, 'results');
  assert.ok(room.results.driveoff.safety < 100);
  assert.ok(a.score < aBefore - 60, 'Ada pays for her couch and the box it smashed');
  assert.equal(b.score, bBefore, 'Bo loaded well and keeps his points');
});

test('drive-off: a neat load drives away clean', () => {
  const { room, join, send } = makeRoom();
  const a = join('A', 'Ada');
  send('A', 'start');
  load(room, a, firstOf(room, 'heavy'), 0, 0);
  const before = a.score;
  room.timeLeft = 0.01; room.tick(0.05);
  for (let i = 0; i < 200 && room.phase === 'driveoff'; i++) room.tick(0.05);
  assert.equal(room.results.driveoff.safety, 100);
  assert.equal(a.score, before);
});

test('quick play returns to the lobby on its own after results', () => {
  const { room, join } = makeRoom({ level: 'classic', quick: true });
  join('A', 'Ada');
  room.startRound();
  room.endRound('test');
  for (let i = 0; i < 40 * 20 && room.phase !== 'lobby'; i++) room.tick(0.05);
  assert.equal(room.phase, 'lobby');
});

test('restart vote: the next round starts only when every human has confirmed', () => {
  const { room, join, send } = makeRoom({});
  join('A', 'Ada'); join('B', 'Bo'); room.addBot?.();
  send('A', 'start');
  room.endRound('test'); driveAway(room);
  assert.equal(room.phase, 'results');
  const seed = room.level.seed;
  send('A', 'ready');
  assert.equal(room.players.get('A').ready, true);
  assert.equal(room.phase, 'results', 'still waiting for Bo');
  assert.ok(room.snapshot().players.find(p => p.id === 'A').ready, 'ready shows on the character');
  send('B', 'ready');
  assert.equal(room.phase, 'countdown');
  assert.notEqual(room.level.seed, seed, 'fresh house');
  assert.equal(room.players.get('A').ready, false, 'ready resets for the new round');
});

import { levelFromSnapshot } from '../shared/level.js';
test('browsers rebuild exactly the server house from the snapshot (every kind of house)', () => {
  for (const opts of [{}, { tutorial: true }, { level: 'classic' }, { daily: '2026-11-22' }]) {
    const { room, join, send } = makeRoom(opts);
    join('A', 'Ada');
    const variants = [() => {}];
    if (!opts.tutorial && !opts.level && !opts.daily) variants.push(() => send('A', 'mode', { mode: 'load' }), () => send('A', 'twist', { twist: 'mansion' }), () => send('A', 'game', { game: 'sabotage' }));
    for (const v of variants) {
      v();
      const rebuilt = levelFromSnapshot(room.snapshot().level);
      assert.deepEqual(rebuilt.houseWalls, room.level.houseWalls, `walls differ for ${JSON.stringify(opts)} ${room.mode}/${room.twist}/${room.game}`);
      assert.deepEqual(rebuilt.items, room.level.items);
    }
  }
});

test('training: every step names a target to point at (item or the truck) and uses short text', () => {
  const { room, join, send } = makeRoom({ tutorial: true });
  const a = join('A', 'Ada');
  send('A', 'start');
  let snap = room.snapshot();
  assert.ok(snap.tutorial.target && snap.tutorial.target !== 'ramp', 'step 1 points at the box');
  assert.ok(snap.tutorial.text.length <= 60, `short: "${snap.tutorial.text}"`);
  const std = [...room.items.values()].find(i => i.type === 'standard');
  std.state = 'carried'; std.carriers = ['A']; a.carry = std.id;
  room.tick(0.05);
  snap = room.snapshot();
  assert.equal(snap.tutorial.target, 'ramp', 'carrying → point at the truck');
});

// ---- the dolly ----
function dollyRoom() {
  const r = makeRoom({ dolly: true, level: 'classic' });
  const a = r.join('A', 'Ada'); r.join('B', 'Bo');
  r.send('A', 'start');
  const dolly = [...r.room.items.values()].find(i => i.type === 'dolly');
  return { ...r, a, dolly };
}
const grabAt = (room, p, it) => { p.x = it.x + 0.05; p.z = it.z + 0.05; p.pending.tapN = 1; room.tick(0.05); };

test('dolly: spawns in the house, grab it, then stack up to 3 boxes (no furniture)', () => {
  const { room, a, dolly } = dollyRoom();
  assert.ok(dolly, 'a dolly is somewhere in the house');
  assert.equal(room.level.roomAt(dolly.x, dolly.z) !== 'Yard', true);
  grabAt(room, a, dolly);
  assert.equal(a.dolly, dolly.id);
  const boxes = [...room.items.values()].filter(i => i.type === 'standard').slice(0, 4);
  for (const b of boxes) grabAt(room, a, b);
  assert.equal(dolly.stack.length, 3, 'max three');
  assert.equal(boxes[3].state, 'floor');
  grabAt(room, a, [...room.items.values()].find(i => i.type === 'lamp'));
  assert.equal(dolly.stack.length, 3, 'lamps do not go on dollies');
});

test('dolly: at the truck the boxes come off top first, one at a time', () => {
  const { room, a, dolly } = dollyRoom();
  grabAt(room, a, dolly);
  const [b1, b2] = [...room.items.values()].filter(i => i.type === 'standard');
  grabAt(room, a, b1); grabAt(room, a, b2);           // b2 is on top
  a.x = 11.2; a.z = 0; room.tick(0.05);
  assert.ok(a.loadMode);
  assert.equal(a.carry, b2.id, 'top box first');
  a.cursor = { gx: 0, gz: 0, rot: 0 }; a.pending.tapN = 1; room.tick(0.05);
  assert.equal(b2.state, 'loaded');
  assert.ok(a.loadMode, 'stays in the truck for the next box');
  assert.equal(a.carry, b1.id);
  a.cursor = { gx: 1, gz: 0, rot: 0 }; a.pending.tapN = 1; room.tick(0.05);
  assert.equal(b1.state, 'loaded');
  assert.equal(a.loadMode, false);
  assert.equal(dolly.uses, 1);
});

test('dolly: breaks after two trips and turns up somewhere else', () => {
  const { room, a, dolly } = dollyRoom();
  const boxes = [...room.items.values()].filter(i => i.type === 'standard');
  let spot = null;
  for (let trip = 0; trip < 2; trip++) {
    grabAt(room, a, dolly);
    grabAt(room, a, boxes[trip]);
    a.x = 11.2; a.z = 0; room.tick(0.05);
    a.cursor = { gx: trip, gz: 0, rot: 0 }; a.pending.tapN = 1; room.tick(0.05);
    spot = [dolly.x, dolly.z];
    if (trip === 0) { a.x = 8; a.pending.tapN = 1; room.tick(0.05); } // set it down after the first trip
  }
  assert.equal(a.dolly, null, 'broken dolly leaves your hands');
  assert.equal(dolly.uses, 0, 'a fresh dolly');
  assert.equal(dolly.state, 'floor');
  assert.ok(room.level.roomAt(dolly.x, dolly.z) !== 'Yard', 'back in the house');
});

test('dolly: a heavy box riding on a fragile one too long breaks it, costs points, and it respawns', () => {
  const { room, a, dolly } = dollyRoom();
  grabAt(room, a, dolly);
  const f = [...room.items.values()].find(i => i.type === 'fragile');
  const h = [...room.items.values()].find(i => i.type === 'heavy');
  grabAt(room, a, f); grabAt(room, a, h);
  a.score = 50;
  for (let i = 0; i < 20 * 3; i++) room.tick(0.05);
  assert.ok(dolly.strain > 0, 'warning is showing');
  assert.equal(f.state, 'dolly', 'not broken yet');
  for (let i = 0; i < 20 * 4; i++) room.tick(0.05);
  assert.equal(f.state, 'floor', 'broke and respawned');
  assert.equal(a.score, 50 - 15);
  assert.deepEqual(dolly.stack, [h.id]);
  assert.ok(room.breaks.some(b => b.culpritIds.includes('A')));
});

test('dolly: AI movers never grab it', () => {
  const r = makeRoom({ dolly: true, level: 'classic' });
  for (let i = 0; i < 4; i++) r.room.addBot();
  r.room.startRound();
  for (let i = 0; i < 20 * 60; i++) r.room.tick(0.05);
  assert.ok(![...r.room.players.values()].some(p => p.dolly));
});

// ---- round 5 ----
test('any mode: you can pull a placed piece back out; points come back off, so no farming', () => {
  const { room, join, send } = makeRoom();
  const a = join('A', 'Ada'); join('B', 'Bo');
  send('A', 'start');
  const box = room.items.get(firstOf(room, 'standard'));
  load(room, a, box.id, 2, 2);
  assert.equal(a.score, 10);
  a.x = 11.2; a.z = 0; a.in.hold = true;
  for (let i = 0; i < 20; i++) room.tick(0.05);
  assert.ok(a.unloading, 'unloading works in a 3-minute round too');
  a.in.hold = false;
  send('A', 'aim', { gx: 2, gz: 2 });
  a.pending.tapN = 1; room.tick(0.05);
  assert.equal(a.carry, box.id);
  assert.equal(a.score, 0, 'points come back off');
  a.cursor = { gx: 0, gz: 0, rot: 0 }; a.pending.tapN = 1; room.tick(0.05);
  assert.equal(box.state, 'loaded');
  assert.equal(a.score, 10, 'reloading gives them back once: shuffling can never farm points');
});

test('a piece pulled out and left outside the truck loses value, then rots and respawns', () => {
  const { room, join, send } = makeRoom();
  const a = join('A', 'Ada'); join('B', 'Bo');
  send('A', 'start');
  const box = room.items.get(firstOf(room, 'heavy'));
  load(room, a, box.id, 1, 1);
  a.loadMode = true; a.unloading = true; a.cursor = { gx: 1, gz: 1, rot: 0 };
  a.pending.tapN = 1; room.tick(0.05);
  assert.equal(a.carry, box.id);
  a.pending.dashN = 1; room.tick(0.05);          // back out holding it
  a.pending.tapN = 1; room.tick(0.05);           // set it down outside
  assert.equal(box.state, 'floor');
  assert.ok(box.pulled, 'marked as pulled out');
  for (let i = 0; i < 20 * 10; i++) room.tick(0.05);
  assert.ok(box.value < 1 && box.value > 0, `losing value: ${box.value}`);
  load(room, a, box.id, 0, 0);
  assert.ok(a.score > 0 && a.score < 20, `reloaded at reduced value: ${a.score}`);
  // pull again and let it rot completely
  a.loadMode = true; a.unloading = true; a.cursor = { gx: 0, gz: 0, rot: 0 };
  a.pending.tapN = 1; room.tick(0.05);
  a.pending.dashN = 1; room.tick(0.05); a.pending.tapN = 1; room.tick(0.05);
  for (let i = 0; i < 20 * 60 && !box.rotted; i++) room.tick(0.05);
  assert.ok(box.rottedOnce, 'it rotted');
  assert.equal(box.state, 'floor');
  assert.equal(box.value, 1, 'a fresh one respawned at full value');
  assert.ok(!box.pulled);
});

test('1v1: no call-out meetings', () => {
  const { room, join, send } = makeRoom();
  join('A', 'Ada'); join('B', 'Bo');
  send('A', 'start');
  room.breaks.push({ id: 'x', type: 'fragile', culpritIds: ['B'], resolved: false });
  send('A', 'callout');
  assert.equal(room.phase, 'playing');
  assert.equal(room.snapshot().canCallOut, false);
});

test('lobby ready-up: the crew chief cannot start until everyone else is ready', () => {
  const { room, join, send } = makeRoom({});
  room.noAutoReady = true;
  join('A', 'Ada'); join('B', 'Bo'); join('C', 'Cy');
  send('A', 'start');
  assert.equal(room.phase, 'lobby', 'blocked: nobody else is ready');
  send('B', 'ready');
  send('A', 'start');
  assert.equal(room.phase, 'lobby', 'still waiting for Cy');
  assert.ok(room.snapshot().players.find(p => p.id === 'B').ready);
  send('C', 'ready');
  send('A', 'start');
  assert.notEqual(room.phase, 'lobby');
});

test('claim window: a piece pulled out and put straight back still pays its original placer', () => {
  const { room, join, send } = makeRoom();
  const a = join('A', 'Ada'), b = join('B', 'Bo'); join('C', 'Cy');
  send('A', 'start');
  const box = room.items.get(firstOf(room, 'standard'));
  load(room, a, box.id, 2, 2);
  assert.equal(a.score, 10);
  b.loadMode = true; b.unloading = true; b.cursor = { gx: 2, gz: 2, rot: 0 };
  b.pending.tapN = 1; room.tick(0.05);                // Bo pulls Ada's box
  assert.equal(b.carry, box.id);
  assert.equal(a.score, 0, 'Ada loses the points while it is out');
  b.cursor = { gx: 0, gz: 0, rot: 0 }; b.pending.tapN = 1; room.tick(0.05); // straight back in
  assert.equal(a.score, 10, 'instant re-add: points go back to Ada');
  assert.equal(b.score, 0);
});

test('claim window: after the piece has been out a while, whoever loads it claims it', () => {
  const { room, join, send } = makeRoom();
  const a = join('A', 'Ada'), b = join('B', 'Bo'); join('C', 'Cy');
  send('A', 'start');
  const box = room.items.get(firstOf(room, 'standard'));
  load(room, a, box.id, 2, 2);
  b.loadMode = true; b.unloading = true; b.cursor = { gx: 2, gz: 2, rot: 0 };
  b.pending.tapN = 1; room.tick(0.05);
  for (let i = 0; i < 20 * 9; i++) room.tick(0.05);    // out of the truck for 9 s
  b.cursor = { gx: 0, gz: 0, rot: 0 }; b.pending.tapN = 1; room.tick(0.05);
  assert.equal(b.score, 10, 'Bo claims it');
  assert.equal(a.score, 0);
});

test('drive-off tally: each player is scored on what they placed, how well, and its condition', () => {
  const { room, join, send } = makeRoom();
  const a = join('A', 'Ada'), b = join('B', 'Bo');
  send('A', 'start');
  load(room, a, firstOf(room, 'standard'), 0, 0);   // solid
  load(room, b, firstOf(room, 'heavy'), 0, 0);      // heavy on a lighter box: 85%
  room.timeLeft = 0.01; room.tick(0.05); driveAway(room);
  const t = room.results.tally;
  assert.equal(t.A.final, 10);
  assert.equal(t.B.base, 20);
  assert.equal(t.B.placement, -3);
  assert.equal(t.B.final, 17);
  assert.equal(b.score, 17, 'score matches the tally');
  assert.equal(t.A.pieces, 1);
});

test('load report adds up: placed pieces (even ones that broke) + adjustments + damage = final', () => {
  const { room, join, send } = makeRoom();
  const a = join('A', 'Ada'), b = join('B', 'Bo');
  send('A', 'start');
  load(room, b, firstOf(room, 'fragile'), 1, 0);
  load(room, b, firstOf(room, 'standard'), 0, 0);
  load(room, b, firstOf(room, 'standard'), 0, 0);
  const couch = room.items.get(firstOf(room, 'couch')); couch.wrapped = true;
  load(room, a, couch.id, 0, 0);
  room.timeLeft = 0.01; room.tick(0.05); driveAway(room);
  for (const [pid, t] of Object.entries(room.results.tally)) {
    assert.equal(t.base + t.condition + t.placement + t.damage, t.final, `${pid}: ${JSON.stringify(t)}`);
  }
});

test('in the truck, Rotate turns a piece on the same side and Flip tips it onto another side', async () => {
  const { orientations, footprint } = await import('../shared/logic.js');
  const { room, join } = makeRoom({ level: 'classic' });
  const a = join('A', 'Ada'); join('B', 'Bo');
  room.startRound(); room.phase = 'playing';
  const couch = [...room.items.values()].find(i => i.type === 'couch');
  couch.state = 'carried'; couch.carriers = [a.id]; a.carry = couch.id; a.loadMode = true; a.cursor = { gx: 0, gz: 0, rot: 0 }; a.cursorCd = 0;
  const h = () => footprint('couch', a.cursor.rot).h, fp = () => JSON.stringify(footprint('couch', a.cursor.rot));
  const h0 = h(), f0 = fp();
  a.pending.rotN = 1; room.updateLoadMode(a, couch, 0.05); a.pending.rotN = 0;
  assert.equal(h(), h0, 'rotate keeps it on the same side');
  assert.notEqual(fp(), f0, 'rotate turns it');
  a.pending.flipN = 1; room.updateLoadMode(a, couch, 0.05); a.pending.flipN = 0;
  assert.notEqual(h(), h0, 'flip tips it onto another side');
  assert.ok(orientations('couch').length > 2);
});
