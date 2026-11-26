import test from 'node:test';
import assert from 'node:assert/strict';
import { MoveRoom } from '../server/MoveRoom.js';

const DT = 0.05;
function setup(n = 3) {
  const room = new MoveRoom();
  const handlers = {};
  room.onMessage = (t, fn) => { handlers[t] = fn; }; room.setSimulationInterval = () => {}; room.clients = [];
  const events = []; room.broadcast = (t, m) => { if (t === 'evt') events.push(m); };
  room.onCreate({ level: 'classic', dolly: false });
  const ids = ['A', 'B', 'C'].slice(0, n);
  for (const id of ids) { room.clients.push({ sessionId: id, send: () => {} }); room.onJoin({ sessionId: id }, {}, { name: id, email: id + '@x.io' }); }
  room.startRound();
  while (room.phase !== 'playing') room.tick(DT);
  const P = Object.fromEntries(ids.map(id => [id, room.players.get(id)]));
  // A and B are carrying the couch together
  const couch = [...room.items.values()].find(i => i.type === 'couch');
  couch.wrapped = true; couch.state = 'carried'; couch.carriers = ['A', 'B']; P.A.carry = couch.id; P.B.carry = couch.id;
  P.A.x = couch.x - 1.2; P.A.z = couch.z; P.B.x = couch.x + 1.2; P.B.z = couch.z;
  return { room, P, couch, events, send: (id, t, m) => handlers[t]({ sessionId: id }, m) };
}
const tap = (room, p) => { p.pending.tapN = 1; room.tick(DT); };
function mash(room, send, id, n) { for (let i = 0; i < n; i++) { send(id, 'duelTap'); room.tick(DT * 1.2); } }

test('steal: tapping a lift two people carry starts a 5 s tap battle with the nearest carrier; nobody moves meanwhile', () => {
  const { room, P, couch, events } = setup();
  P.C.x = couch.x + 0.9; P.C.z = couch.z + 0.4;
  tap(room, P.C);
  const d = room.duels.get(couch.id);
  assert.ok(d, 'battle started');
  assert.equal(d.a, 'C'); assert.equal(d.b, 'B', 'against the closest carrier');
  assert.ok(events.some(e => e.kind === 'toast' && /trying to steal/.test(e.text)));
  const x0 = couch.x; P.A.in.mx = 1; room.tick(DT); room.tick(DT);
  assert.equal(couch.x, x0, 'the lift is frozen during the battle');
  assert.ok(room.snapshot().duels.length === 1);
});

test('steal: the challenger who taps more takes that end of the lift', () => {
  const { room, P, couch, send } = setup();
  P.C.x = couch.x + 0.9; P.C.z = couch.z + 0.4; tap(room, P.C);
  mash(room, send, 'C', 40);                       // C mashes, B barely taps
  send('B', 'duelTap');
  for (let t = 0; t < 6; t += DT) room.tick(DT);
  assert.ok(!room.duels.has(couch.id), 'over after 5 s');
  assert.deepEqual([...couch.carriers].sort(), ['A', 'C']);
  assert.equal(P.C.carry, couch.id); assert.equal(P.B.carry, null);
});

test('steal: taps that reach the server bunched together (phone network) all count', () => {
  const { room, P, couch, send } = setup();
  P.C.x = couch.x + 0.9; P.C.z = couch.z + 0.4; tap(room, P.C);
  const d = room.duels.get(couch.id);
  for (let i = 0; i < 10; i++) { send('C', 'duelTap'); send('C', 'duelTap'); room.tick(DT * 4); } // 2 taps per 0.2 s, arriving together
  assert.ok(d.ca > 17, `bunched taps counted: ${d.ca} of 20`); // 20 taps, each worth a little under 1 as energy drains
});

test('steal: an autoclicker is capped (a burst counts a few, a held rate tops out around 15/s)', () => {
  const { room, P, couch, send } = setup();
  P.C.x = couch.x + 0.9; P.C.z = couch.z + 0.4; tap(room, P.C);
  const d = room.duels.get(couch.id);
  for (let i = 0; i < 50; i++) send('C', 'duelTap');
  assert.ok(d.ca <= 4.01, `burst counted ${d.ca}`);
  const before = d.ca;
  for (let k = 0; k < 20; k++) { for (let i = 0; i < 10; i++) send('C', 'duelTap'); room.tick(DT); } // 200 taps/s for 1 s
  assert.ok(d.ca - before <= 16, `held autoclicker counted ${d.ca - before} in 1 s`);
});

