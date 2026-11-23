// Procedural house generator. Deterministic from a seed, so the server and every
// browser build the identical house from just one number.
import { ITEM_TYPES, buildExactLoad, createGrid, placeItem } from './logic.js';
import { TRUCK_WALLS, HOUSE_WALLS, ROOMS, PROPS, ITEM_SPAWNS, CAT_WAYPOINTS, WORLD } from './world.js';

const T = 0.4; // wall thickness
const DOOR = 3.2;
const wallH = (x0, x1, z) => ({ x0, x1, z0: z - T / 2, z1: z + T / 2 });
const wallV = (x, z0, z1) => ({ x0: x - T / 2, x1: x + T / 2, z0, z1 });

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ROOM_NAMES = ['Living Room', 'Kitchen', 'Bedroom', 'Star Office', 'Kids Room', 'Dining Room', 'Game Room', 'Observatory', 'Laundry', 'Garage', 'Den', 'Library'];
const FLOORS = [0x3b3561, 0x2f4f5e, 0x4a3358, 0x33465e, 0x45385e, 0x2e5456, 0x503a4e, 0x3a4a6a];
const PREFIX = ['Crater', 'Nebula', 'Comet', 'Orbit', 'Lunar', 'Stardust', 'Galaxy', 'Meteor', 'Eclipse', 'Aurora'];
const SUFFIX = ['Ranch', 'Bungalow', 'Cottage', 'Villa', 'Duplex', 'Manor', 'Loft', 'Split-Level', 'Townhouse', 'Hideout'];

/** Attach collision + lookup helpers to plain level data. */
function finish(level) {
  const walls = level.walls;
  level.hitsWall = (x, z, r) => {
    for (const w of walls) {
      const cx = Math.max(w.x0, Math.min(x, w.x1)), cz = Math.max(w.z0, Math.min(z, w.z1));
      if ((x - cx) ** 2 + (z - cz) ** 2 < r * r) return true;
    }
    return false;
  };
  level.roomAt = (x, z) => level.rooms.find(r => x >= r.x0 && x <= r.x1 && z >= r.z0 && z <= r.z1)?.name || 'Yard';
  return level;
}

export function classicLevel() {
  return finish({
    seed: 0, name: 'Lunar Cul-de-Sac', classic: true,
    house: { x0: -22, x1: 0, z0: -12, z1: 12 }, yardDistance: 9.4,
    rooms: ROOMS.map(r => ({ ...r })), props: PROPS.map(p => ({ ...p })),
    walls: [...HOUSE_WALLS, ...TRUCK_WALLS], houseWalls: HOUSE_WALLS.map(w => ({ ...w })),
    items: ITEM_SPAWNS.map(i => [...i]), cat: CAT_WAYPOINTS.map(c => [...c]),
    frontDoor: { x: 0, z: -4 },
  });
}

