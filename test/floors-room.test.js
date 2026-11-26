// Stairs in a live room: movers, what they carry and team lifts change floor together, smoothly; dollies stay put;
// AI movers fetch things from upstairs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { MoveRoom } from '../server/MoveRoom.js';

const DT = 0.05, SPEED = 5;

function makeRoom(opts = {}) {
  const room = new MoveRoom();
  const handlers = {};
  room.onMessage = (type, fn) => { handlers[type] = fn; };
  room.setSimulationInterval = () => {};
  room.broadcast = () => {};
  room.clients = [];
  room.onCreate({ dolly: false, ...opts });
  const join = (id, name) => {
    room.clients.push({ sessionId: id, send: () => {} });
    room.onJoin({ sessionId: id }, {}, { name, email: name + '@x.io' });
    return room.players.get(id);
  };
  return { room, join, handlers };
}
const onScreen = (L, o) => ({ x: o.x, z: o.z - 40 * L.floorOf(o.z), y: L.renderY(o.x, o.z) });
const go = (p, mz) => { p.in.mx = 0; p.in.mz = mz; };

test('a mover carrying a box walks up the stairs and back down: no jumps, the box comes along', () => {
  const { room, join } = makeRoom({ seed: 4242, floors: 3 });
  const a = join('A', 'Ada'); join('B', 'Bo');
  room.startRound(); room.phase = 'playing';
  const L = room.level;
  for (const st of L.stairs) {
    const box = [...room.items.values()].find(i => i.type === 'standard' && i.state === 'floor');
    a.x = (st.x0 + st.x1) / 2; a.z = (st.dir > 0 ? st.zl - 0.8 : st.zh + 0.8) + 40 * st.b;
    box.state = 'carried'; box.carriers = [a.id]; a.carry = box.id;
    let prev = onScreen(L, a);
    go(a, st.dir);
    for (let i = 0; i < 80; i++) {
      room.tick(DT);
      const now = onScreen(L, a);
      assert.ok(Math.hypot(now.x - prev.x, now.z - prev.z) <= SPEED * DT * 1.2 && Math.abs(now.y - prev.y) < 0.3, `stair ${st.b} tick ${i}: jumped`);
      assert.ok(!L.hitsWall(a.x, a.z, 0.44), `stair ${st.b}: in a wall`);
      prev = now;
    }
    assert.equal(L.floorOf(a.z), st.b + 1, `climbed stair ${st.b}`);
    assert.equal(L.floorOf(box.z), st.b + 1, 'the box came up too');
    assert.ok(Math.hypot(box.x - a.x, box.z - a.z) < 1, 'still in hand');
    go(a, -st.dir);
    for (let i = 0; i < 80; i++) room.tick(DT);
    assert.equal(L.floorOf(a.z), st.b, `back down stair ${st.b}`);
    room.releaseCarry(a);
  }
});

test('a team lift goes up the stairs together: piece and both carriers change floor in the same tick', () => {
  const { room, join } = makeRoom({ seed: 99, floors: 2 });
  const a = join('A', 'Ada'), b = join('B', 'Bo');
  room.startRound(); room.phase = 'playing';
  const L = room.level, st = L.stairs[0];
  const couch = [...room.items.values()].find(i => i.type === 'couch');
  const x = (st.x0 + st.x1) / 2, foot = st.dir > 0 ? st.zl - 0.2 : st.zh + 0.2;
  couch.x = x; couch.z = foot; couch.state = 'carried'; couch.carriers = [a.id, b.id]; couch.axis = st.dir > 0 ? -Math.PI / 2 : Math.PI / 2;
  const off = room.carryOffset(couch);
  a.carry = b.carry = couch.id;
  a.x = b.x = x; a.z = foot + st.dir * off; b.z = foot - st.dir * off;
  go(a, st.dir); go(b, st.dir);
  let changed = null;
  for (let i = 0; i < 200 && !changed; i++) {
    const f0 = [couch, a, b].map(o => L.floorOf(o.z));
    room.tick(DT);
    const f1 = [couch, a, b].map(o => L.floorOf(o.z));
    if (f1[0] !== f0[0]) { changed = f1; assert.deepEqual(f1, [1, 1, 1], 'all three changed floor together'); }
    assert.equal(couch.state, 'carried', `tick ${i}: lost grip on the stairs`);
  }
  assert.ok(changed, 'the couch got carried upstairs');
});

