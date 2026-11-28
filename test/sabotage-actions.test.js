// Sabotage actions (one button, the best target in reach, a short hold, 20 s cooldown) and their repairs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { sabRoom } from './sabotage-setup.test.js';
import { SAB, HOLD } from '../shared/sabotage.js';
import { ITEM_TYPES } from '../shared/logic.js';
import { FLOOR_DZ } from '../shared/level.js';

const DT = 0.05;
const tick = (room, secs) => { for (let t = 0; t < secs - 1e-6; t += DT) room.tick(DT); };
function setup(opts) {
  const r = sabRoom(opts);
  const sabs = [...r.room.players.values()].filter(p => p.saboteur), crew = [...r.room.players.values()].filter(p => !p.saboteur);
  // everyone stands far away out in the yard unless a test moves them (no accidental witnesses or partners)
  [...sabs, ...crew].forEach((p, i) => { p.x = -40 - i * 3; p.z = -30; });
  return { ...r, sab: sabs[0], crew };
}
const centre = (room) => { const ri = [...room.sab.total.keys()][0], r = room.level.rooms[ri]; return { ri, x: (r.x0 + r.x1) / 2, z: (r.z0 + r.z1) / 2 + FLOOR_DZ * (r.storey || 0) }; };
const yard = () => ({ x: 4, z: 8.5 }); // open ground between the house and the truck: nothing else in reach
const packed = (room, type, x, z) => room.sab.newItem(type, x, z, { shownType: type, room: room.sab.roomAt(x, z) });
const press = (room, p) => room.handlersSab(p);
function act(r, p, secs) { r.send(p.id, 'sab'); tick(r.room, secs); }

test('a crew mover pressing Sabotage does nothing', () => {
  const r = setup(), c = yard(), box = packed(r.room, 'standard', c.x, c.z), m = r.crew[0];
  m.x = c.x + 0.5; m.z = c.z; act(r, m, 3);
  assert.equal(box.tampered, undefined);
});

test('cut tape: the box bursts the next time anyone lifts it; re-taping (hold 2 s) fixes it', () => {
  const r = setup(), c = yard(), s = r.sab;
  const box = packed(r.room, 'standard', c.x, c.z);
  s.x = c.x + 0.5; s.z = c.z; act(r, s, HOLD.cutTape + 0.1);
  assert.equal(box.tampered, 'cut'); assert.equal(box.tell, 'tape');
  const m = r.crew[0]; m.x = c.x + 0.5; m.z = c.z; m.in.hold = true; tick(r.room, HOLD.retape + 0.1); m.in.hold = false;
  assert.equal(box.tampered, null, 're-taped');
  const box2 = packed(r.room, 'standard', c.x + 1, c.z);
  s.x = c.x + 1.5; s.z = c.z; m.x = -40; r.room.sab.cooldown.set(s.id, 0); act(r, s, HOLD.cutTape + 0.1);
  m.x = c.x + 1.4; m.z = c.z; m.pending.tapN = 1; r.room.tick(DT); r.room.tick(DT);
  assert.equal(r.room.items.has(box2.id), false, 'burst on lifting');
  assert.ok([...r.room.items.values()].some(i => i.type === 'pile'));
});

test('one sabotage every 20 s', () => {
  const r = setup(), c = yard(), s = r.sab;
  const a = packed(r.room, 'standard', c.x, c.z), b = packed(r.room, 'standard', c.x + 0.3, c.z);
  s.x = c.x + 0.5; s.z = c.z; act(r, s, 2);
  act(r, s, 2);
  assert.equal([a, b].filter(x => x.tampered).length, 1);
  tick(r.room, SAB.SAB_COOLDOWN);
  act(r, s, 2);
  assert.equal([a, b].filter(x => x.tampered).length, 2);
});