export function generateLevel(seed, opts = {}) {
  const exact = !!opts.exact, mansion = !!opts.mansion;
  const rng = mulberry32(seed);
  const R = (a, b) => a + rng() * (b - a);
  const RI = (a, b) => Math.floor(R(a, b + 1));
  const pick = (arr) => arr[Math.floor(rng() * arr.length)];

  // ---- house footprint: size and distance to the truck vary ----
  const x1 = mansion ? RI(-6, 0) : RI(-8, 2);                 // right wall; the ramp starts at x=9.4
  const W = mansion ? RI(30, 32) : exact ? RI(24, 32) : RI(16, 30), D = mansion ? RI(22, 24) : exact ? RI(18, 24) : RI(14, 24);
  const x0 = x1 - W;
  let z0 = Math.round(R(-2, 2) - D / 2);
  z0 = Math.max(-13, Math.min(13 - D, z0));
  const z1 = z0 + D;

  // ---- split into rooms (BSP); every split wall gets one door, so all rooms connect ----
  const target = mansion ? 6 : RI(3, 6);
  let rooms, doors, innerWalls;
  for (let attempt = 0; attempt < 10; attempt++) {
    rooms = [{ x0, x1, z0, z1 }];
    doors = []; // {vertical, at, c} — wall line `at`, door centre `c`
    innerWalls = [];
    const blocked = (vertical, at, lo, hi) => doors.some(d => d.vertical !== vertical && at > d.c - DOOR / 2 - 0.8 && at < d.c + DOOR / 2 + 0.8 && d.at >= lo - 0.01 && d.at <= hi + 0.01);
    for (let guard = 0; rooms.length < target && guard < 40; guard++) {
      rooms.sort((a, b) => (b.x1 - b.x0) * (b.z1 - b.z0) - (a.x1 - a.x0) * (a.z1 - a.z0));
      const ri = rooms.findIndex(q => !q.done && (q.x1 - q.x0 >= 11 || q.z1 - q.z0 >= 11));
      if (ri < 0) break;
      const r = rooms[ri];
      const w = r.x1 - r.x0, d = r.z1 - r.z0;
      let vertical = w >= d; // split across the longer side
      if (rng() < 0.25 && Math.min(w, d) >= 11) vertical = !vertical; // sometimes the other way, for variety
      const lo = (vertical ? r.x0 : r.z0) + 5.5, hi = (vertical ? r.x1 : r.z1) - 5.5;
      let at = null;
      for (let t = 0; t < 12 && lo <= hi; t++) {
        const c = Math.round(R(lo, hi));
        // don't end a new wall inside an existing doorway
        if (!blocked(vertical, c, vertical ? r.z0 : r.x0, vertical ? r.z1 : r.x1)) { at = c; break; }
      }
      if (at === null) { r.done = true; continue; }
      const span0 = vertical ? r.z0 : r.x0, span1 = vertical ? r.z1 : r.x1;
      const c = R(span0 + DOOR / 2 + 0.8, span1 - DOOR / 2 - 0.8);
      doors.push({ vertical, at, c });
      if (vertical) {
        innerWalls.push(wallV(at, r.z0, c - DOOR / 2), wallV(at, c + DOOR / 2, r.z1));
        rooms.splice(ri, 1, { x0: r.x0, x1: at, z0: r.z0, z1: r.z1 }, { x0: at, x1: r.x1, z0: r.z0, z1: r.z1 });
      } else {
        innerWalls.push(wallH(r.x0, c - DOOR / 2, at), wallH(c + DOOR / 2, r.x1, at));
        rooms.splice(ri, 1, { x0: r.x0, x1: r.x1, z0: r.z0, z1: at }, { x0: r.x0, x1: r.x1, z0: at, z1: r.z1 });
      }
    }


    if (rooms.length >= 3) break;
  }

  // ---- outer walls with a front door facing the truck ----
  const fd = R(Math.max(z0, -9) + 2.5, Math.min(z1, 9) - 2.5);
  const houseWalls = [
    wallH(x0, x1, z0), wallH(x0, x1, z1), wallV(x0, z0, z1),
    wallV(x1, z0, fd - DOOR * 0.6), wallV(x1, fd + DOOR * 0.6, z1),
    ...innerWalls,
  ].filter(w => w.x1 - w.x0 > 0.05 && w.z1 - w.z0 > 0.05);

  // ---- name the rooms ----
  const names = [...ROOM_NAMES].sort(() => rng() - 0.5);
  const floors = [...FLOORS].sort(() => rng() - 0.5);
  rooms.sort((a, b) => (a.x0 - b.x0) || (a.z0 - b.z0));
  rooms.forEach((r, i) => { delete r.done; r.name = names[i % names.length]; r.floor = floors[i % floors.length]; });

  const level = finish({
    seed, exact, mansion, name: mansion ? `${pick(PREFIX)} Moon Mansion` : `${pick(PREFIX)} ${pick(SUFFIX)}`,
    house: { x0, x1, z0, z1 }, yardDistance: +(9.4 - x1).toFixed(1),
    rooms, walls: [...houseWalls, ...TRUCK_WALLS], houseWalls, props: [], items: [], cat: [],
    frontDoor: { x: x1, z: fd },
  });

  // ---- pick the inventory: Full load = exactly the 64 cells; otherwise fits with slack ----
  const size = (t) => { const it = ITEM_TYPES[t]; return it.cells ? it.cells.length : it.w * it.d * (it.h || 1); };
  let list = ['couch', 'bed'];
  if (rng() < 0.7) list.push('desk');
  if (rng() < 0.6) list.push('table');
  for (let i = RI(1, 2); i--;) list.push('lamp');
  for (let i = RI(4, 7); i--;) list.push('heavy');
  for (let i = RI(5, 8); i--;) list.push('fragile');
  for (let i = RI(8, 12); i--;) list.push('standard');
  while (list.reduce((a, t) => a + size(t), 0) > 52) list.splice(list.lastIndexOf('standard'), 1);
  if (exact) {
    const built = buildExactLoad(rng);
    list = built.pieces.sort((a, b) => size(b) - size(a)); // big pieces get first pick of space
    // remember the known-good packing: AI movers use it as their plan
    const g = createGrid();
    level.solution = built.solution.map(sl => {
      const r = placeItem(g, { id: sl.id, type: sl.type, wrapped: true }, sl.gx, sl.gz, sl.rot);
      const rec = g.items.get(sl.id);
      return { type: sl.type, gx: sl.gx, gz: sl.gz, rot: sl.rot, y: r.y, cells: rec.cells.map(([x, y, z]) => [sl.gx + x, r.y + y, sl.gz + z]) };
    });
  }

  // ---- scatter items: clear of walls, doors and each other ----
  const doorPts = [...doors.map(d => d.vertical ? { x: d.at, z: d.c } : { x: d.c, z: d.at }), level.frontDoor];
  const placed = [];
  const areaOf = (r) => (r.x1 - r.x0) * (r.z1 - r.z0);
  const totalArea = rooms.reduce((a, r) => a + areaOf(r), 0);
  const roomByArea = () => { let t = rng() * totalArea; for (const r of rooms) { t -= areaOf(r); if (t <= 0) return r; } return rooms[0]; };
  const yardBoxes = exact ? 0 : RI(1, 3);
  list.forEach((type, idx) => {
    const t = ITEM_TYPES[type];
    const big = Math.max(t.w, t.d);
    const halfX = t.furniture ? t.w / 2 + 0.7 : 0.9, halfZ = t.furniture ? t.d / 2 + 0.7 : 0.9;
    const inYard = !t.furniture && type === 'standard' && idx >= list.length - yardBoxes;
    for (let tries = 0; tries < (exact ? 160 : 80); tries++) {
      let x, z;
      const overflow = exact && tries >= 120 && !t.furniture; // a full house spills a few boxes onto the lawn
      if (inYard || overflow) { x = R(x1 + 2, 8); z = R(-12, 12); if (Math.abs(z) < 4 && x > 5) continue; }
      else { const r = roomByArea(); x = R(r.x0 + halfX, r.x1 - halfX); z = R(r.z0 + halfZ, r.z1 - halfZ); }
      x = Math.round(x * 10) / 10; z = Math.round(z * 10) / 10;
      if (!(inYard || overflow) && (x - halfX < x0 || x + halfX > x1 || z - halfZ < z0 || z + halfZ > z1)) continue;
      if (level.hitsWall(x, z, t.furniture ? big / 2 + 0.25 : 0.7)) continue;
      if (doorPts.some(p => Math.hypot(p.x - x, p.z - z) < 2.4 + (t.furniture ? big / 2 : 0))) continue;
      if (placed.some(([pt, px, pz]) => {
        const o = ITEM_TYPES[pt];
        return Math.abs(px - x) < (Math.max(o.w, 1) + Math.max(t.w, 1)) / 2 + 0.5 && Math.abs(pz - z) < (Math.max(o.d, 1) + Math.max(t.d, 1)) / 2 + 0.5;
      })) continue;
      placed.push([type, x, z]);
      return;
    }
    if (exact) { // never drop a piece of a Full load: scan the yard for any free spot
      for (let x = x1 + 2; x < 8.6; x += 1.2) for (let z = -13; z <= 13; z += 1.2) {
        if (Math.abs(z) < 3.4 && x > 5.4) continue;
        if (level.hitsWall(x, z, 0.7) || placed.some(([, px, pz]) => Math.hypot(px - x, pz - z) < 1.3)) continue;
        placed.push([type, +x.toFixed(1), +z.toFixed(1)]);
        return;
      }
    }
  });
  level.items = placed;

  // ---- decoration + cat route ----
  for (const r of rooms) {
    const w = r.x1 - r.x0, d = r.z1 - r.z0;
    level.props.push({ kind: 'rug', x: (r.x0 + r.x1) / 2, z: (r.z0 + r.z1) / 2, w: Math.min(5, w * 0.45), d: Math.min(3.5, d * 0.35), color: pick([0xe76f51, 0x8ecae6, 0xffd166, 0x9b5de5, 0x52d17c]) });
    // decorations never sit in a doorway (they're walk-through, but they look like they block it)
    const nearDoor = (x0, z0, x1, z1, pad) => doorPts.some(p => p.x > x0 - pad && p.x < x1 + pad && p.z > z0 - pad && p.z < z1 + pad);
    const corners = [[r.x0 + 0.9, r.z0 + 0.9], [r.x1 - 0.9, r.z0 + 0.9], [r.x0 + 0.9, r.z1 - 0.9], [r.x1 - 0.9, r.z1 - 0.9]];
    const first = RI(0, 3);
    const corner = [0, 1, 2, 3].map(k => corners[(first + k) % 4]).find(([cx, cz]) => !nearDoor(cx, cz, cx, cz, DOOR / 2 + 1.0));
    if (corner && !placed.some(([, px, pz]) => Math.hypot(px - corner[0], pz - corner[1]) < 1.5)) level.props.push({ kind: 'plant', x: corner[0], z: corner[1] });
    if (r.name === 'Kitchen' && Math.max(w, d) > 7) { // counter along the first wall with no doorway in its way
      const opts = [
        { x: (r.x0 + r.x1) / 2, z: r.z1 - 0.9, w: w * 0.6, d: 1.0 }, { x: (r.x0 + r.x1) / 2, z: r.z0 + 0.9, w: w * 0.6, d: 1.0 },
        { x: r.x0 + 0.9, z: (r.z0 + r.z1) / 2, w: 1.0, d: d * 0.6 }, { x: r.x1 - 0.9, z: (r.z0 + r.z1) / 2, w: 1.0, d: d * 0.6 },
      ].filter(c => Math.max(c.w, c.d) > 4);
      const c = opts.find(c => !nearDoor(c.x - c.w / 2, c.z - c.d / 2, c.x + c.w / 2, c.z + c.d / 2, DOOR / 2 + 0.9));
      if (c) level.props.push({ kind: 'counter', ...c, color: 0xdddddd });
    }
    level.cat.push([(r.x0 + r.x1) / 2, (r.z0 + r.z1) / 2]);
  }
  for (const p of doorPts) level.cat.push([p.x, p.z]);
  level.props.push({ kind: 'plant', x: x1 + 1.6, z: fd - 3 }, { kind: 'plant', x: x1 + 1.6, z: fd + 3 }, { kind: 'mailbox', x: Math.min(x1 + 5, 7), z: Math.max(-13, z0) + 1 });
  return level;
}

