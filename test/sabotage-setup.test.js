// Sabotage, pack the house: the house starts unpacked (furniture only), each room has a box quota, and the props are out.
import test from 'node:test';
import assert from 'node:assert/strict';
import { MoveRoom } from '../server/MoveRoom.js';
import { TRUCK } from '../shared/world.js';

export function sabRoom({ movers = 6, seed = 4242, game = 'sabotage' } = {}) {
  const room = new MoveRoom(), handlers = {}, events = [];
  room.onMessage = (t, fn) => { handlers[t] = fn; }; room.setSimulationInterval = () => {}; room.clients = [];
  room.broadcast = (t, m) => { if (t === 'evt') events.push(m); };
  room.onCreate({ game, crew: movers });
  room.seedOverride = seed; room.newLevel(); room.resetWorld();
  const ids = [];
  for (let i = 0; i < movers; i++) {
    const id = 'P' + i; ids.push(id);
    room.clients.push({ sessionId: id, send: (t, m) => events.push({ ...m, to: id }) });
    room.onJoin({ sessionId: id }, {}, { name: 'M' + i, email: `m${i}@x.io` });
  }
  room.seedOverride = seed;
  room.startRound();
  for (let i = 0; i < 80 && room.phase !== 'playing'; i++) room.tick(0.05);
  const send = (id, t, m) => handlers[t]({ sessionId: id }, m);
  return { room, ids, P: (i) => room.players.get(ids[i]), send, events, handlers };
}
const BOXES = ['standard', 'heavy', 'fragile'];

test('sabotage: no loose boxes, all the furniture, and box quotas that add up to the boxes the house was sized for', () => {
  // the same seed in Full load gives the reference house (same exact-fill generator)
  const ref = new MoveRoom(); ref.onMessage = () => {}; ref.setSimulationInterval = () => {}; ref.clients = []; ref.broadcast = () => {};
  ref.onCreate({ crew: 6 }); ref.mode = 'load'; ref.seedOverride = 4242; ref.newLevel(); ref.resetWorld();
  const refItems = [...ref.items.values()].filter(i => !['dolly', 'flatdolly'].includes(i.type));
  const refBoxes = refItems.filter(i => BOXES.includes(i.type)).length;
  const refFurniture = refItems.filter(i => !BOXES.includes(i.type)).map(i => i.type).sort();

  const { room } = sabRoom();
  assert.ok(room.sab, 'sabotage game created');
  const items = [...room.items.values()];
  assert.equal(items.filter(i => BOXES.includes(i.type)).length, 0, 'nothing starts packed');
  assert.deepEqual(items.filter(i => !BOXES.includes(i.type) && !ITEM_TOOLS.has(i.type)).map(i => i.type).sort(), refFurniture);
  assert.equal([...room.sab.quota.values()].reduce((a, b) => a + b, 0), refBoxes);
  for (const [ri] of room.sab.quota) assert.ok(!['hall', 'passage', 'stairs'].includes(room.level.rooms[ri].role));
});
const ITEM_TOOLS = new Set(['dolly', 'flatdolly', 'flatstack', 'padcrate', 'breaker']);

test('sabotage: a flat-box stack and a padding crate by the ramp, a breaker in the garage or laundry', () => {
  const { room } = sabRoom();
  const of = (t) => [...room.items.values()].filter(i => i.type === t);
  assert.equal(of('flatstack').length, 1); assert.equal(of('padcrate').length, 1); assert.equal(of('breaker').length, 1);
  const rx = TRUCK.ramp.x0;
  for (const t of ['flatstack', 'padcrate']) { const it = of(t)[0]; assert.ok(Math.hypot(it.x - rx, it.z) < 4, `${t} near the ramp: ${it.x},${it.z}`); }
  const br = of('breaker')[0], r = room.level.rooms[room.sab.roomAt(br.x, br.z)];
  const has = room.level.rooms.some(q => ['garage', 'laundry'].includes(q.role));
  if (has) assert.ok(['garage', 'laundry'].includes(r.role), `breaker in ${r.role}`);
});

test('other modes are untouched: a competitive game has no sabotage state and keeps its boxes', () => {
  const { room } = sabRoom({ game: 'classic', movers: 4 });
  assert.equal(room.sab, null);
  assert.ok([...room.items.values()].some(i => BOXES.includes(i.type)));
  assert.ok(![...room.items.values()].some(i => ['flatstack', 'padcrate', 'breaker'].includes(i.type)));
});
