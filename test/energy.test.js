import test from 'node:test';
import assert from 'node:assert/strict';
import { MoveRoom, ENERGY } from '../server/MoveRoom.js';

const DT = 0.05;
function setup(opts = {}) {
  const room = new MoveRoom();
  room.onMessage = () => {}; room.setSimulationInterval = () => {}; room.clients = [];
  const events = []; room.broadcast = (t, m) => { if (t === 'evt') events.push(m); };
  room.onCreate({ level: 'classic', dolly: false, ...opts });
  room.clients.push({ sessionId: 'A', send: () => {} }); room.onJoin({ sessionId: 'A' }, {}, { name: 'Ada', email: 'a@x.io' });
  room.clients.push({ sessionId: 'B', send: () => {} }); room.onJoin({ sessionId: 'B' }, {}, { name: 'Bo', email: 'b@x.io' });
  room.startRound();
  while (room.phase !== 'playing') room.tick(DT);
  return { room, a: room.players.get('A'), events };
}
const give = (room, p, type) => { const it = [...room.items.values()].find(i => i.type === type && i.state === 'floor'); it.state = 'carried'; it.carriers = [p.id]; p.carry = it.id; p.x = -2; p.z = 0; it.x = p.x; it.z = p.z; return it; };
// walk back and forth in the open yard so walls never stop us
function walk(room, p, secs, stick = 1) { let dir = 1; for (let t = 0; t < secs; t += DT) { if (p.x > 6) dir = -1; if (p.x < 0) dir = 1; p.z = 0; p.in.mx = dir * stick; p.in.mz = 0; room.tick(DT); } p.in.mx = 0; }

test('energy: carrying a heavy box flat out drains it in a few seconds; careful walking drains far less', () => {
  const { room, a } = setup(); give(room, a, 'heavy'); a.x = 1;
  walk(room, a, 2);
  const fast = 1 - a.energy;
  assert.ok(fast > 0.45 && fast < 0.75, `full speed for 2 s used ${fast.toFixed(2)}`);
  a.energy = 1; walk(room, a, 2, 0.5);
  const slow = 1 - a.energy;
  assert.ok(slow < fast / 3, `half speed used ${slow.toFixed(2)} vs ${fast.toFixed(2)}`);
});

test('energy: standing still refills it, even while holding the box', () => {
  const { room, a } = setup(); give(room, a, 'standard'); a.energy = 0.2;
  for (let t = 0; t < 1; t += DT) room.tick(DT);
  assert.ok(a.energy > 0.5, `refilled to ${a.energy.toFixed(2)}`);
  assert.ok(a.carry, 'still holding it');
});

test('energy: running empty means a short injury: slower, no dash, then back to normal', () => {
  const { room, a, events } = setup(); give(room, a, 'heavy'); a.x = 1; a.energy = 0.05;
  walk(room, a, 1);
  assert.ok(a.injuredT > 5, 'injured');
  assert.ok(events.some(e => e.kind === 'toast' && /Ada .*Slowed down/.test(e.text)));
  room.releaseCarry(a); a.x = 1; a.energy = 1;
  const x0 = a.x; walk(room, a, 0.5); const hurt = Math.abs(a.x - x0);
  a.pending.dashN = 1; room.tick(DT); assert.equal(a.dashT, 0, 'no dash while hurt');
  for (let t = 0; t < ENERGY.injurySecs; t += DT) room.tick(DT);
  assert.equal(a.injuredT, 0, 'healed');
  a.x = 1; const x1 = a.x; walk(room, a, 0.5); const healthy = Math.abs(a.x - x1);
  assert.ok(hurt < healthy * 0.7, `hurt ${hurt.toFixed(2)} m vs healthy ${healthy.toFixed(2)} m`);
});

test('energy: the dolly barely uses any', () => {
  const { room, a } = setup({ dolly: true });
  const d = [...room.items.values()].find(i => i.type === 'dolly');
  a.dolly = d.id; d.state = 'pushed'; d.pusher = a.id; a.x = 1;
  walk(room, a, 4);
  assert.ok(1 - a.energy < 0.12, `dolly used ${(1 - a.energy).toFixed(2)}`);
});

test('energy: no injuries in training', () => {
  const { room, a } = setup({ tutorial: true });
  if (!room.tutorialMode) return; // training needs its own house
  give(room, a, 'standard'); a.energy = 0.01; walk(room, a, 1);
  assert.equal(a.injuredT || 0, 0);
});

test('energy: walking empty-handed never drains it (it slowly refills)', () => {
  const { room, a } = setup(); a.x = 1; a.energy = 0.6;
  walk(room, a, 3);
  assert.ok(a.energy > 0.6, `empty-handed went to ${a.energy.toFixed(2)}`);
  a.energy = 1; walk(room, a, 3);
  assert.equal(a.energy, 1);
});
