// Sabotage endings: no clock. Saboteurs win at 35% of the house's value lost or by outnumbering the crew; the crew wins by
// voting out every saboteur, or when nothing is left in the house and the load drives off at 70% safety or better.
import test from 'node:test';
import assert from 'node:assert/strict';
import { sabRoom } from './sabotage-setup.test.js';
import { ITEM_TYPES } from '../shared/logic.js';

const DT = 0.05;
const tick = (room, secs) => { for (let t = 0; t < secs - 1e-6; t += DT) room.tick(DT); };
function setup(opts) { const r = sabRoom(opts); for (const [i, p] of [...r.room.players.values()].entries()) { p.x = -40 - i * 3; p.z = -30; } return r; }
/** everything left in the house is "in the truck" (as far as the house is concerned) and nothing is left to pack */
function emptyHouse(room) {
  for (const [ri] of room.sab.quota) room.sab.quota.set(ri, 0);
  for (const it of room.items.values()) if (!ITEM_TYPES[it.type].tool) it.state = 'loaded';
}
const finish = (room) => { for (let i = 0; i < 400 && room.phase !== 'results'; i++) room.tick(DT); };

test('no clock: running out of time never ends a sabotage round', () => {
  const { room } = setup();
  room.timeLeft = 0.01; tick(room, 2);
  assert.equal(room.phase, 'playing');
});

test('nothing left to load: the truck drives off even with empty slots (10 boxes were lost), and the crew wins at 70%+', () => {
  const { room } = setup();
  room.sab.lostValue = 100; // ten standard boxes broke and are gone (under the 35% line)
  emptyHouse(room);
  assert.equal(room.sab.houseEmpty(), true);
  room.tick(DT);
  assert.equal(room.phase, 'driveoff', 'the truck closes up and drives off');
  finish(room);
  assert.equal(room.results.winners, 'crew');
  assert.ok(room.results.sabotage.safety >= 70);
  assert.equal(room.results.sabotage.saboteurs.length, 2);
});

test('safety 69 at the drive-off: failed inspection, the saboteurs win; 70 passes', () => {
  let { room } = setup();
  emptyHouse(room); room.sab.liveSafety = () => 69; room.tick(DT); finish(room);
  assert.equal(room.results.winners, 'saboteur'); assert.match(room.results.reason, /Failed inspection/);
  ({ room } = setup());
  emptyHouse(room); room.sab.liveSafety = () => 70; room.tick(DT); finish(room);
  assert.equal(room.results.winners, 'crew');
});

test('losing 35% of the house\'s value ends it for the saboteurs at once', () => {
  const { room } = setup();
  room.sab.lostValue = 0.35 * room.sab.houseValue - 1; room.tick(DT);
  assert.equal(room.phase, 'playing');
  room.sab.lostValue += 1; room.tick(DT); finish(room);
  assert.equal(room.results.winners, 'saboteur'); assert.match(room.results.reason, /broken/);
});

test('voting out both saboteurs: the crew wins', () => {
  const { room } = setup();
  for (const p of room.players.values()) if (p.saboteur) p.out = true;
  room.tick(DT); finish(room);
  assert.equal(room.results.winners, 'crew'); assert.match(room.results.reason, /caught/);
});

test('crew movers leaving until the saboteurs match them: the saboteurs win that tick', () => {
  const { room } = setup(); // 2 saboteurs, 4 crew
  const crew = [...room.players.values()].filter(p => !p.saboteur);
  room.onLeave({ sessionId: crew[0].id }); room.tick(DT);
  assert.equal(room.phase, 'playing', '2 vs 3');
  crew[1].ghost = true; room.tick(DT); finish(room); // a ghost doesn't count as crew
  assert.equal(room.results.winners, 'saboteur'); assert.match(room.results.reason, /outnumber/);
});

test('the results name every saboteur and what they did', () => {
  const { room } = setup();
  room.sab.history.push({ by: [...room.players.values()].find(p => p.saboteur).id, action: 'cutTape', at: 30, x: 0, z: 0 });
  room.sab.lostValue = room.sab.houseValue; room.tick(DT); finish(room);
  const s = room.results.sabotage;
  assert.equal(s.saboteurs.length, 2); assert.ok(s.log.some(l => /cut/.test(l.text)));
  assert.equal(s.lossLine, 35); assert.equal(s.safetyLine, 70);
});
