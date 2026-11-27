// Procedural house generator. Deterministic from a seed, so the server and every
// browser build the identical house from just one number.
import { ITEM_TYPES, buildExactLoad, createGrid, placeItem } from './logic.js';
import { TRUCK_WALLS, HOUSE_WALLS, ROOMS, PROPS, ITEM_SPAWNS, CAT_WAYPOINTS, WORLD } from './world.js';
import { planHouse, buildWalls, ROOM_SIZES, T, DOOR } from './houseplan.js';
export { ROOM_SIZES };

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Floors: each floor k sits in its own strip of the server's flat map, shifted FLOOR_DZ·k along z; the browser stacks them STOREY_H apart. */
export const FLOOR_DZ = 40, STOREY_H = 2.8;
// stairwell: two side-by-side flights (switchback), each LANE_W wide between rails, with a landing at each end
// a landing 1.5 m deep leaves a walkable band (minus a mover's reach at each side) wider than the AI's 0.5 m path grid, wherever the
// stairwell lands; at 1.4 m some positions fell between grid points and the AI couldn't cross the landing
const LANE_W = 1.7, RAIL = 0.15, LANDING = 1.5;
const ROOM_NAMES = ['Living Room', 'Kitchen', 'Bedroom', 'Star Office', 'Kids Room', 'Dining Room', 'Game Room', 'Observatory', 'Laundry', 'Garage', 'Den', 'Library'];
const FLOORS = [0x3b3561, 0x2f4f5e, 0x4a3358, 0x33465e, 0x45385e, 0x2e5456, 0x503a4e, 0x3a4a6a];
const PREFIX = ['Crater', 'Nebula', 'Comet', 'Orbit', 'Lunar', 'Stardust', 'Galaxy', 'Meteor', 'Eclipse', 'Aurora'];
const SUFFIX = ['Ranch', 'Bungalow', 'Cottage', 'Villa', 'Duplex', 'Manor', 'Loft', 'Split-Level', 'Townhouse', 'Hideout'];