test('the two-wheel dolly bumps up the stairs with its boxes; the furniture dolly stops at the foot', () => {
  const { room, join } = makeRoom({ seed: 4242, floors: 2, dolly: true });
  const a = join('A', 'Ada'), b = join('B', 'Bo');
  room.startRound(); room.phase = 'playing';
  const L = room.level, st = L.stairs[0];
  const foot = (p, back) => { p.x = (st.x0 + st.x1) / 2; p.z = st.dir > 0 ? st.zl - back : st.zh + back; p.face = st.dir > 0 ? 0 : Math.PI; };
  // two-wheel dolly with a box on it
  const d = room.items.get('dolly'), box = [...room.items.values()].find(i => i.type === 'standard' && i.state === 'floor');
  foot(a, 0.8); // on the landing (1.4 m deep)
  d.x = a.x; d.z = a.z + st.dir * 0.9; d.state = 'pushed'; d.pusher = a.id; a.dolly = 'dolly';
  d.stack = [box.id]; box.state = 'dolly'; box.dollyId = 'dolly';
  go(a, st.dir);
  for (let i = 0; i < 120 && L.floorOf(a.z) === 0; i++) room.tick(DT);
  assert.equal(L.floorOf(a.z), 1, 'pushed the dolly upstairs');
  assert.equal(L.floorOf(d.z), 1, 'the dolly came too');
  assert.deepEqual(d.stack, [box.id], 'box still on it');
  // furniture dolly
  const fd = room.items.get('flatdolly');
  assert.equal(L.floorOf(fd.z), 0, 'the furniture dolly starts downstairs');
  foot(b, 0.8);
  fd.pusher = b.id; fd.state = 'pushed'; b.flatDolly = 'flatdolly';
  const off = room.flatReach(fd); fd.x = b.x; fd.z = b.z + st.dir * off;
  go(b, st.dir);
  for (let i = 0; i < 80; i++) room.tick(DT);
  assert.equal(L.floorOf(b.z), 0, 'still downstairs');
  assert.equal(L.renderY(b.x, b.z), 0, 'never got a foot on the steps');
});

test('the furniture dolly always spawns downstairs; the two-wheel dolly can be on any floor', () => {
  const floorsSeen = new Set();
  for (let s = 1; s <= 30; s++) {
    const { room, join } = makeRoom({ seed: s * 977, floors: 3, dolly: true });
    join('A', 'Ada'); room.startRound();
    assert.equal(room.level.floorOf(room.items.get('flatdolly').z), 0, `seed ${s}`);
    floorsSeen.add(room.level.floorOf(room.items.get('dolly').z));
  }
  assert.ok(floorsSeen.size > 1, 'the two-wheel dolly turns up upstairs sometimes');
});

test('an AI mover finds a box upstairs and brings it down to the truck', () => {
  const { room, join } = makeRoom({ seed: 31337, floors: 2 });
  join('A', 'Ada'); room.addBot();
  room.startRound();
  const L = room.level;
  const up = [...room.items.values()].find(i => i.state === 'floor' && !i.type.includes('dolly') && L.floorOf(i.z) === 1 && ['standard', 'heavy', 'fragile'].includes(i.type));
  assert.ok(up, 'setup: a box upstairs');
  for (const [id, it] of room.items) if (it !== up) room.items.delete(id);
  const human = room.players.get('A'); human.x = 11; human.z = 3; // stays at the truck
  const bot = [...room.bots.values()][0];
  bot.setDifficulty('hard');
  for (let t = 0; t < 150 && up.state !== 'loaded'; t += DT) { room.tick(DT); assert.ok(!L.hitsWall(bot.p.x, bot.p.z, 0.4), `bot in a wall at ${bot.p.x.toFixed(2)},${bot.p.z.toFixed(2)}`); }
  assert.equal(up.state, 'loaded', `box ended ${up.state} at ${up.x.toFixed(1)},${up.z.toFixed(1)}; bot at ${bot.p.x.toFixed(1)},${bot.p.z.toFixed(1)}`);
});

test('the crew chief picks 1–4 floors in the lobby; the house is rebuilt and the snapshot says so', () => {
  const { room, join, handlers } = makeRoom({ seed: 5 });
  join('A', 'Ada');
  room.hostId = 'A';
  handlers.floors({ sessionId: 'A' }, { floors: 3 });
  assert.equal(room.level.floors, 3);
  const snap = room.snapshot();
  assert.equal(snap.level.floors, 3);
  handlers.floors({ sessionId: 'A' }, { floors: 9 });
  assert.equal(room.level.floors, 3, 'ignores nonsense');
  handlers.floors({ sessionId: 'B' }, { floors: 1 });
  assert.equal(room.level.floors, 3, 'only the crew chief');
});
