import test from 'node:test';
import assert from 'node:assert/strict';
import { DemoRoom } from '../server/DemoRoom.js';
import { MoveRoom } from '../server/MoveRoom.js';

function makeDemo() {
  const room = new DemoRoom();
  let snaps = 0;
  room.onMessage = () => {}; room.setSimulationInterval = () => {}; room.clients = [];
  room.broadcast = (t) => { if (t === 'snap') snaps++; };
  room.onCreate({});
  return { room, snaps: () => snaps };
}

test('demo room: four AI movers already playing, anyone can watch without signing in', async () => {
  const { room } = makeDemo();
  assert.equal(room.bots.size, 4);
  assert.ok(['countdown', 'playing'].includes(room.phase));
  assert.equal(await room.onAuth({}, {}), true);
  room.onJoin({ sessionId: 'viewer' }, {}, true);
  assert.equal(room.players.has('viewer'), false, 'viewers are not movers');
});

test('demo room: sends fewer snapshots (cheap to stream behind the menu)', () => {
  const { room, snaps } = makeDemo();
  for (let i = 0; i < 60; i++) room.tick(0.05);
  assert.ok(snaps() <= 21, `${snaps()} snapshots for 60 ticks`);
});

test('demo room: loops forever and never counts toward the business funnel', () => {
  const seen = [];
  MoveRoom.store = { event: async (n) => { seen.push(n); }, recordGame: async () => {}, addScore: async () => {}, logError: async () => {} };
  const { room } = makeDemo();
  room.timeLeft = 0.01;
  for (let i = 0; i < 20 * 40 && room.phase !== 'playing' || i < 40; i++) room.tick(0.05);
  for (let i = 0; i < 20 * 40; i++) room.tick(0.05);
  assert.ok(['countdown', 'playing'].includes(room.phase), `phase ${room.phase}`);
  assert.deepEqual(seen, []);
  MoveRoom.store = null;
});
