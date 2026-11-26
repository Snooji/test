// Seeds: every house comes from a seed, every seed gives its own house, and a short house code brings the same house back.
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateLevel, houseCode, seedFromCode } from '../shared/level.js';
import { MoveRoom } from '../server/MoveRoom.js';

const sig = (L) => JSON.stringify(L.rooms.map(r => [r.role, r.x0, r.x1, r.z0, r.z1]));

test('50 seeds give 50 different houses, in every floor count', () => {
  for (const floors of [1, 2, 3]) {
    const s = new Set();
    for (let i = 0; i < 50; i++) s.add(sig(generateLevel(1000 + i * 104729, { floors })));
    assert.ok(s.size === 50, `floors ${floors}: only ${s.size} distinct plans in 50 seeds`);
  }
});

test('plans vary in shape, not just size: mirrored, garages, open-plan living/dining, different room orders', () => {
  const seen = { mirrored: 0, plain: 0, garage: 0, open: 0, orders: new Set() };
  for (let i = 0; i < 120; i++) {
    const L = generateLevel(77 + i * 7919);
    if (L.variant.mirrored) seen.mirrored++; else seen.plain++;
    if (L.rooms.some(r => r.role === 'garage')) seen.garage++;
    if (L.variant.openPlan) seen.open++;
    seen.orders.add(L.rooms.filter(r => r.x1 <= L.rooms.find(h => h.role === 'hall')?.x0 + 0.01).sort((a, b) => a.z0 - b.z0).map(r => r.role).join());
  }
  assert.ok(seen.mirrored > 20 && seen.plain > 20, `mirrored ${seen.mirrored} / plain ${seen.plain}`);
  assert.ok(seen.garage > 10, `garages: ${seen.garage}`);
  assert.ok(seen.open > 10, `open plan: ${seen.open}`);
  assert.ok(seen.orders.size > 12, `back-wing room orders: ${seen.orders.size}`);
});

test('house codes: short, readable, and round-trip to the same seed', () => {
  for (const seed of [0, 1, 42, 123456789, 2 ** 31 - 1]) {
    const c = houseCode(seed);
    assert.match(c, /^[0-9A-Z]{1,7}$/);
    assert.equal(seedFromCode(c), seed);
    assert.equal(seedFromCode(c.toLowerCase()), seed, 'case does not matter');
    assert.equal(seedFromCode(` ${c.slice(0, 3)}-${c.slice(3)} `), seed, 'spaces and dashes ignored');
  }
  assert.equal(seedFromCode('not a code!'), null);
  assert.equal(seedFromCode(''), null);
});

test('the crew chief can type a house code in the lobby and everyone gets that exact house', () => {
  const room = new MoveRoom();
  const handlers = {};
  room.onMessage = (type, fn) => { handlers[type] = fn; };
  room.setSimulationInterval = () => {}; room.broadcast = () => {}; room.clients = [];
  room.onCreate({ dolly: false });
  room.clients.push({ sessionId: 'A', send: () => {} });
  room.onJoin({ sessionId: 'A' }, {}, { name: 'Ada', email: 'a@x.io' });
  room.hostId = 'A';
  const want = generateLevel(seedFromCode('MOON42'));
  handlers.seed({ sessionId: 'A' }, { code: 'moon-42' });
  assert.equal(sig(room.level), sig(want));
  assert.equal(room.snapshot().level.code, 'MOON42');
  room.startRound();
  assert.equal(sig(room.level), sig(want), 'the round is played in that house');
  handlers.seed({ sessionId: 'A' }, { code: '???' });
  assert.equal(sig(room.level), sig(want), 'a bad code changes nothing');
});