test('mislabel: a fragile box shows as standard to everyone (and the aim) but still crushes', () => {
  const r = setup(), c = yard(), s = r.sab;
  const box = packed(r.room, 'fragile', c.x, c.z);
  s.x = c.x + 0.5; s.z = c.z; act(r, s, HOLD.mislabel + 0.1);
  assert.equal(box.shownType, 'standard'); assert.equal(box.type, 'fragile');
  const snapItem = r.room.snapshot().items.find(i => i.id === box.id);
  assert.equal(snapItem.type, 'standard', 'the shared view shows the label');
  assert.equal(JSON.stringify(snapItem).includes('fragile'), false);
  // in the truck, the starting aim reads the label too (or it would quietly steer heavy boxes away and give it away)
  const m = r.crew[0]; box.state = 'carried'; box.carriers = [m.id]; m.carry = box.id; m.loadMode = true; m.cursor = { gx: 2, gz: 0, rot: 0 };
  r.room.dropIntoTruck(m, box); m.loadMode = false;
  assert.equal(r.room.aimGrid().items.get(box.id).type, 'standard');
  assert.equal(r.room.grid.items.get(box.id).type, 'fragile', 'the real grid still knows (so it still crushes)');
});

test('loosen a wheel: the furniture dolly wobbles 3× faster; one mover alone can\'t fix it, two can', () => {
  const r = setup(), fd = r.room.items.get('flatdolly'), s = r.sab;
  fd.x = 3; fd.z = 7; s.x = 3.5; s.z = 7; act(r, s, HOLD.loosen + 0.1);
  assert.equal(fd.loose, true); assert.equal(fd.tell, 'wheel');
  const [m1, m2] = r.crew;
  m1.x = 3.5; m1.z = 7.3; m1.in.hold = true; tick(r.room, HOLD.fixWheel + 1);
  assert.equal(fd.loose, true, 'one mover alone never finishes');
  m2.x = 3.4; m2.z = 6.6; m2.in.hold = true; tick(r.room, HOLD.fixWheel + 0.2);
  assert.equal(fd.loose, false);
});

test('snag the pads: wrapping that piece takes twice as long', () => {
  const r = setup(), s = r.sab;
  const piece = [...r.room.items.values()].find(i => ITEM_TYPES[i.type].needsWrap && !i.wrapped && i.state === 'floor');
  if (!piece) return;
  s.x = piece.x + 0.5; s.z = piece.z; act(r, s, HOLD.snag + 0.1);
  assert.equal(piece.snag, true); assert.equal(piece.tell, 'frayed');
});

test('stash the pads: nobody can wrap until someone refills them at the garage shelf', () => {
  const r = setup(), s = r.sab, crate = r.room.items.get('padcrate'), br = r.room.items.get('breaker');
  s.x = crate.x + 0.5; s.z = crate.z; act(r, s, HOLD.stashPads + 0.1);
  assert.ok(r.room.sab.padsOutT > 0);
  const piece = [...r.room.items.values()].find(i => ITEM_TYPES[i.type].needsWrap && !i.wrapped && i.state === 'floor');
  const m = r.crew[0];
  if (piece) { m.x = piece.x + 0.5; m.z = piece.z; m.in.hold = true; tick(r.room, 4); m.in.hold = false; assert.ok(!(piece.task?.progress > 0), 'no wrapping'); }
  m.x = br.x + 0.4; m.z = br.z; m.in.hold = true; tick(r.room, HOLD.refillPads + 0.1); m.in.hold = false;
  assert.equal(r.room.sab.padsOutT, 0);
});

test('lights out: the room goes dark for 40 s, the breaker brings the lights back', () => {
  const r = setup(), s = r.sab, c = centre(r.room), sw = r.room.sab.switchOf(c.ri);
  s.x = sw.x; s.z = sw.z; act(r, s, HOLD.lightsOut + 0.1);
  assert.ok(r.room.sab.dark.get(c.ri) > SAB.LIGHTS_OUT_S - 1);
  const br = r.room.items.get('breaker'), m = r.crew[0];
  m.x = br.x + 0.4; m.z = br.z; m.in.hold = true; tick(r.room, HOLD.breaker + 0.1);
  assert.equal(r.room.sab.dark.get(c.ri) || 0, 0);
});

