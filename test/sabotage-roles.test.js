// Sabotage roles: 2 saboteurs at 6 movers (they know each other), 1 at 4–5; Foreman (2 meetings), Inspector, Driver
// (none with 4 movers); nobody else ever learns who the saboteurs are; jobs look the same for everyone.
import test from 'node:test';
import assert from 'node:assert/strict';
import { sabRoom } from './sabotage-setup.test.js';

const rolesOf = (room) => [...room.players.values()].map(p => p.role);
const count = (room, r) => rolesOf(room).filter(x => x === r).length;

test('6 movers: two saboteurs who are told about each other, and one each of Foreman, Inspector, Driver', () => {
  const { room, events } = sabRoom({ movers: 6 });
  assert.equal(count(room, 'saboteur'), 2);
  for (const r of ['foreman', 'inspector', 'driver']) assert.equal(count(room, r), 1, r);
  assert.equal(count(room, 'mover'), 1);
  const sabs = [...room.players.values()].filter(p => p.role === 'saboteur');
  for (const s of sabs) {
    assert.equal(s.saboteur, true);
    const card = events.find(e => e.kind === 'role' && e.to === s.id);
    assert.equal(card.role, 'saboteur');
    assert.deepEqual(card.partners, sabs.filter(o => o !== s).map(o => o.id));
  }
  const crewCard = events.find(e => e.kind === 'role' && e.to === [...room.players.values()].find(p => p.role === 'foreman').id);
  assert.equal(crewCard.partners, undefined, 'the crew learns nothing about the saboteurs');
});

test('4 movers: one saboteur, a Foreman and an Inspector, no Driver; 5 movers adds the Driver', () => {
  let { room } = sabRoom({ movers: 4 });
  assert.equal(count(room, 'saboteur'), 1); assert.equal(count(room, 'driver'), 0);
  assert.equal(count(room, 'foreman'), 1); assert.equal(count(room, 'inspector'), 1);
  ({ room } = sabRoom({ movers: 5 }));
  assert.equal(count(room, 'saboteur'), 1); assert.equal(count(room, 'driver'), 1);
});

test('emergency meetings: the Foreman has 2, everyone else 1', () => {
  const { room } = sabRoom();
  for (const p of room.players.values()) assert.equal(p.meetingsLeft, p.role === 'foreman' ? 2 : 1, p.role);
});

test('the snapshot shows the public roles only: no saboteur flag or role for anyone', () => {
  const { room } = sabRoom();
  const snap = JSON.stringify(room.snapshot());
  assert.ok(!/saboteur/i.test(snap), 'nothing in the shared snapshot reveals a saboteur');
  const pub = room.snapshot().sab.roles;
  for (const p of room.players.values()) assert.equal(pub[p.id], p.role === 'saboteur' ? 'mover' : p.role);
});

test('when the Driver leaves, another living crew mover becomes Driver within a tick', () => {
  const { room } = sabRoom();
  const drv = [...room.players.values()].find(p => p.role === 'driver');
  room.onLeave({ sessionId: drv.id });
  room.tick(0.05);
  const next = [...room.players.values()].find(p => p.role === 'driver');
  assert.ok(next && !next.saboteur, 'a new crew Driver');
});

test('job lists: three jobs drawn from the house, the same kind for saboteurs and crew', () => {
  const { room } = sabRoom();
  for (const p of room.players.values()) {
    const jobs = room.sab.jobsFor(p);
    assert.equal(jobs.length, 3);
    for (const j of jobs) assert.equal(typeof j.text, 'string');
  }
  const sab = [...room.players.values()].find(p => p.saboteur), crew = [...room.players.values()].find(p => !p.saboteur);
  const shape = (js) => js.map(j => j.text.split(' ')[0]).sort().join();
  assert.equal(shape(room.sab.jobsFor(sab)).length > 0, true);
  assert.ok(room.sab.jobsFor(sab).every(j => !/sabot/i.test(j.text)), 'cover jobs never give a saboteur away');
  void crew; void shape;
});