/** Attach collision + lookup helpers to plain level data. */
function finish(level) {
  const walls = level.walls;
  const n = level.floors = level.floors || 1;
  level.stairs = level.stairs || [];
  level.world = { ...WORLD, z1: WORLD.z1 + FLOOR_DZ * (n - 1) };
  /** which floor a server position is on (each floor has its own strip of the map) */
  level.floorOf = (z) => n === 1 ? 0 : Math.max(0, Math.min(n - 1, Math.round(z / FLOOR_DZ)));
  const lane = (st, x, zz) => x >= st.x0 && x <= st.x1 && zz >= Math.min(st.zl, st.zh) - 0.2 && zz <= Math.max(st.zl, st.zh) + 0.2;
  /** past the middle of a flight: +40 (up a floor) or −40 (down), else 0. A small dead band stops flicker on the line. */
  level.stairShift = (x, z) => {
    if (n === 1) return 0;
    const k = level.floorOf(z), zz = z - FLOOR_DZ * k;
    for (const st of level.stairs) {
      if (!lane(st, x, zz)) continue;
      const mid = (st.zl + st.zh) / 2, upSide = st.dir > 0 ? zz > mid + 0.05 : zz < mid - 0.05, downSide = st.dir > 0 ? zz < mid - 0.05 : zz > mid + 0.05;
      if (st.b === k && upSide) return FLOOR_DZ;
      if (st.b === k - 1 && downSide) return -FLOOR_DZ;
    }
    return 0;
  };
  /** on (or right at the foot of) a flight: dollies can't go there */
  level.onStairs = (x, z) => {
    if (n === 1) return false;
    const k = level.floorOf(z), zz = z - FLOOR_DZ * k;
    return level.stairs.some(st => (st.b === k || st.b === k - 1) && x > st.x0 - 0.3 && x < st.x1 + 0.3 && zz > Math.min(st.zl, st.zh) - 0.6 && zz < Math.max(st.zl, st.zh) + 0.6);
  };
  /** drawn height of a server position: its floor, plus how far up a flight it stands */
  level.renderY = (x, z) => {
    const k = level.floorOf(z);
    if (n === 1) return 0;
    const zz = z - FLOOR_DZ * k;
    for (const st of level.stairs) {
      if ((st.b !== k && st.b !== k - 1) || x < st.x0 || x > st.x1) continue;
      const lo = Math.min(st.zl, st.zh), hi = Math.max(st.zl, st.zh);
      if (zz < lo || zz > hi) continue;
      const t = st.dir > 0 ? (zz - st.zl) / (st.zh - st.zl) : (st.zh - zz) / (st.zh - st.zl);
      return STOREY_H * (st.b + t);
    }
    return STOREY_H * k;
  };
  level.hitsWall = (x, z, r) => {
    for (const w of walls) {
      const cx = Math.max(w.x0, Math.min(x, w.x1)), cz = Math.max(w.z0, Math.min(z, w.z1));
      if ((x - cx) ** 2 + (z - cz) ** 2 < r * r) return true;
    }
    return false;
  };
  /** exact: does the straight line from a to b pass through any wall (house, truck)? Slab test, so no glancing gaps. */
  level.lineBlocked = (ax, az, bx, bz) => {
    const dx = bx - ax, dz = bz - az;
    for (const w of walls) {
      if (w.invisible) continue;
      let t0 = 0, t1 = 1;
      for (const [p, d, lo, hi] of [[ax, dx, w.x0, w.x1], [az, dz, w.z0, w.z1]]) {
        if (Math.abs(d) < 1e-9) { if (p <= lo || p >= hi) { t0 = 2; break; } continue; }
        let a = (lo - p) / d, b = (hi - p) / d; if (a > b) [a, b] = [b, a];
        t0 = Math.max(t0, a); t1 = Math.min(t1, b); if (t0 >= t1) break;
      }
      if (t0 < t1) return true;
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
  const nFloors = Math.max(1, Math.min(4, Math.round(opts.floors || 1))), multi = nFloors > 1;
  const rng = mulberry32(seed);
  const R = (a, b) => a + rng() * (b - a);
  const RI = (a, b) => Math.floor(R(a, b + 1));
  const pick = (arr) => arr[Math.floor(rng() * arr.length)];

  // ---- the plan: hallways in one of several shapes, rooms sliced around them either way round (shared/houseplan.js) ----
  const plan = planHouse(rng, { exact, mansion, floors: nFloors });
  const x1 = mansion ? RI(-6, -2) : RI(-6, 2);                    // front wall (front door); the ramp starts at x=9.4
  const D = plan.D, x0 = +(x1 - plan.W).toFixed(3);
  const z0r = Math.round(R(-1.5, 1.5) - D / 2);
  let z0 = Math.max(-13, Math.min(13 - D, z0r)), z1 = z0 + D;     // the house stays within z -13..13
  const r3 = (v) => Math.round(v * 1000) / 1000;
  plan.floors.forEach((f, k) => { for (const r of f.rooms) { r.x0 = r3(r.x0 + x1); r.x1 = r3(r.x1 + x1); r.z0 = r3(r.z0 + z0 + FLOOR_DZ * k); r.z1 = r3(r.z1 + z0 + FLOOR_DZ * k); r.storey = k; } });
  const living = plan.floors[0].rooms.find(r => r.kind === 'living');
  // front door on the living room's outer wall, facing the truck
  let fd = Math.max(Math.max(z0, -10.5) + 2.5, Math.min(Math.min(z1, 10.5) - 2.5, R(living.z0 + 2.4, living.z1 - 2.4)));
  fd = Math.max(living.z0 + 2.2, Math.min(living.z1 - 2.2, fd));
  let rooms = [], doors = [], opens = [], conns = [];
  const houseWalls = [];
  plan.floors.forEach((f, k) => {
    const built = buildWalls(rng, f.rooms, f.conns, k === 0 ? { frontDoor: fd, x1 } : {});
    houseWalls.push(...built.walls); doors.push(...built.doors); opens.push(...built.opens);
    rooms.push(...f.rooms); conns.push(...f.conns);
  });

  // ---- stairs: two flights side by side in the stairwell (the same spot on every floor), rails along them ----
  const stairs = [];
  if (multi) {
    const sr = rooms.find(r => r.role === 'stairs' && r.storey === 0);
    // the two flights sit against the wall away from the way in (sr.laneSide), leaving a walkway beside them to both landings
    const wl = sr.x0 + T / 2, wr = sr.x1 - T / 2, fw = 2 * LANE_W + RAIL;
    const lx = sr.laneSide === 'x1' ? wr - fw : wl, lanes = [[lx, lx + LANE_W], [lx + LANE_W + RAIL, lx + fw]];
    if (sr.laneSide === 'x1') lanes.reverse(); // the first flight against the wall either way
    const zl = sr.z0 + T / 2 + LANDING, zh = sr.z1 - T / 2 - LANDING;
    for (let b = 0; b < nFloors - 1; b++) { const [a, c] = lanes[b % 2]; stairs.push({ b, x0: a, x1: c, zl, zh, dir: b % 2 ? -1 : 1, openX0: a > wl + 0.01, openX1: c < wr - 0.01 }); }
    /** rails on floor k (floor-0 coordinates): both sides of each flight; the top end closed on the floor you climb from,
     *  the bottom end (the stairwell edge) closed on the floor you arrive at */
    const rails = (k) => {
      const out = [], seen = new Set();
      const add = (w) => { const key = [w.x0, w.x1, w.z0, w.z1].map(v => v.toFixed(2)).join(); if (!seen.has(key)) { seen.add(key); out.push(w); } };
      for (const st of stairs) {
        if (st.b !== k && st.b + 1 !== k) continue;
        if (st.openX0) add({ x0: st.x0 - RAIL, x1: st.x0, z0: zl, z1: zh, rail: true }); // a rail on every side that isn't a wall
        if (st.openX1) add({ x0: st.x1, x1: st.x1 + RAIL, z0: zl, z1: zh, rail: true });
        const zc = (st.b === k) === (st.dir > 0) ? zh : zl;
        add({ x0: st.x0, x1: st.x1, z0: zc - RAIL / 2, z1: zc + RAIL / 2, rail: true });
      }
      return out;
    };
    for (let k = 0; k < nFloors; k++) for (const w of rails(k)) houseWalls.push({ ...w, z0: w.z0 + FLOOR_DZ * k, z1: w.z1 + FLOOR_DZ * k });
  }

  // ---- half of all houses are mirror images (north–south), so the same pieces make a different-feeling plan ----
  const mirrored = rng() < 0.5;
  if (mirrored) {
    const mz = (z) => 2 * FLOOR_DZ * Math.max(0, Math.round(z / FLOOR_DZ)) - z;   // flip within the floor's own strip
    const flip = (o) => { const a = mz(o.z1), b = mz(o.z0); o.z0 = a; o.z1 = b; };
    rooms.forEach(flip); houseWalls.forEach(flip);
    for (const d of [...doors, ...opens]) { if (d.vertical) d.c = mz(d.c); else d.at = mz(d.at); }
    for (const st of stairs) { const a = -st.zh, b = -st.zl; st.zl = a; st.zh = b; st.dir = -st.dir; }
    [z0, z1] = [-z1, -z0]; fd = -fd;
  }

  // ---- which rooms connect: every door and opening joins two rooms; the stairs join floor to floor ----
  rooms.sort((a, b) => (a.x0 - b.x0) || (a.z0 - b.z0));
  const idx = new Map(rooms.map((r, i) => [r, i]));
  const links = rooms.map(() => new Set());
  for (const c of conns) { const a = idx.get(c.a), b = idx.get(c.b); links[a].add(b); links[b].add(a); }
  const wells = rooms.map((r, i) => i).filter(i => rooms[i].role === 'stairs').sort((a, b) => rooms[a].storey - rooms[b].storey);
  for (let i = 1; i < wells.length; i++) { links[wells[i - 1]].add(wells[i]); links[wells[i]].add(wells[i - 1]); }
  const front = idx.get(living);
  const hops = rooms.map(() => Infinity); hops[front] = 0;
  for (const q = [front]; q.length;) { const i = q.shift(); for (const j of links[i]) if (hops[j] === Infinity) { hops[j] = hops[i] + 1; q.push(j); } }
  const area = (r) => (r.x1 - r.x0) * (r.z1 - r.z0);

  // ---- room roles come from the plan; kids rooms are bedrooms (bed + dresser) with their own name and tiles ----
  const role = rooms.map(r => r.role);
  const cellsOf = (t) => { const it = ITEM_TYPES[t]; return it.cells ? it.cells.length : it.w * it.d * (it.h || 1); };

  // ---- names and per-type tile sets (floor pattern, wall colour on this room's side, skirting) ----
  const ROLE_INFO = {
    living:   { name: 'Living Room', floor: 'wood',     wall: 0xf1e3cc, skirt: 0x7a4f2c, color: 0x6b4a33 },
    dining:   { name: 'Dining Room', floor: 'darkwood', wall: 0xead6bd, skirt: 0x5c3a22, color: 0x5d3f2b },
    kitchen:  { name: 'Kitchen',     floor: 'tile',     wall: 0xf6f1e7, skirt: 0x8a8070, color: 0x8f8a80 },
    bedroom:  { name: 'Bedroom',     floor: 'carpet',   wall: 0xdfe5d4, skirt: 0x6e6a5c, color: 0x7d6b58 },
    kids:     { name: 'Kids Room',   floor: 'carpet2',  wall: 0xf3e2b8, skirt: 0x9a6b2f, color: 0x6fae9e },
    office:   { name: 'Office',      floor: 'darkwood', wall: 0xe4dccd, skirt: 0x4a3a2c, color: 0x55402e },
    bathroom: { name: 'Bathroom',    floor: 'tile2',    wall: 0xe8efe9, skirt: 0x7d8b84, color: 0x9fb3aa },
    laundry:  { name: 'Laundry',     floor: 'tile2',    wall: 0xece6da, skirt: 0x7d7468, color: 0x8b8578 },
    hall:     { name: 'Hallway',     floor: 'wood',     wall: 0xefe2cb, skirt: 0x7a4f2c, color: 0x6e5038 },
    passage:  { name: 'Passage',     floor: 'wood',     wall: 0xefe2cb, skirt: 0x7a4f2c, color: 0x6e5038 },
    stairs:   { name: 'Stairs',      floor: 'wood',     wall: 0xefe2cb, skirt: 0x7a4f2c, color: 0x6e5038 },
    den:      { name: 'Family Room', floor: 'carpet3',  wall: 0xf0dcc0, skirt: 0x6b4a33, color: 0x8a5a44 },
    play:     { name: 'Playroom',    floor: 'carpet2',  wall: 0xf6e6b4, skirt: 0x9a6b2f, color: 0x6fae9e },
    garage:   { name: 'Garage',      floor: 'concrete', wall: 0xdcd6ca, skirt: 0x5e5a52, color: 0x77736b },
    storage:  { name: 'Storage Room', floor: 'concrete', wall: 0xe2dccf, skirt: 0x6e6a5c, color: 0x8b8578 },
  };
  let bedN = 0;
  rooms.forEach((r, i) => {
    const kind = r.kind || r.role;
    const info = ROLE_INFO[kind === 'main' ? 'bedroom' : kind];
    r.role = role[i];
    if (kind === 'bedroom') bedN++;
    r.name = kind === 'main' ? 'Main Bedroom' : kind === 'bedroom' ? `Bedroom ${bedN + 1}` : info.name;
    r.tiles = { floor: info.floor, wall: info.wall, skirt: info.skirt };
    r.floor = info.color;
  });

  const level = finish({
    seed, exact, mansion, name: mansion ? `${pick(PREFIX)} Moon Mansion` : `${pick(PREFIX)} ${pick(SUFFIX)}`,
    house: { x0, x1, z0, z1 }, yardDistance: +(9.4 - x1).toFixed(1),
    rooms, walls: [...houseWalls, ...TRUCK_WALLS], houseWalls, props: [], items: [], cat: [],
    frontDoor: { x: x1, z: fd }, floors: nFloors, stairs,
    variant: { mirrored, openPlan: plan.openPlan, garage: plan.garage, layout: plan.layout },
    doors: doors.map(d => ({ vertical: d.vertical, at: d.at, c: d.c, w: d.w || DOOR })), // inner doorways (for frames, lintels, decor)
    openings: opens.map(o => ({ vertical: o.vertical, at: o.at, c: o.c, w: o.w })),          // where halls join with no door at all
  });
  level.doorsBetween = (a, b) => (links[rooms.indexOf(a)]?.has(rooms.indexOf(b)) ? 1 : 0); // a door or an opening
  level.hopsFromFront = (r) => hops[rooms.indexOf(r)];

  // ---- the inventory, room by room: [type, room index or -1 for anywhere] ----
  const byRole = (k) => rooms.map((_, i) => i).filter(i => role[i] === k);
  let entries = [];
  if (exact) {
    const built = buildExactLoad(rng);
    // remember the known-good packing: AI movers use it as their plan
    const g = createGrid();
    level.solution = built.solution.map(sl => {
      const r = placeItem(g, { id: sl.id, type: sl.type, wrapped: true }, sl.gx, sl.gz, sl.rot);
      const rec = g.items.get(sl.id);
      return { type: sl.type, gx: sl.gx, gz: sl.gz, rot: sl.rot, y: r.y, cells: rec.cells.map(([x, y, z]) => [sl.gx + x, r.y + y, sl.gz + z]) };
    });
    const pref = { bed: ['bedroom'], dresser: ['bedroom'], couch: ['living'], coffeetable: ['living'], table: ['dining', 'kitchen'], lamp: ['dining', 'living'], desk: ['office', 'bedroom'] };
    const used = {};
    entries = built.pieces.sort((a, b) => cellsOf(b) - cellsOf(a)).map(t => {
      const opts = (pref[t] || []).flatMap(byRole);
      const k = (used[t] = (used[t] || 0) + 1) - 1;
      return [t, opts.length ? opts[k % opts.length] : -1];
    });
  } else {
    const L = byRole('living')[0], D = byRole('dining')[0], K = byRole('kitchen')[0];
    entries.push(['couch', L], ['lamp', L], ['coffeetable', L]);
    const eat = D !== undefined ? D : K !== undefined ? K : L;
    entries.push(['table', eat], ['lamp', eat]);
    for (const b of byRole('bedroom')) entries.push(['bed', b], ['dresser', b]);
    for (const o of byRole('office').slice(0, multi ? 1 : Infinity)) entries.push(['desk', o]); // one desk per house when there are bedrooms on every floor
    // the extras that make it someone's home: an armchair and the TV in the living room (or family room), bookshelves in offices/dens
    const lounge = [L, ...byRole('den')].filter(i => i !== undefined && area(rooms[i]) >= 60); // roomy enough to still have space for a box
    if (lounge.length && rng() < 0.75) entries.push(['armchair', lounge[Math.floor(rng() * lounge.length)]]);
    if (lounge.length && rng() < 0.65) entries.push(['tv', lounge[Math.floor(rng() * lounge.length)]]);
    const studies = [...byRole('office'), ...byRole('den')];
    if (studies.length && rng() < 0.6) entries.push(['bookshelf', studies[Math.floor(rng() * studies.length)]]);
    // boxes: at least one in every room, the rest by floor area; fragile favours kitchen/dining, heavy the office/laundry
    const furnCells = entries.reduce((a, [t]) => a + cellsOf(t), 0);
    // multi-floor houses: fewer boxes, spread thin over every floor, so a crew has to split up and look around
    const nBoxes = multi ? Math.min(RI(9, 12), 56 - furnCells) : Math.max(rooms.length + 1, Math.min(RI(14, 20), 56 - furnCells));
    const MIX = { garage: [0.35, 0.55, 0.1], kitchen: [0.4, 0.15, 0.45], dining: [0.45, 0.1, 0.45], office: [0.4, 0.5, 0.1], laundry: [0.5, 0.4, 0.1], bathroom: [0.6, 0.2, 0.2], bedroom: [0.6, 0.2, 0.2], living: [0.5, 0.25, 0.25] };
    const boxFor = (i) => { const m = MIX[role[i]] || MIX.living, u = rng(); return u < m[0] ? 'standard' : u < m[0] + m[1] ? 'heavy' : 'fragile'; };
    const totalArea = rooms.reduce((a, r) => a + area(r), 0);
    const clearRole = (k) => k === 'hall' || k === 'stairs';
    const boxes = [];
    if (multi) { // floors take turns; within a floor, a different room each time (shuffled) until every room has one
      const queue = Array.from({ length: nFloors }, (_, f) => {
        const ids = rooms.map((_, i) => i).filter(i => rooms[i].storey === f && !clearRole(role[i]));
        for (let i = ids.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [ids[i], ids[j]] = [ids[j], ids[i]]; }
        return ids;
      });
      const start = Math.floor(rng() * nFloors);
      for (let j = 0; boxes.length < nBoxes && j < nBoxes * 8; j++) {
        const q = queue[(start + j) % nFloors];
        if (!q.length) continue;
        const pickI = q[Math.floor(j / nFloors) % q.length];
        boxes.push([boxFor(pickI), pickI]);
      }
    } else {
      boxes.push(...rooms.map((_, i) => i).filter(i => !clearRole(role[i])).map(i => [boxFor(i), i])); // hallways stay clear
      while (boxes.length < nBoxes) { let t = rng() * totalArea, i = 0; for (; i < rooms.length - 1; i++) { t -= area(rooms[i]); if (t <= 0) break; } if (!clearRole(role[i])) boxes.push([boxFor(i), i]); }
    }
    // the full mix is always there
    if (!boxes.some(([t]) => t === 'heavy')) boxes[0][0] = 'heavy';
    if (!boxes.some(([t]) => t === 'fragile')) boxes[boxes.length > 1 ? 1 : 0][0] = 'fragile';
    entries.push(...boxes); // (nothing starts out on the lawn: everything is inside the house)
  }

  // ---- place everything: clear of walls, doors and each other, furniture in its own room ----
  const doorPts = [...opens.map(o => (o.vertical ? { x: o.at, z: o.c } : { x: o.c, z: o.at })), ...doors.flatMap(d => { const p = d.vertical ? { x: d.at, z: d.c } : { x: d.c, z: d.at }; // wide openings: keep their whole width clear
    const k = d.vertical ? 'z' : 'x'; // along the wall the doorway is cut in
    return d.w > DOOR ? [p, { ...p, [k]: p[k] - (d.w / 2 - 1) }, { ...p, [k]: p[k] + (d.w / 2 - 1) }] : [p]; }), level.frontDoor];
  // ---- built-ins: each room type gets the fixtures that make it read as that room (they stay behind when you move out).
  //      Backed onto a wall, clear of doorways and of each other; solid to walk into but low enough to see over. ----
  const FIXTURES = {
    kitchen: [['fridge', 0.9, 0.8], ['stove', 0.9, 0.75]], bathroom: [['tub', 1.7, 0.85], ['toilet', 0.55, 0.7], ['sink', 0.7, 0.5]],
    laundry: [['washer', 0.75, 0.7], ['dryer', 0.75, 0.7]], garage: [['workbench', 2.0, 0.7]], office: [['bookcase', 1.2, 0.4]],
    den: [['fireplace', 1.6, 0.5]], living: [['fireplace', 1.6, 0.5]], dining: [['sideboard', 1.6, 0.5]], bedroom: [['nightstand', 0.5, 0.45]],
    kids: [['toychest', 0.9, 0.55]], play: [['toychest', 0.9, 0.55]], storage: [['shelving', 1.8, 0.5]],
  };
  const fixtures = [];
  const doorNear = (fx0, fz0, fx1, fz1, pad) => doorPts.some(p => p.x > fx0 - pad && p.x < fx1 + pad && p.z > fz0 - pad && p.z < fz1 + pad);
  for (const r of rooms) {
    const list = FIXTURES[r.kind] || FIXTURES[r.role];
    if (!list) continue;
    for (const [type, fw, fd] of list) {
      const sides = ['z0', 'x0', 'x1', 'z1'].map(sd => [sd, rng()]).sort((a, b) => a[1] - b[1]).map(([sd]) => sd);
      if (sides.includes('z0')) { sides.splice(sides.indexOf('z0'), 1); sides.unshift('z0'); } // the far wall faces the camera: show it off
      let spot = null;
      for (const side of sides) {
        const along = side[0] === 'z' ? [r.x0, r.x1] : [r.z0, r.z1];
        const span = along[1] - along[0] - 2 * (fw / 2 + 0.5);
        if (span < 0) continue;
        for (let k = 0; k < 6 && !spot; k++) {
          const u = along[0] + fw / 2 + 0.5 + rng() * span, inset = T / 2 + fd / 2 + 0.02;
          const c = side === 'z0' ? { x: u, z: r.z0 + inset } : side === 'z1' ? { x: u, z: r.z1 - inset } : side === 'x0' ? { x: r.x0 + inset, z: u } : { x: r.x1 - inset, z: u };
          const hw = side[0] === 'z' ? fw / 2 : fd / 2, hd = side[0] === 'z' ? fd / 2 : fw / 2;
          const box = { x0: c.x - hw, x1: c.x + hw, z0: c.z - hd, z1: c.z + hd };
          if (doorNear(box.x0, box.z0, box.x1, box.z1, DOOR / 2 + 0.7)) continue;
          if (fixtures.some(f => box.x0 < f.box.x1 + 0.3 && box.x1 > f.box.x0 - 0.3 && box.z0 < f.box.z1 + 0.3 && box.z1 > f.box.z0 - 0.3)) continue;
          spot = { type, side, x: +c.x.toFixed(2), z: +c.z.toFixed(2), w: fw, d: fd, box };
        }
        if (spot) break;
      }
      if (spot) fixtures.push(spot);
    }
  }
  for (const f of fixtures) {
    level.props.push({ kind: 'fixture', type: f.type, side: f.side, x: f.x, z: f.z, w: f.w, d: f.d });
    level.walls.push({ ...f.box, invisible: true, fixture: true }); // solid, but eyes see over it (lineBlocked skips invisible walls)
  }
  level.fixtures = fixtures.map(f => ({ type: f.type, ...f.box }));

  const placed = [];
  const totalArea = rooms.reduce((a, r) => a + area(r), 0);
  const open = rooms.filter(r => r.role !== 'hall' && r.role !== 'stairs'), openArea = open.reduce((a, r) => a + area(r), 0);
  const roomOnFloor = (f) => { const rs = open.filter(r => r.storey === f); let t = rng() * rs.reduce((a, r) => a + area(r), 0); for (const r of rs) { t -= area(r); if (t <= 0) return r; } return rs[0] || open[0]; };
  const roomByArea = () => { let t = rng() * openArea; for (const r of open) { t -= area(r); if (t <= 0) return r; } return open[0]; };
  const halls = rooms.filter(r => r.role === 'hall' || r.role === 'stairs'); // corridors and stairwells stay clear
  entries.sort((a, b) => (ITEM_TYPES[b[0]].furniture ? 1 : 0) - (ITEM_TYPES[a[0]].furniture ? 1 : 0) || cellsOf(b[0]) - cellsOf(a[0])); // big pieces first
  entries.forEach(([type, ri]) => {
    const t = ITEM_TYPES[type];
    const halfX = t.furniture ? t.w / 2 + 0.7 : 0.9, halfZ = t.furniture ? t.d / 2 + 0.7 : 0.9;
    const hw = Math.max(t.w, 1) / 2, hd = Math.max(t.d, 1) / 2;
    const inYard = ri === -2;
    const own = ri >= 0 ? rooms[ri] : null;
    /** can this piece sit at (x, z)? walls checked against its real rectangle; doorways and other pieces kept clear */
    const fits = (x, z, tight, yard) => {
      const zo = FLOOR_DZ * level.floorOf(z); // upstairs floors sit in their own strip
      if (!yard && (x - halfX < x0 || x + halfX > x1 || z - halfZ < z0 + zo || z + halfZ > z1 + zo)) return false;
      if (t.furniture ? [[-1, -1], [1, -1], [-1, 1], [1, 1], [0, -1], [0, 1], [-1, 0], [1, 0], [0, 0]].some(([sx, sz]) => level.hitsWall(x + sx * hw, z + sz * hd, 0.45))
        : level.hitsWall(x, z, 0.7)) return false;
      if (halls.some(h => x + hw + 0.3 > h.x0 && x - hw - 0.3 < h.x1 && z + hd + 0.3 > h.z0 && z - hd - 0.3 < h.z1)) return false; // never in a hallway
      const doorGap = t.furniture ? (tight ? 1.4 : 1.9) : 1.3;
      if (doorPts.some(p => Math.hypot(Math.max(0, Math.abs(p.x - x) - hw), Math.max(0, Math.abs(p.z - z) - hd)) < doorGap)) return false;
      return !placed.some(([pt, px, pz]) => {
        const o = ITEM_TYPES[pt];
        const gap = tight || (type === 'coffeetable' && pt === 'couch') ? 0.25 : 0.5;
        return Math.abs(px - x) < (Math.max(o.w, 1) + Math.max(t.w, 1)) / 2 + gap && Math.abs(pz - z) < (Math.max(o.d, 1) + Math.max(t.d, 1)) / 2 + gap;
      });
    };
    for (let tries = 0; tries < (exact ? 200 : 220); tries++) {
      let x, z;
      if (inYard) continue; // (no longer used: nothing spawns outside)
      else if (type === 'coffeetable' && tries < 12 && placed.some(([pt]) => pt === 'couch')) { // in front of the couch, like a real living room
        const [, cx, cz] = placed.find(([pt]) => pt === 'couch');
        [x, z] = [[cx, cz + 1.6], [cx, cz - 1.6], [cx + 0.6, cz + 1.7], [cx - 0.6, cz - 1.7], [cx + 2.6, cz], [cx - 2.6, cz]][tries % 6];
      }
      else { const r = own ? own : multi && !t.furniture ? roomOnFloor(placed.length % nFloors) : roomByArea(); x = R(r.x0 + halfX, r.x1 - halfX); z = R(r.z0 + halfZ, r.z1 - halfZ); }
      x = Math.round(x * 10) / 10; z = Math.round(z * 10) / 10;
      if (!fits(x, z, false, false)) continue;
      placed.push([type, x, z]);
      return;
    }
    if (own) { // a crowded room: scan it on a fine grid, a little tighter, before giving up
      for (const tight of [false, true]) for (let x = own.x0 + halfX; x <= own.x1 - halfX + 1e-6; x += 0.3) for (let z = own.z0 + halfZ; z <= own.z1 - halfZ + 1e-6; z += 0.3) {
        const px = Math.round(x * 10) / 10, pz = Math.round(z * 10) / 10;
        if (fits(px, pz, tight, false)) { placed.push([type, px, pz]); return; }
      }
    }
    // never drop a piece (a Full load needs every one): any room of the house, scanned finely and packed a little tighter
    for (const tight of [false, true]) for (const r of open) for (let x = r.x0 + halfX; x <= r.x1 - halfX + 1e-6; x += 0.3) for (let z = r.z0 + halfZ; z <= r.z1 - halfZ + 1e-6; z += 0.3) {
      const px = Math.round(x * 10) / 10, pz = Math.round(z * 10) / 10;
      if (fits(px, pz, tight, false)) { placed.push([type, px, pz]); return; }
    }
  });
  level.items = placed;

  // ---- decoration + cat route ----
  for (const r of rooms) {
    if (r.role === 'stairs') continue; // the stairwell has its own look
    const w = r.x1 - r.x0, d = r.z1 - r.z0;
    level.props.push({ kind: 'rug', x: (r.x0 + r.x1) / 2, z: (r.z0 + r.z1) / 2, w: Math.min(5, w * 0.45), d: Math.min(3.5, d * 0.35), color: pick([0xc8734f, 0xd9b26a, 0x8a9a6b, 0xb5654a, 0xe0c9a0]) }); // warm rugs (terracotta, mustard, sage, rust, oat)
    // decorations never sit in a doorway (they're walk-through, but they look like they block it)
    const nearDoor = (x0, z0, x1, z1, pad) => doorPts.some(p => p.x > x0 - pad && p.x < x1 + pad && p.z > z0 - pad && p.z < z1 + pad);
    const corners = [[r.x0 + 0.9, r.z0 + 0.9], [r.x1 - 0.9, r.z0 + 0.9], [r.x0 + 0.9, r.z1 - 0.9], [r.x1 - 0.9, r.z1 - 0.9]];
    const first = RI(0, 3);
    const corner = r.role === 'hall' ? null : [0, 1, 2, 3].map(k => corners[(first + k) % 4]).find(([cx, cz]) => !nearDoor(cx, cz, cx, cz, DOOR / 2 + 1.0) && !fixtures.some(f => cx > f.box.x0 - 0.7 && cx < f.box.x1 + 0.7 && cz > f.box.z0 - 0.7 && cz < f.box.z1 + 0.7));
    if (corner && !placed.some(([, px, pz]) => Math.hypot(px - corner[0], pz - corner[1]) < 1.5)) level.props.push({ kind: 'plant', x: corner[0], z: corner[1] });
    if (r.name === 'Kitchen' && Math.max(w, d) > 7) { // counter along the first wall with no doorway in its way
      const opts = [
        { x: (r.x0 + r.x1) / 2, z: r.z1 - 0.9, w: w * 0.6, d: 1.0 }, { x: (r.x0 + r.x1) / 2, z: r.z0 + 0.9, w: w * 0.6, d: 1.0 },
        { x: r.x0 + 0.9, z: (r.z0 + r.z1) / 2, w: 1.0, d: d * 0.6 }, { x: r.x1 - 0.9, z: (r.z0 + r.z1) / 2, w: 1.0, d: d * 0.6 },
      ].filter(c => Math.max(c.w, c.d) > 4);
      const hitsFixture = (c) => fixtures.some(f => c.x - c.w / 2 < f.box.x1 + 0.2 && c.x + c.w / 2 > f.box.x0 - 0.2 && c.z - c.d / 2 < f.box.z1 + 0.2 && c.z + c.d / 2 > f.box.z0 - 0.2);
      const c = opts.find(c => !nearDoor(c.x - c.w / 2, c.z - c.d / 2, c.x + c.w / 2, c.z + c.d / 2, DOOR / 2 + 0.9) && !hitsFixture(c));
      if (c) level.props.push({ kind: 'counter', ...c, color: 0xdddddd });
    }
    if (r.storey === 0) level.cat.push([(r.x0 + r.x1) / 2, (r.z0 + r.z1) / 2]); // the cat stays downstairs
  }
  for (const p of doorPts) if (p.z < FLOOR_DZ / 2) level.cat.push([p.x, p.z]);
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
    rooms: [{ name: 'Front Room', x0: -7, x1: 0, z0: -7, z1: 7, floor: 0x6b4a33, tiles: { floor: 'wood', wall: 0xf1e3cc, skirt: 0x7a4f2c } }, { name: 'Back Room', x0: -14, x1: -7, z0: -7, z1: 7, floor: 0x7d6b58, tiles: { floor: 'carpet', wall: 0xdfe5d4, skirt: 0x6e6a5c } }],
    walls: [...houseWalls, ...TRUCK_WALLS], houseWalls,
    items: [['standard', -3, -4], ['heavy', -3, 4], ['fragile', -10.5, -4.5], ['lamp', -10.5, 4.5], ['couch', -10.5, 0]],
    props: [{ kind: 'rug', x: -3.5, z: 0, w: 4, d: 3, color: 0xc8734f }, { kind: 'plant', x: -1, z: -6 }, { kind: 'plant', x: 1.6, z: -3 }, { kind: 'plant', x: 1.6, z: 3 }],
    cat: [[-3.5, 0], [-10.5, 2], [-3.5, 5]],
    frontDoor: { x: 0, z: 0 },
  });
}

