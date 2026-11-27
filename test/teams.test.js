// Team mode: the crew chief picks off / 2 / 3 teams; teams stay even; one shared truck; a team scores its members' total;
// teammates can't steal from each other.
import test from 'node:test';
import assert from 'node:assert/strict';
import { MoveRoom } from '../server/MoveRoom.js';

const DT = 0.05;
function makeRoom(opts = {}) {
  const room = new MoveRoom(), handlers = {};
  room.onMessage = (t, fn) => { handlers[t] = fn; }; room.setSimulationInterval = () => {}; room.clients = []; room.broadcast = () => {};
  room.onCreate({ level: 'classic', dolly: false, ...opts });
  const join = (id) => { room.clients.push({ sessionId: id, send: () => {} }); room.onJoin({ sessionId: id }, {}, { name: id, email: id + '@x.io' }); return room.players.get(id); };
  const send = (id, t, m) => handlers[t]({ sessionId: id }, m);
  return { room, join, send };
}
const sizes = (room) => { const c = {}; for (const p of room.movers()) c[p.team] = (c[p.team] || 0) + 1; return c; };

test('teams: the crew chief turns on 2 teams; humans and AI are dealt out evenly', () => {
  const { room, join, send } = makeRoom();
  join('A'); join('B'); join('C');
  send('A', 'addBot');
  send('B', 'teams', { n: 2 });
  assert.equal(room.teamN, 0, 'only the crew chief decides');
  send('A', 'teams', { n: 2 });
  assert.equal(room.teamN, 2);
  assert.deepEqual(sizes(room), { 1: 2, 2: 2 });
  assert.ok(room.snapshot().players.every(p => p.team === 1 || p.team === 2));
  assert.equal(room.snapshot().teams.length, 2);
});

test('teams: three teams need a crew of six; dropping the crew size falls back to two', () => {
  const { room, join, send } = makeRoom();
  join('A');
  send('A', 'teams', { n: 3 });
  assert.equal(room.teamN, 0, 'crew of 4: no three teams');
  send('A', 'crew', { size: 6 });
  for (let i = 0; i < 5; i++) send('A', 'addBot');
  send('A', 'teams', { n: 3 });
  assert.equal(room.teamN, 3);
  assert.deepEqual(sizes(room), { 1: 2, 2: 2, 3: 2 });
  send('A', 'crew', { size: 4 });
  assert.equal(room.teamN, 2);
  room.tick(DT);
  assert.deepEqual(sizes(room), { 1: 2, 2: 2 });
});

test('teams: switching sides is allowed when it keeps teams even, and swaps an AI mover over if needed', () => {
  const { room, join, send } = makeRoom();
  const A = join('A'), B = join('B');
  send('A', 'addBot'); send('A', 'addBot');
  send('A', 'teams', { n: 2 });
  const other = A.team === 1 ? 2 : 1;
  send('A', 'team', { t: other });
  assert.equal(A.team, other, 'an AI mover swapped sides to make room');
  assert.deepEqual(sizes(room), { 1: 2, 2: 2 });
  // two humans on one side and nobody to swap: refused
  B.team = A.team; for (const p of room.movers()) if (p.bot) p.team = A.team === 1 ? 2 : 1;
  send('B', 'team', { t: A.team === 1 ? 2 : 1 });
  assert.equal(B.team, A.team === 1 ? 2 : 1, 'a bot swaps back');
});

test('teams: one shared truck; team totals decide the winner; players on the winning team win', () => {
  const { room, join, send } = makeRoom();
  const A = join('A'), B = join('B'), C = join('C'), D = join('D');
  send('A', 'teams', { n: 2 });
  send('A', 'start'); for (const p of [B, C, D]) p.ready = true; send('A', 'start');
  for (let i = 0; i < 80 && room.phase !== 'playing'; i++) room.tick(DT);
  assert.equal(room.phase, 'playing');
  const t1 = room.movers().filter(p => p.team === 1), t2 = room.movers().filter(p => p.team === 2);
  t1[0].score = 50; t1[1].score = 10; t2[0].score = 45; t2[1].score = 5; // 60 vs 50: team 1 wins though t2 has no top scorer
  room.finishRound("Time's up!");
  const r = room.results;
  assert.equal(r.winTeam, 1);
  assert.equal(r.teams[0].score, 60); assert.equal(r.teams[1].score, 50);
  assert.equal(room.players.get(r.winnerId).team, 1, 'the named winner is on the winning team');
});

test('teams: a tie means no team wins', () => {
  const { room, join, send } = makeRoom();
  const A = join('A'), B = join('B');
  send('A', 'teams', { n: 2 }); B.ready = true; send('A', 'start');
  for (let i = 0; i < 80 && room.phase !== 'playing'; i++) room.tick(DT);
  A.score = 20; B.score = 20;
  room.finishRound("Time's up!");
  assert.equal(room.results.winTeam, null); assert.equal(room.results.winnerId, null);
});

test('teams: no tap battles against your own teammate; the other team is fair game', () => {
  const { room, join, send } = makeRoom();
  const A = join('A'), B = join('B'), C = join('C'), D = join('D');
  send('A', 'teams', { n: 2 }); for (const p of [B, C, D]) p.ready = true; send('A', 'start');
  for (let i = 0; i < 80 && room.phase !== 'playing'; i++) room.tick(DT);
  const mate = room.movers().find(p => p !== A && p.team === A.team), foe = room.movers().find(p => p.team !== A.team);
  const boxes = [...room.items.values()].filter(i => i.type === 'standard' && i.state === 'floor');
  for (const [who, box] of [[mate, boxes[0]], [foe, boxes[1]]]) { box.state = 'carried'; box.carriers = [who.id]; who.carry = box.id; }
  for (const it of room.items.values()) if (it.state === 'floor') it.x += 40; // nothing else in reach
  mate.x = boxes[0].x = 3; mate.z = boxes[0].z = 3; A.x = 3.5; A.z = 3;
  room.startDuel(A, boxes[0]);
  assert.ok(!room.duels.size, 'no fighting your teammate');
  foe.x = boxes[1].x = 3.4; foe.z = boxes[1].z = 3.4;
  room.startDuel(A, boxes[1]);
  assert.ok(room.duels.get(boxes[1].id), 'battle with the other team');
  send('A', 'game', { game: 'sabotage' });
});

test('teams: sabotage turns teams off', () => {
  const { room, join, send } = makeRoom();
  join('A');
  send('A', 'teams', { n: 2 });
  send('A', 'game', { game: 'sabotage' });
  assert.equal(room.teamN, 0);
  send('A', 'teams', { n: 2 });
  assert.equal(room.teamN, 0, 'not while sabotage is picked');
});
