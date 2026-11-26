// AI fairness: bots play by the same physical rules as people, see only what's near them,
// and only know who broke something if they saw it happen.
import test from 'node:test';
import assert from 'node:assert/strict';
import { MoveRoom } from '../server/MoveRoom.js';
import { mulberryFor } from '../shared/logic.js';

const SPEED = 5, DT = 0.05;

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

function audit(room, seconds) {
  const last = new Map(), s = {};
  for (let t = 0; t < seconds && room.phase !== 'results'; t += DT) {
    const wasPlaying = room.phase === 'playing';
    room.tick(DT);
    for (const p of room.players.values()) {
      if (!p.bot) continue;
      const r = s[p.name] ||= { moved: 0, ticks: 0, dashT: 0, firstDash: null, bad: [], inWall: 0 };
      const l = last.get(p.id);
      if (l && wasPlaying && room.phase === 'playing') {
        const d = Math.hypot(p.x - l.x, p.z - l.z);
        r.moved += d; r.ticks++;
        if (p.dashT > 0) { r.dashT += DT; if (r.firstDash === null) r.firstDash = t; }
        const cap = SPEED * DT * (p.dashT > 0 ? 2 : 1) * 1.15;
        if (d > cap) r.bad.push({ t: +t.toFixed(2), d: +d.toFixed(2), load: p.loadMode, carry: p.carry && room.items.get(p.carry)?.type });
        if (room.level.hitsWall(p.x, p.z, 0.3)) r.inWall++;
      }
      last.set(p.id, { x: p.x, z: p.z });
    }
  }
  return s;
}

for (const seed of [4242, 11]) {
  test(`AI movers never teleport, clip walls or outrun a walking person (seed ${seed})`, () => {
    const rnd = Math.random; Math.random = mulberryFor(seed);
    try {
      const { room } = makeRoom({ seed, dolly: true });
      for (let i = 0; i < 4; i++) room.addBot();
      room.difficulty = 'hard'; for (const b of room.bots.values()) b.setDifficulty('hard');
      room.startRound();
      const s = audit(room, 100);
      for (const [n, r] of Object.entries(s)) {
        assert.deepEqual(r.bad.slice(0, 5), [], `${n} moved faster than allowed in one tick`);
        assert.equal(r.inWall, 0, `${n} stood inside a wall`);
        assert.ok(r.firstDash === null || r.firstDash > 4, `${n} dashed off the start line at ${r.firstDash}s`);
        assert.ok(r.dashT <= 3.1, `${n} dashed ${r.dashT.toFixed(1)}s in 100s`);
        assert.ok(r.moved / (r.ticks * DT) < SPEED * 0.9, `${n} averaged ${(r.moved / (r.ticks * DT)).toFixed(2)} m/s`);
      }
    } finally { Math.random = rnd; }
  });
}

test('a person dropping a box in the truck is not shoved off the ramp', () => {
  const { room, join } = makeRoom({ level: 'classic' });
  const a = join('A', 'Ada'); join('B', 'Bo');
  room.startRound();
  while (room.phase !== 'playing') room.tick(DT);
  const box = [...room.items.values()].find(i => i.type === 'standard' && i.state === 'floor');
  box.state = 'carried'; box.carriers = [a.id]; a.carry = box.id;
  a.x = 10.2; a.z = 0.3; box.x = a.x; box.z = a.z;
  let prev = { x: a.x, z: a.z };
  for (let i = 0; i < 40; i++) {
    if (a.loadMode && i === 30) a.pending.tapN = 1;
    room.tick(DT);
    const d = Math.hypot(a.x - prev.x, a.z - prev.z);
    assert.ok(d <= SPEED * DT * 1.15, `tick ${i}: jumped ${d.toFixed(2)} m`);
    prev = { x: a.x, z: a.z };
  }
  assert.equal(box.state, 'loaded');
});

test('AI only goes for things it has actually seen', () => {
  const { room } = makeRoom({ seed: 222 });
  room.addBot();
  room.startRound();
  const bot = [...room.bots.values()][0];
  bot.perceive(true);
  for (const id of bot.known.keys()) assert.ok(bot.canSee(room.items.get(id)), 'remembers only what it saw');
  const unseen = [...room.items.values()].filter(i => i.state === 'floor' && !bot.canSee(i));
  assert.ok(unseen.length > 0, 'some of the house is out of sight from the yard');
  for (let i = 0; i < 20; i++) {
    const t = bot.chooseTarget();
    if (t) assert.ok(bot.known.has(t.id), `targeted ${t.type} it never saw`);
  }
});