/** Training house: two small rooms and one of each thing to learn. */
export function tutorialLevel() {
  const houseWalls = [
    { x0: -14, x1: 0, z0: -7.2, z1: -6.8 }, { x0: -14, x1: 0, z0: 6.8, z1: 7.2 }, { x0: -14.2, x1: -13.8, z0: -7, z1: 7 },
    { x0: -0.2, x1: 0.2, z0: -7, z1: -1.9 }, { x0: -0.2, x1: 0.2, z0: 1.9, z1: 7 },
    { x0: -7.2, x1: -6.8, z0: -7, z1: -1.7 }, { x0: -7.2, x1: -6.8, z0: 1.7, z1: 7 },
  ];
  return finish({
    seed: 1, name: 'Training House', tutorial: true,
    house: { x0: -14, x1: 0, z0: -7, z1: 7 }, yardDistance: 9.4,
    rooms: [{ name: 'Front Room', x0: -7, x1: 0, z0: -7, z1: 7, floor: 0x3b3561 }, { name: 'Back Room', x0: -14, x1: -7, z0: -7, z1: 7, floor: 0x2f4f5e }],
    walls: [...houseWalls, ...TRUCK_WALLS], houseWalls,
    items: [['standard', -3, -4], ['heavy', -3, 4], ['fragile', -10.5, -4.5], ['lamp', -10.5, 4.5], ['couch', -10.5, 0]],
    props: [{ kind: 'rug', x: -3.5, z: 0, w: 4, d: 3, color: 0xe76f51 }, { kind: 'plant', x: -1, z: -6 }, { kind: 'plant', x: 1.6, z: -3 }, { kind: 'plant', x: 1.6, z: 3 }],
    cat: [[-3.5, 0], [-10.5, 2], [-3.5, 5]],
    frontDoor: { x: 0, z: 0 },
  });
}

/** A random free floor spot inside the house (for respawning broken items). */
export function freeSpot(level, taken, rng = Math.random) {
  for (let i = 0; i < 200; i++) {
    const r = level.rooms[Math.floor(rng() * level.rooms.length)];
    const x = r.x0 + 1.1 + rng() * (r.x1 - r.x0 - 2.2), z = r.z0 + 1.1 + rng() * (r.z1 - r.z0 - 2.2);
    if (level.hitsWall(x, z, 0.7) || taken.some(p => Math.hypot(p.x - x, p.z - z) < 1.2)) continue;
    return { x: +x.toFixed(1), z: +z.toFixed(1) };
  }
  return { x: level.frontDoor.x + 2.5, z: level.frontDoor.z };
}

/** Rebuild the server's house from the small description sent in every snapshot. */
export function levelFromSnapshot(lv) {
  if (lv.tutorial) return tutorialLevel();
  if (lv.classic) return classicLevel();
  const l = generateLevel(lv.seed, { exact: !!lv.exact, mansion: !!lv.mansion });
  if (lv.daily) l.daily = lv.daily;
  return l;
}

/** A fresh seed for the next round. */
export const newSeed = () => (Math.random() * 2 ** 31) >>> 0;
export { WORLD };
