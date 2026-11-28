// Sabotage: witnesses get proof, the Inspector inspects, meetings (proof / reports / emergency), ghosts, frozen holds.
import test from 'node:test';
import assert from 'node:assert/strict';
import { sabRoom } from './sabotage-setup.test.js';
import { SAB, HOLD } from '../shared/sabotage.js';
import { FLOOR_DZ } from '../shared/level.js';

const DT = 0.05;
const tick = (room, secs) => { for (let t = 0; t < secs - 1e-6; t += DT) room.tick(DT); };
function setup(opts) {
  const r = sabRoom(opts);
  const all = [...r.room.players.values()];
  all.forEach((p, i) => { p.x = -40 - i * 3; p.z = -30; });
  return { ...r, sab: all.find(p => p.saboteur), crew: all.filter(p => !p.saboteur) };
}
const yard = { x: 4, z: 8.5 };
const packed = (room, type, x, z) => room.sab.newItem(type, x, z, { shownType: type, room: room.sab.roomAt(x, z) });
function cutTape(r, at = yard) { const box = packed(r.room, 'standard', at.x, at.z); r.sab.x = at.x + 0.5; r.sab.z = at.z; r.send(r.sab.id, 'sab'); tick(r.room, HOLD.cutTape + 0.1); return box; }
function vote(r, target) { for (const p of r.room.players.values()) if (r.room.isActive(p) && !p.ghost) r.send(p.id, 'vote', { target }); r.room.tick(DT); }

test('a crew mover with a clear view 5 m away gets proof; behind a wall, or in the dark, nobody does', () => {
  let r = setup(); const w = r.crew[0];
  w.x = yard.x - 4.5; w.z = yard.z;
  cutTape(r);
  assert.deepEqual(r.room.sab.proof.get(w.id)?.saboteurId, r.sab.id);
  // behind a wall: stand the saboteur and the witness on either side of an inside wall
  r = setup();
  const wall = r.room.level.houseWalls.find(x => !x.rail && (x.x1 - x.x0) < 0.5 && (x.z1 - x.z0) > 3);
  if (wall) {
    const cx = (wall.x0 + wall.x1) / 2, cz = (wall.z0 + wall.z1) / 2;
    const box = packed(r.room, 'standard', cx - 1.2, cz);
    r.sab.x = cx - 0.8; r.sab.z = cz; r.crew[0].x = cx + 1.5; r.crew[0].z = cz;
    r.send(r.sab.id, 'sab'); tick(r.room, HOLD.cutTape + 0.1);
    assert.equal(box.tampered, 'cut');
    assert.equal(r.room.sab.proof.has(r.crew[0].id), false, 'no seeing through walls');
  }
  // in the dark: sight drops to 2 m
  r = setup();
  const ri = [...r.room.sab.total.keys()].find(i => { const q = r.room.level.rooms[i]; return (q.x1 - q.x0) > 5 && (q.z1 - q.z0) > 4 && !q.storey; });
  if (ri !== undefined) {
    const q = r.room.level.rooms[ri], at = { x: q.x0 + 1.2, z: q.z0 + 1.2 };
    r.room.sab.dark.set(ri, 40);
    r.crew[0].x = at.x + 3.5; r.crew[0].z = at.z + 0.5;
    if (!r.room.level.lineBlocked(r.crew[0].x, r.crew[0].z, at.x + 0.5, at.z)) {
      cutTape(r, at);
      assert.equal(r.room.sab.proof.has(r.crew[0].id), false, 'too dark to see 3 m away');
    }
  }
});

test('proof calls a meeting any time: during the cooldown and with no emergency meetings left; everyone sees it', () => {
  const r = setup(), w = r.crew[0];
  w.x = yard.x - 4; w.z = yard.z; cutTape(r);
  w.meetingsLeft = 0; r.room.meetingCdUntil = (r.room.elapsed || 0) + 100;
  r.events.length = 0;
  r.room.callMeeting(w.id);
  assert.equal(r.room.phase, 'meeting');
  const ev = r.events.find(e => e.kind === 'meeting');
  assert.equal(ev.proof.saboteur, r.sab.name); assert.equal(ev.proof.witness, w.name);
  assert.equal(r.room.sab.proof.has(w.id), false, 'proof is used up');
});

test('without proof: an emergency meeting uses one up; none left and nothing to report means no meeting', () => {
  const r = setup(), m = r.crew[0];
  r.room.meetingCdUntil = 0; m.meetingsLeft = 1;
  r.room.callMeeting(m.id);
  assert.equal(r.room.phase, 'meeting'); assert.equal(m.meetingsLeft, 0);
  vote(r, 'skip'); tick(r.room, 1);
  r.room.meetingCdUntil = 0;
  r.room.callMeeting(m.id);
  assert.equal(r.room.phase, 'playing');
});

