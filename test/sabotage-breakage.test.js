// Sabotage: breakage is permanent. Fragile boxes are lost; standard/heavy boxes burst into a pile you can repack (marked
// fragile, full value within 10 s, fading to half by 40 s); furniture that falls off a dolly is damaged (half value).
import test from 'node:test';
import assert from 'node:assert/strict';
import { sabRoom } from './sabotage-setup.test.js';
import { ITEM_TYPES } from '../shared/logic.js';

const DT = 0.05;
const tick = (room, secs) => { for (let t = 0; t < secs - 1e-6; t += DT) room.tick(DT); };
function packed(room, type, x, z) { return room.sab.newItem(type, x, z, { shownType: type, room: room.sab.roomAt(x, z) }); }
function roomCentre(room) { const ri = [...room.sab.total.keys()][0], r = room.level.rooms[ri]; return { x: (r.x0 + r.x1) / 2, z: (r.z0 + r.z1) / 2 }; }

test('the house is worth all its furniture plus every box it will hold', () => {
  const { room } = sabRoom();
  let v = 0;
  for (const it of room.items.values()) if (!ITEM_TYPES[it.type].tool) v += ITEM_TYPES[it.type].pts;
  for (const bag of room.sab.bags.values()) for (const t of bag) v += ITEM_TYPES[t].pts;
  assert.equal(room.sab.houseValue, v);
  assert.equal(room.sab.lostValue, 0);
});

test('a broken fragile box is gone for good and its value is lost', () => {
  const { room } = sabRoom();
  const c = roomCentre(room), box = packed(room, 'fragile', c.x, c.z);
  room.respawn(box);
  assert.equal(room.items.has(box.id), false);
  assert.equal(room.sab.lostValue, ITEM_TYPES.fragile.pts);
});

test('a burst standard box leaves a pile on a walkable spot, never inside a wall', () => {
  const { room } = sabRoom();
  const w = room.level.houseWalls.find(w => !w.rail), x = (w.x0 + w.x1) / 2, z = (w.z0 + w.z1) / 2;
  const box = packed(room, 'standard', x, z);
  room.respawn(box);
  const pile = [...room.items.values()].find(i => i.type === 'pile');
  assert.ok(pile, 'a pile');
  assert.equal(pile.contents, 'standard');
  assert.equal(room.level.hitsWall(pile.x, pile.z, 0.4), false, `pile at ${pile.x},${pile.z}`);
  assert.equal(room.sab.lostValue, 0, 'nothing lost yet');
});

function repackAt(room, P, ageSecs) {
  const c = roomCentre(room), box = packed(room, 'standard', c.x, c.z);
  room.respawn(box);
  const pile = [...room.items.values()].find(i => i.type === 'pile');
  tick(room, ageSecs);
  const a = P(0), st = room.items.get('flatstack');
  a.x = st.x + 0.4; a.z = st.z; a.pending.tapN = 1; room.tick(DT);
  a.x = pile.x + 0.5; a.z = pile.z;
  a.in.hold = true; tick(room, 5.1);
  return [...room.items.values()].find(i => i.repacked);
}

test('repacked within 10 s: a fragile-marked box worth the full standard value', () => {
  const { room, P } = sabRoom();
  const b = repackAt(room, P, 0);
  assert.ok(b, 'repacked');
  assert.equal(b.type, 'fragile');
  assert.equal(ITEM_TYPES.fragile.pts * b.value, ITEM_TYPES.standard.pts);
  assert.equal(room.sab.lostValue, 0);
  assert.ok(![...room.items.values()].some(i => i.type === 'pile'), 'the pile is gone');
});

test('repacked at 25 s: worth three quarters, the rest is lost', () => {
  const { room, P } = sabRoom();
  const b = repackAt(room, P, 25 - 5.1);
  assert.ok(Math.abs(ITEM_TYPES.fragile.pts * b.value - 0.75 * ITEM_TYPES.standard.pts) < 0.2, `worth ${ITEM_TYPES.fragile.pts * b.value}`);
  assert.ok(Math.abs(room.sab.lostValue - 0.25 * ITEM_TYPES.standard.pts) < 0.2, `lost ${room.sab.lostValue}`);
});

test('furniture that slides off the furniture dolly is damaged: half value, and it counts as lost', () => {
  const { room, P } = sabRoom();
  const a = P(0), fd = room.items.get('flatdolly');
  const piece = [...room.items.values()].find(i => ITEM_TYPES[i.type].furniture && !ITEM_TYPES[i.type].needsDisassemble);
  if (!fd || !piece) return; // a house without the dolly or a loadable piece: nothing to test
  a.x = fd.x; a.z = fd.z; a.pending.tapN = 1; room.tick(DT);
  assert.equal(a.flatDolly, fd.id);
  room.loadFlat?.(a, piece) ?? Object.assign(piece, { state: 'flat', flatId: fd.id }); fd.piece = piece.id;
  a.x = 2; a.z = 7; fd.x = 2.6; fd.z = 7; // out in the open yard, so it actually rolls
  fd.wobble = 0.99; a.in.mx = 1; a.in.mz = 0;
  for (let i = 0; i < 10 && fd.piece; i++) room.tick(DT);
  assert.equal(fd.piece, null, 'it slid off');
  assert.equal(piece.damaged, 'fell off the dolly');
  assert.equal(piece.value, 0.5);
  assert.equal(room.sab.lostValue, 0.5 * ITEM_TYPES[piece.type].pts);
});