test('sabotage: a crew bot that did not see the crunch cannot name the saboteur', () => {
  const { room, join } = makeRoom({ game: 'sabotage', seed: 3333 });
  const a = join('A', 'Ada'); join('B', 'Bo'); room.addBot();
  room.startRound();
  for (const p of room.players.values()) p.saboteur = p.id === 'A';
  const bot = [...room.bots.values()][0];
  bot.setDifficulty('hard');
  // the bot is deep in the house behind walls; Ada is at the truck
  const far = room.level.rooms.reduce((m, r) => (r.x0 + r.x1) / 2 < (m.x0 + m.x1) / 2 ? r : m);
  bot.p.x = (far.x0 + far.x1) / 2; bot.p.z = (far.z0 + far.z1) / 2;
  a.x = 11.2; a.z = 0;
  const box = [...room.items.values()].find(i => i.type === 'fragile');
  assert.ok(!bot.canSeePoint(a.x, a.z), 'setup: Ada is out of sight');
  for (let i = 0; i < 10; i++) room.recordBreak(box, ['A'], 'got crushed');
  assert.ok((bot.sus.A || 0) < 1, `blind bot suspects Ada at ${bot.sus.A}`);
  assert.equal(bot.calloutAt, null, 'no meeting called on a hunch');

  // now it watches it happen
  bot.p.x = 8.5; bot.p.z = 0.5;
  assert.ok(bot.canSeePoint(a.x, a.z), 'setup: Ada in plain view');
  for (let i = 0; i < 3; i++) room.recordBreak(box, ['A'], 'got crushed');
  assert.ok((bot.sus.A || 0) >= 1, 'a witness remembers');
});

test('classic meetings: bots vote on what they saw, not on hidden culprit data', () => {
  const { room, join } = makeRoom({ level: 'classic' });
  join('A', 'Ada'); join('B', 'Bo'); room.addBot();
  room.startRound();
  const bot = [...room.bots.values()][0];
  bot.rng = mulberryFor(9);
  room.players.get('A').x = 11.2; room.players.get('A').z = 0;
  const far = room.level.rooms.reduce((m, r) => (r.x0 + r.x1) / 2 < (m.x0 + m.x1) / 2 ? r : m);
  bot.p.x = (far.x0 + far.x1) / 2; bot.p.z = (far.z0 + far.z1) / 2;
  const box = [...room.items.values()].find(i => i.type === 'fragile');
  room.recordBreak(box, ['A'], 'got crushed');
  let hits = 0;
  for (let i = 0; i < 300; i++) if (bot.meetingVote() === 'A') hits++;
  assert.ok(hits / 300 < 0.5, `blind bot picked the real culprit ${Math.round(hits / 3)}% of the time`);
});

test('AI forgets a remembered box once it sees it is already in the truck (no dithering at the edge of sight)', () => {
  const { room } = makeRoom({ seed: 9433 });
  room.addBot();
  room.startRound();
  const bot = [...room.bots.values()][0];
  const box = [...room.items.values()].find(i => i.type === 'standard');
  bot.p.x = 3.8; bot.p.z = 1.3;
  box.state = 'loaded'; box.x = 10.2; box.z = -2.4;               // in view, but in the truck
  bot.known.set(box.id, { x: 30, z: 30, at: 0 });                   // remembered somewhere it can't see
  assert.ok(bot.canSee(box) && !bot.canSeePoint(30, 30), 'setup');
  bot.perceive(true);
  assert.ok(!bot.known.has(box.id), 'seeing it in the truck clears the old memory');
  for (let i = 0; i < 10; i++) { const t = bot.chooseTarget(); assert.notEqual(t?.id, box.id); }
});

test('AI movers never loop in place (seeded houses that used to trap them)', () => {
  const rnd = Math.random; Math.random = mulberryFor(1);
  try {
    for (const [seed, diff] of [[9433, 'normal'], [9433, 'hard']]) {
      const { room } = makeRoom({ seed, dolly: true });
      for (let i = 0; i < 4; i++) room.addBot();
      for (const b of room.bots.values()) b.setDifficulty(diff);
      room.startRound();
      const hist = new Map();
      for (let t = 0; t < 120 && room.phase !== 'results'; t += DT) {
        room.tick(DT);
        if (room.phase !== 'playing') continue;
        for (const b of room.bots.values()) {
          const p = b.p, h = hist.get(p.id) || []; h.push({ t, x: p.x, z: p.z, mv: Math.abs(p.in.mx) + Math.abs(p.in.mz) > 0.05 });
          while (h.length && t - h[0].t > 10) h.shift(); hist.set(p.id, h);
          if (h.length < 190 || p.loadMode || p.task) continue;
          const item = p.carry && room.items.get(p.carry);
          if (item && item.carriers.length === 1 && item.type in { couch: 1, bed: 1, desk: 1, table: 1 }) continue; // waiting for a buddy is allowed
          const span = Math.max(Math.max(...h.map(q => q.x)) - Math.min(...h.map(q => q.x)), Math.max(...h.map(q => q.z)) - Math.min(...h.map(q => q.z)));
          const trying = h.filter(q => q.mv).length / h.length;
          assert.ok(!(span < 1.6 && trying > 0.6), `${diff}: ${p.name} looped at ${p.x.toFixed(1)},${p.z.toFixed(1)} around ${t.toFixed(0)}s`);
        }
      }
    }
  } finally { Math.random = rnd; }
});

