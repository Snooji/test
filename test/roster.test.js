import test from 'node:test';
import assert from 'node:assert/strict';
import { MoveRoom } from '../server/MoveRoom.js';
import { ROSTER, ALL_CHAR_IDS, charUnlocked, unlockText, CLASSIC_IDS } from '../shared/roster.js';

function makeRoom() {
  const room = new MoveRoom();
  const handlers = {}, sent = [];
  room.onMessage = (type, fn) => { handlers[type] = fn; };
  room.setSimulationInterval = () => {};
  room.broadcast = () => {};
  room.clients = [];
  room.onCreate({ dolly: false });
  const join = (id, opts = {}) => {
    room.clients.push({ sessionId: id, send: (t, m) => sent.push({ to: id, ...m }) });
    room.onJoin({ sessionId: id }, opts, { name: id, email: id + '@x.io' });
    return room.players.get(id);
  };
  return { room, join, send: (id, type, msg) => handlers[type]({ sessionId: id }, msg), sent };
}

test('roster: unique ids, names, and every unlock is readable', () => {
  assert.equal(new Set(ALL_CHAR_IDS).size, ALL_CHAR_IDS.length);
  assert.equal(new Set(ROSTER.map(r => r.name)).size, ROSTER.length);
  for (const r of ROSTER) if (r.unlock) assert.match(unlockText(r.id), /^(Play|Win|Load) \d+/);
  for (const id of CLASSIC_IDS) assert.ok(charUnlocked(id, null));
  assert.ok(ROSTER.filter(r => !r.unlock).length >= 3, 'a few free voxel movers to start with');
});

test('roster: free voxel movers can be picked; locked ones are refused with a hint', () => {
  const { room, join, send, sent } = makeRoom();
  const a = join('A');
  send('A', 'char', { id: 'c04' });               // Atlas: free
  assert.equal(a.char, 'c04');
  send('A', 'char', { id: 'v19' });               // Noir: load 100 items
  assert.equal(a.char, 'c04', 'locked mover not taken');
  assert.ok(sent.some(m => m.to === 'A' && /unlocks when you load 100 items/i.test(m.text)));
  send('A', 'char', { id: 'not-a-mover' });
  assert.equal(a.char, 'c04');
});

test('roster: stats unlock movers; two players can never share one', () => {
  const { room, join, send } = makeRoom();
  const a = join('A'), b = join('B');
  a.profile = { games: 5, wins: 0, loaded: 0 };
  send('A', 'char', { id: 'v20' });               // Stella: play 5 moves
  assert.equal(a.char, 'v20');
  b.profile = { games: 50, wins: 50, loaded: 500 };
  send('B', 'char', { id: 'v20' });
  assert.notEqual(b.char, 'v20', 'already taken');
});

test('roster: joining with a locked mover falls back until the profile proves it', async () => {
  const store = { getProfile: async () => ({ games: 0, wins: 0, loaded: 0 }) };
  MoveRoom.store = store;
  try {
    const { join } = makeRoom();
    const a = join('A', { char: 'v00' });         // Gramps Gravity: win 10
    await new Promise(r => setTimeout(r, 0));
    assert.ok(CLASSIC_IDS.includes(a.char), `got ${a.char}`);
    store.getProfile = async () => ({ games: 30, wins: 12, loaded: 0 });
    const r2 = makeRoom();
    const b = r2.join('B', { char: 'v00' });
    await new Promise(r => setTimeout(r, 0));
    assert.equal(b.char, 'v00', 'unlocked by their saved stats');
    const c = r2.join('C', { char: 'c03' });      // free voxel mover is granted straight away
    assert.equal(c.char, 'c03');
  } finally { MoveRoom.store = null; }
});