test('pull from the truck: takes the top piece out, refused when a crew mover is near the ramp', () => {
  const r = setup(), s = r.sab, m = r.crew[0];
  const box = packed(r.room, 'standard', 11, 0);
  box.state = 'carried'; box.carriers = [m.id]; m.carry = box.id; m.loadMode = true; m.cursor = { gx: 0, gz: 0, rot: 0 };
  r.room.dropIntoTruck(m, box); m.loadMode = false; m.x = 11.2; m.z = 0;
  assert.equal(box.state, 'loaded');
  s.x = 10; s.z = 1.5; act(r, s, HOLD.pullTruck + 0.1);
  assert.equal(box.state, 'loaded', 'refused with a witness by the ramp');
  m.x = -40; r.room.sab.cooldown.set(s.id, 0); act(r, s, HOLD.pullTruck + 0.1);
  assert.equal(box.state, 'floor', 'pulled out');
});

test('weakened flat boxes: the next 3 taken are weak and a box packed from one sags', () => {
  const r = setup(), s = r.sab, st = r.room.items.get('flatstack');
  s.x = st.x + 0.4; s.z = st.z; act(r, s, HOLD.weaken + 0.1);
  assert.equal(r.room.sab.weakLeft, SAB.WEAK_BATCH);
  const m = r.crew[0]; m.x = st.x + 0.4; m.z = st.z; m.pending.tapN = 1; r.room.tick(DT);
  assert.equal(r.room.items.get(m.carry).weak, true);
  assert.equal(r.room.sab.weakLeft, SAB.WEAK_BATCH - 1);
});

test('nothing finishes during a meeting; a saboteur who leaves mid-hold leaves no effect', () => {
  const r = setup(), c = yard(), s = r.sab;
  const box = packed(r.room, 'standard', c.x, c.z);
  s.x = c.x + 0.5; s.z = c.z; r.send(s.id, 'sab'); r.room.tick(DT);
  const m = r.crew[0]; r.room.breaks.push({ id: 'x', type: 'standard', culpritIds: [], resolved: false, at: 0 });
  r.room.meetingCdUntil = 0; r.room.callMeeting(m.id);
  assert.equal(r.room.phase, 'meeting');
  for (let i = 0; i < 40; i++) r.room.tick(DT);
  assert.equal(box.tampered, undefined, 'frozen during the meeting');
  const r2 = setup(), c2 = yard(), box2 = packed(r2.room, 'standard', c2.x, c2.z);
  r2.sab.x = c2.x + 0.5; r2.sab.z = c2.z; r2.send(r2.sab.id, 'sab'); r2.room.tick(DT);
  r2.room.onLeave({ sessionId: r2.sab.id }); tick(r2.room, 3);
  assert.equal(box2.tampered, undefined);
});

test('the old bolt trick still works for saboteurs on desks and tables', () => {
  const r = setup(), s = r.sab;
  const desk = [...r.room.items.values()].find(i => i.assembled && i.state === 'floor');
  if (!desk) return;
  s.x = desk.x + 0.5; s.z = desk.z; s.in.hold = true; tick(r.room, 2);
  assert.ok(desk.jam > 0);
});

test('re-strap (Driver only): a wobbly top piece in the truck no longer topples at the drive-off', () => {
  const r = setup(), drv = r.crew.find(p => p.role === 'driver'), other = r.crew.find(p => p.role !== 'driver');
  if (!drv) return;
  // a lone tower 3 high in a corner column with nothing around it: the top piece would topple
  const ids = [];
  // a lone tower in the middle of the truck with a fragile box on top: that box would topple at the drive-off
  for (let k = 0; k < 4; k++) { const b = packed(r.room, k === 3 ? 'fragile' : 'standard', 11, 0); b.state = 'carried'; b.carriers = [other.id]; other.carry = b.id; other.loadMode = true; other.cursor = { gx: 1, gz: 1, rot: 0 }; r.room.dropIntoTruck(other, b); ids.push(b.id); }
  other.loadMode = false; other.x = -40;
  const before = r.room.sab.liveSafety();
  other.x = 11.2; other.z = 0; other.in.hold = true; tick(r.room, HOLD.restrap + 0.2); other.in.hold = false; other.x = -40;
  assert.equal(r.room.sab.liveSafety(), before, 'only the Driver can re-strap');
  drv.x = 11.2; drv.z = 0; drv.in.hold = true; tick(r.room, HOLD.restrap + 0.2);
  assert.ok(r.room.sab.liveSafety() > before, `${before} → ${r.room.sab.liveSafety()}`);
});