test('steal: the holder who taps more keeps it; an autoclicker burst does not win it', () => {
  const { room, P, couch, send } = setup();
  P.C.x = couch.x + 0.9; P.C.z = couch.z + 0.4; tap(room, P.C);
  for (let i = 0; i < 50; i++) send('C', 'duelTap');  // autoclicker burst in one instant: counts a few
  mash(room, send, 'B', 20);
  for (let t = 0; t < 6; t += DT) room.tick(DT);
  assert.deepEqual([...couch.carriers].sort(), ['A', 'B']);
  assert.equal(P.C.carry ?? null, null);
});

test('steal: an AI holder mashes back', () => {
  const room = new MoveRoom();
  const handlers = {}; room.onMessage = (t, fn) => { handlers[t] = fn; }; room.setSimulationInterval = () => {}; room.clients = []; room.broadcast = () => {};
  room.onCreate({ level: 'classic', dolly: false });
  room.clients.push({ sessionId: 'C', send: () => {} }); room.onJoin({ sessionId: 'C' }, {}, { name: 'C', email: 'c@x.io' });
  const b1 = room.addBot(), b2 = room.addBot();
  room.startRound(); while (room.phase !== 'playing') room.tick(DT);
  const couch = [...room.items.values()].find(i => i.type === 'couch');
  const [x, y] = [room.players.get(b1.id), room.players.get(b2.id)];
  couch.wrapped = true; couch.state = 'carried'; couch.carriers = [x.id, y.id]; x.carry = couch.id; y.carry = couch.id;
  x.x = couch.x - 1.2; x.z = couch.z; y.x = couch.x + 1.2; y.z = couch.z;
  for (const b of room.bots.values()) b.think = () => {}; // hold still
  const c = room.players.get('C'); c.x = couch.x + 0.9; c.z = couch.z + 0.4; c.pending.tapN = 1; room.tick(DT);
  const d = room.duels.get(couch.id); assert.ok(d);
  for (let t = 0; t < 2; t += DT) room.tick(DT);
  assert.ok(d.cb > 4, `bot tapped ${d.cb} times in 2 s`);
});

test('steal: taps count by energy — an exhausted mover taps for less, and tapping itself tires you', () => {
  const { room, P, couch, send } = setup();
  P.C.x = couch.x + 0.9; P.C.z = couch.z + 0.4; tap(room, P.C);
  P.C.energy = 1; P.B.energy = 0.2;                          // B has been hauling the couch
  for (let i = 0; i < 30; i++) { send('C', 'duelTap'); send('B', 'duelTap'); room.tick(DT * 1.2); } // same number of taps
  const d = room.duels.get(couch.id);
  assert.ok(d.ca > d.cb * 2, `fresh taps should count far more: ${d.ca.toFixed(1)} vs ${d.cb.toFixed(1)}`);
  assert.ok(P.C.energy < 0.85, `30 taps should tire you a little (energy ${P.C.energy.toFixed(2)})`);
  for (let t = 0; t < 6; t += DT) room.tick(DT);
  assert.equal(P.C.carry, couch.id, 'the fresh mover wins');
});

test('steal: a person tapping at an ordinary 6–7 taps a second beats a hard AI holder when both are fresh', () => {
  let wins = 0;
  for (let run = 0; run < 10; run++) {
    const room = new MoveRoom(); const handlers = {};
    room.onMessage = (t, fn) => { handlers[t] = fn; }; room.setSimulationInterval = () => {}; room.clients = []; room.broadcast = () => {};
    room.onCreate({ level: 'classic', dolly: false });
    for (const id of ['A', 'C']) { room.clients.push({ sessionId: id, send: () => {} }); room.onJoin({ sessionId: id }, {}, { name: id, email: id + '@x.io' }); }
    const bp = room.addBot(); const bot = room.bots.get(bp.id); bot.setDifficulty('hard');
    room.startRound(); while (room.phase !== 'playing') room.tick(DT);
    const A = room.players.get('A'), C = room.players.get('C');
    const couch = [...room.items.values()].find(i => i.type === 'couch');
    couch.wrapped = true; couch.state = 'carried'; couch.carriers = ['A', bp.id]; A.carry = bp.carry = couch.id;
    A.x = couch.x - 1.2; A.z = couch.z; bp.x = couch.x + 1.2; bp.z = couch.z; bp.energy = 1; C.energy = 1;
    bot.think = () => {}; // keep it in the duel (no wandering off)
    C.x = couch.x + 0.9; C.z = couch.z + 0.4; tap(room, C);
    if (!room.duels.has(couch.id)) continue;
    for (let t = 0; t < 5.5; t += DT) { if (Math.round(t / DT) % 3 === 0) handlers.duelTap({ sessionId: 'C' }); room.tick(DT); }
    if (C.carry === couch.id) wins++;
  }
  assert.ok(wins >= 7, `an ordinary human pace should usually beat a hard AI (won ${wins}/10)`);
});