test('report: seeing a burst box lets you call a meeting, once per breakage', () => {
  const r = setup(), m = r.crew[0];
  const box = packed(r.room, 'fragile', yard.x, yard.z);
  m.x = yard.x - 2; m.z = yard.z; m.meetingsLeft = 0; r.room.meetingCdUntil = 0;
  r.room.sab.burst(box, 'burst open');
  r.room.callMeeting(m.id);
  assert.equal(r.room.phase, 'meeting');
  vote(r, 'skip'); tick(r.room, 1); r.room.meetingCdUntil = 0;
  r.room.callMeeting(m.id);
  assert.equal(r.room.phase, 'playing', 'already reported');
});

test('the Inspector inspects (role button, 2 s): finds the tampering and who last handled it, and fixes a mislabel', () => {
  const r = setup(), ins = r.crew.find(p => p.role === 'inspector');
  const box = cutTape(r);
  box.lastHandlers = [r.crew[1].id, r.sab.id];
  ins.x = yard.x + 0.6; ins.z = yard.z; r.events.length = 0;
  r.send(ins.id, 'sab'); tick(r.room, HOLD.inspect + 0.1);
  const res = r.events.find(e => e.kind === 'inspect' && e.to === ins.id);
  assert.ok(res && res.tampered === true, JSON.stringify(res));
  assert.deepEqual(res.lastHandlers, [r.crew[1].name, r.sab.name]);
  const fr = packed(r.room, 'fragile', yard.x + 3, yard.z); Object.assign(fr, { tampered: 'mislabel', shownType: 'standard' });
  ins.x = yard.x + 3.5; tick(r.room, SAB.INSPECT_COOLDOWN); r.send(ins.id, 'sab'); tick(r.room, HOLD.inspect + 0.1);
  assert.equal(fr.shownType, 'fragile'); assert.equal(fr.tampered, null);
});

test('voted out: crew become ghosts (half speed, no vote, no meetings, no inspecting, no witnessing); a saboteur is out', () => {
  const r = setup(), m = r.crew.find(p => p.role === 'mover') || r.crew[0];
  r.room.meetingCdUntil = 0; r.room.callMeeting(r.crew[1].id);
  vote(r, m.id);
  assert.equal(m.ghost, true); assert.equal(m.out, false);
  // half speed
  m.x = 2; m.z = 8; m.in.mx = 1; const x0 = m.x; tick(r.room, 1); const ghostD = m.x - x0; m.in.mx = 0;
  const o = r.crew.find(p => p !== m && !p.ghost); o.x = 2; o.z = 10; o.in.mx = 1; const ox = o.x; tick(r.room, 1); o.in.mx = 0;
  assert.ok(ghostD < (o.x - ox) * 0.6, `ghost ${ghostD.toFixed(2)} vs ${(o.x - ox).toFixed(2)}`);
  m.meetingsLeft = 1; r.room.meetingCdUntil = 0; r.room.callMeeting(m.id);
  assert.equal(r.room.phase, 'playing', 'ghosts call no meetings');
  m.x = yard.x - 3; m.z = yard.z; r.room.sab.cooldown.set(r.sab.id, 0); cutTape(r);
  assert.equal(r.room.sab.proof.has(m.id), false, 'ghosts witness nothing');
  // a saboteur voted out
  r.room.meetingCdUntil = 0; r.room.callMeeting(r.crew.find(p => !p.ghost).id);
  vote(r, r.sab.id);
  assert.equal(r.sab.out, true);
});

test('meetings freeze everything: a half-done pack job resumes afterwards, and lights-out time stands still', () => {
  const r = setup(), m = r.crew[0];
  const st = r.room.items.get('flatstack'); m.x = st.x + 0.4; m.z = st.z; m.pending.tapN = 1; r.room.tick(DT);
  const ri = [...r.room.sab.quota.entries()].find(([, n]) => n > 0)[0], q = r.room.level.rooms[ri];
  m.x = (q.x0 + q.x1) / 2; m.z = (q.z0 + q.z1) / 2 + FLOOR_DZ * (q.storey || 0); m.in.hold = true;
  tick(r.room, 4);
  const before = r.room.sab.packing.get(m.id).t;
  r.room.sab.dark.set(ri, 30);
  r.room.meetingCdUntil = 0; r.room.callMeeting(r.crew[1].id);
  tick(r.room, 5);
  assert.equal(r.room.sab.dark.get(ri), 30, 'paused');
  vote(r, 'skip'); r.room.tick(DT); r.room.tick(DT);
  assert.ok(r.room.sab.packing.get(m.id)?.t >= before, 'resumed, not restarted');
});