test('AI answers a 🆘: the nearest free bot heads for the other end and says so', () => {
  const { room, join } = makeRoom({ level: 'classic' });
  const a = join('A', 'Ada');
  for (let i = 0; i < 3; i++) room.addBot();
  for (const b of room.bots.values()) b.setDifficulty('hard');
  room.startRound();
  while (room.phase !== 'playing') room.tick(DT);
  const couch = [...room.items.values()].find(i => i.type === 'couch');
  couch.wrapped = true; couch.state = 'carried'; couch.carriers = ['A']; a.carry = couch.id; a.x = couch.x; a.z = couch.z;
  const chats = []; room.broadcast = (t, m) => { if (t === 'chat') chats.push(m); };
  assert.ok(room.helpPing(a));
  const helpers = [...room.bots.values()].filter(b => b.targetId === couch.id);
  assert.equal(helpers.length, 1, 'one bot answers');
  assert.ok(chats.some(c => c.bot && /way|coming|grab/i.test(c.text)));
  for (let t = 0; t < 25 && couch.carriers.length < 2; t += DT) room.tick(DT);
  assert.equal(couch.carriers.length, 2, 'the bot made it and lifted the other end');
});

test('AI picks up the piece it walked to, not the couch right behind it', () => {
  const { room } = makeRoom({ level: 'classic' });
  room.addBot(); room.addBot();
  room.startRound();
  while (room.phase !== 'playing') room.tick(DT);
  const [b] = room.bots.values();
  const couch = [...room.items.values()].find(i => i.type === 'couch');
  const ct = [...room.items.values()].find(i => i.type === 'standard');
  // a box sitting just in front of the couch, the bot standing between them, closer to the couch
  ct.x = couch.x; ct.z = couch.z + 1.4; b.p.x = couch.x; b.p.z = couch.z + 0.75;
  b.known.set(ct.id, { x: ct.x, z: ct.z, at: 0 }); b.targetId = ct.id; b.waitT = 0;
  b.chooseTarget = () => ct;
  for (let i = 0; i < 6 && !b.p.carry; i++) room.tick(DT);
  assert.equal(b.p.carry, ct.id, 'took the box it was going for');
});

test('AI eyesight never passes through a wall, even at a glancing angle or a wall corner', () => {
  for (const seed of [11, 222, 3333, 40404]) {
    const { room } = makeRoom({ seed });
    room.addBot(); room.startRound();
    const bot = [...room.bots.values()][0];
    bot.cfg = { ...bot.cfg, sight: 40 };
    const L = room.level, rng = mulberryFor(seed);
    const walls = L.houseWalls;
    const crosses = (ax, az, bx, bz) => { // fine reference check: any point on the line inside a wall
      const n = Math.ceil(Math.hypot(bx - ax, bz - az) / 0.01);
      for (let i = 1; i < n; i++) { const x = ax + (bx - ax) * i / n, z = az + (bz - az) * i / n; if (walls.some(w => x > w.x0 && x < w.x1 && z > w.z0 && z < w.z1)) return true; }
      return false;
    };
    const h = L.house;
    for (let k = 0; k < 400; k++) {
      const ax = h.x0 + rng() * (h.x1 - h.x0), az = h.z0 + rng() * (h.z1 - h.z0), bx = h.x0 + rng() * (h.x1 - h.x0), bz = h.z0 + rng() * (h.z1 - h.z0);
      if (L.hitsWall(ax, az, 0.45) || L.hitsWall(bx, bz, 0.05)) continue;
      bot.p.x = ax; bot.p.z = az;
      if (crosses(ax, az, bx, bz)) assert.ok(!bot.canSeePoint(bx, bz), `seed ${seed}: saw through a wall from ${ax.toFixed(2)},${az.toFixed(2)} to ${bx.toFixed(2)},${bz.toFixed(2)}`);
    }
  }
});

test('AI cannot tell a box\'s type until it picks it up: swapping box types never changes which one it goes for', () => {
  for (const seed of [222, 3333, 40404]) {
    const { room } = makeRoom({ seed });
    room.addBot(); room.startRound();
    const bot = [...room.bots.values()][0];
    bot.setDifficulty('hard');
    bot.perceive(true);
    for (const it of room.items.values()) if (it.state === 'floor') bot.known.set(it.id, { x: it.x, z: it.z, at: 0 });
    const boxes = [...room.items.values()].filter(i => ['standard', 'heavy', 'fragile'].includes(i.type));
    const pickWith = () => { bot.rng = mulberryFor(seed); return bot.chooseTarget()?.id; };
    const before = pickWith();
    const cycle = { standard: 'heavy', heavy: 'fragile', fragile: 'standard' };
    for (const b of boxes) b.type = cycle[b.type];
    assert.equal(pickWith(), before, `seed ${seed}: the choice changed when only the hidden box types changed`);
  }
});

test('AI never follows the level\'s known-perfect packing plan, even in Full load', () => {
  const { room } = makeRoom({ seed: 77 });
  room.mode = 'load'; room.newLevel(false); room.resetWorld();
  room.addBot(); room.startRound();
  const bot = [...room.bots.values()][0];
  assert.ok(room.level.solution, 'setup: a Full load house has a perfect plan');
  assert.equal(bot.plan(), null);
});