/** A random free floor spot inside the house (for respawning broken items). */
export function freeSpot(level, taken, rng = Math.random, floor = null) {
  const rooms = level.rooms.filter(r => r.role !== 'hall' && r.role !== 'stairs' && (floor === null || (r.storey || 0) === floor)); // hallways and stairwells stay clear
  for (let i = 0; i < 200; i++) {
    const r = rooms[Math.floor(rng() * rooms.length)];
    const x = r.x0 + 1.1 + rng() * (r.x1 - r.x0 - 2.2), z = r.z0 + 1.1 + rng() * (r.z1 - r.z0 - 2.2);
    if (level.hitsWall(x, z, 0.7) || taken.some(p => Math.hypot(p.x - x, p.z - z) < 1.2)) continue;
    return { x: +x.toFixed(1), z: +z.toFixed(1) };
  }
  // a crowded house: scan the rooms finely for any free spot (never outside on the lawn)
  for (const r of rooms) for (let x = r.x0 + 0.9; x <= r.x1 - 0.9; x += 0.4) for (let z = r.z0 + 0.9; z <= r.z1 - 0.9; z += 0.4) {
    if (!level.hitsWall(x, z, 0.6) && !taken.some(p => Math.hypot(p.x - x, p.z - z) < 1)) return { x: +x.toFixed(1), z: +z.toFixed(1) };
  }
  const r = rooms[0]; return { x: +((r.x0 + r.x1) / 2).toFixed(1), z: +((r.z0 + r.z1) / 2).toFixed(1) };
}

/** Rebuild the server's house from the small description sent in every snapshot. */
export function levelFromSnapshot(lv) {
  if (lv.tutorial) return tutorialLevel();
  if (lv.classic) return classicLevel();
  const l = generateLevel(lv.seed, { exact: !!lv.exact, mansion: !!lv.mansion, floors: lv.floors || 1 });
  if (lv.daily) l.daily = lv.daily;
  return l;
}

/** House code: the seed written short (base 36), e.g. 1A2B3C. Same code + same options = the same house for anyone. */
export const houseCode = (seed) => (seed >>> 0).toString(36).toUpperCase();
/** Back from a typed code (case, spaces and dashes don't matter); null if it isn't one. */
export function seedFromCode(code) {
  const c = String(code || '').toUpperCase().replace(/[\s-]/g, '');
  if (!/^[0-9A-Z]{1,7}$/.test(c)) return null;
  const n = parseInt(c, 36);
  return Number.isSafeInteger(n) && n <= 0xffffffff ? n : null;
}

/** A fresh seed for the next round. */
export const newSeed = () => (Math.random() * 2 ** 31) >>> 0;
export { WORLD };
