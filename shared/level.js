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

/** Size limits per room type, metres: len = along the house (z), dep = depth of its column (x). */
export const ROOM_SIZES = {
  living: { len: [7, 10], dep: [8, 10] }, dining: { len: [6, 8], dep: [8, 10] }, kitchen: { len: [5, 7], dep: [8, 10] },
  main: { len: [7, 9], dep: [6.5, 8] }, bedroom: { len: [6, 9], dep: [6.5, 8] }, kids: { len: [6, 7], dep: [6.5, 8] },
  office: { len: [5, 7], dep: [6.5, 8] }, bathroom: { len: [5, 5.5], dep: [6.5, 8] }, laundry: { len: [5, 6], dep: [6.5, 8] },
  hall: { len: [10, 26], dep: [3.6, 4.2] }, passage: { len: [4, 6], dep: [6.5, 8] },
};
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

  // ---- a real-house plan: a front column of shared rooms (living / dining / kitchen), a hallway, and a back column of
  //      private rooms (bedrooms, bathroom, office). Every room type stretches only within its own size range. ----
  const sz = (role) => ROOM_SIZES[role];
  const pickLen = (role) => Math.round(R(...sz(role).len) * 2) / 2;
  const x1 = mansion ? RI(-6, -2) : RI(-6, 2);                    // right wall (front door); the ramp starts at x=9.4
  const MAXD = 26;                                                 // the house stays within z -13..13
  // front column: living (front door) with dining and kitchen either side or in a row
  const tiny = !mansion && !exact && rng() < 0.18;                 // a small cottage: living + kitchen, bedroom straight off the living room
  const frontRoles = tiny ? ['living', 'kitchen'] : ['living', 'dining', 'kitchen'];
  if (!tiny && rng() < 0.5) frontRoles.reverse();                       // kitchen-dining-living or living-dining-kitchen
  const frontLens = frontRoles.map(pickLen);
  let D = frontLens.reduce((a, b) => a + b, 0);
  // back column(s): bedrooms first, then bathroom / office / laundry, until each is as long as the front.
  // A Moon Mansion has two wings of private rooms, joined by a short passage at the end of the middle wing.
  const fit = (roles, lens, target) => {
    const lim = (r) => sz(r).len;
    for (let pass = 0; pass < 3; pass++) {
      let diff = target - lens.reduce((a, b) => a + b, 0);
      for (let i = 0; i < lens.length && Math.abs(diff) > 0.01; i++) {
        const [lo, hi] = lim(roles[i]);
        const nl = Math.max(lo, Math.min(hi, lens[i] + diff));
        diff -= nl - lens[i]; lens[i] = nl;
      }
    }
    return lens.reduce((a, b) => a + b, 0);
  };
  const fillColumn = (wanted, D) => {
    const roles = [], lens = [];
    for (const role of wanted) {
      const used = lens.reduce((a, b) => a + b, 0);
      const len = pickLen(role);
      if (used + len > MAXD + 0.01) continue;
      if (used >= D && roles.length) break;
      roles.push(role); lens.push(len);
    }
    return { roles, lens };
  };
  const wings = mansion ? 2 : 1;
  const nBeds = tiny ? 1 : mansion ? 3 : exact ? 2 : RI(1, 3);
  const bedRoles = Array.from({ length: nBeds }, (_, i) => (i === 0 ? 'main' : i === 2 ? 'kids' : 'bedroom'));
  const columns = [];
  if (wings === 1) columns.push(fillColumn([...bedRoles, ...(tiny ? ['bathroom'] : ['bathroom', 'office', 'laundry'])], D));
  else {
    columns.push(fillColumn(['passage', bedRoles[0], 'bathroom', 'office'], D));
    columns.push(fillColumn([bedRoles[1], bedRoles[2], 'laundry', 'office', 'bathroom'], D));
  }
  D = Math.min(MAXD, Math.max(D, ...columns.map(c => c.lens.reduce((a, b) => a + b, 0))));
  D = fit(frontRoles, frontLens, D);
  for (const c of columns) { const B = fit(c.roles, c.lens, D); if (Math.abs(B - D) > 0.01) D = fit(frontRoles, frontLens, B); }
  // every wing must come out exactly as long as the house with each room inside its own limits: add or drop rooms until it does
  const extraRoles = ['office', 'laundry', 'bathroom', 'office', 'laundry'];
  for (const c of columns) {
    for (let guard = 0; guard < 6; guard++) {
      const got = fit(c.roles, c.lens, D);
      if (Math.abs(got - D) < 0.01) break;
      if (got < D) { const role = extraRoles[guard % extraRoles.length]; c.roles.push(role); c.lens.push(sz(role).len[0]); }
      else if (c.roles.length > 1) { c.roles.pop(); c.lens.pop(); }
    }
  }
  const r1 = (v) => Math.round(v * 2) / 2;
  const wF = r1(R(...sz('living').dep));
  const z0r = Math.round(R(-1.5, 1.5) - D / 2);
  const z0 = Math.max(-13, Math.min(13 - D, z0r)), z1 = z0 + D;
  const rooms = [], doors = [], innerWalls = [];
  const stack = (roles, lens, xa, xb) => { let z = z0; roles.forEach((role, i) => { const zz = i === roles.length - 1 ? z1 : z + lens[i]; rooms.push({ x0: xa, x1: xb, z0: z, z1: zz, role: role === 'main' || role === 'kids' ? 'bedroom' : role, kind: role }); z = zz; }); };
  const xF0 = x1 - wF;
  stack(frontRoles, frontLens, xF0, x1);
  const addH = (xa, xb, at) => { const c = R(xa + DOOR / 2 + 0.8, xb - DOOR / 2 - 0.8); doors.push({ vertical: false, at, c }); innerWalls.push(wallH(xa, c - DOOR / 2, at), wallH(c + DOOR / 2, xb, at)); };
  for (let i = 1; i < frontRoles.length; i++) { const r = rooms[i]; addH(r.x0, r.x1, r.z0); }
  const vWall = (x, cs) => { let z = z0; for (const c of [...cs].sort((a, b) => a - b)) { innerWalls.push(wallV(x, z, c - DOOR / 2)); z = c + DOOR / 2; doors.push({ vertical: true, at: x, c }); } innerWalls.push(wallV(x, z, z1)); };
  const doorIn = (r) => R(r.z0 + DOOR / 2 + 0.8, r.z1 - DOOR / 2 - 0.8);
  const living = rooms.find(r => r.role === 'living');
  let xCur = xF0, x0 = xF0;
  if (tiny) { // cottage: the bedroom opens straight off the living room; en-suite bathroom off the bedroom
    const c = columns[0], wB = r1(R(...sz('bedroom').dep));
    x0 = xF0 - wB; stack(c.roles, c.lens, x0, xF0);
    vWall(xF0, [doorIn(living)]);
    const backs = rooms.filter(r => r.x1 === xF0);
    for (let i = 1; i < backs.length; i++) addH(backs[i].x0, backs[i].x1, backs[i].z0);
  } else {
    const kit = rooms.find(r => r.role === 'kitchen');
    let prevOpen = [doorIn(living), ...(kit && rng() < 0.5 ? [doorIn(kit)] : [])]; // openings from the rooms on the near side of this hallway
    columns.forEach((c, ci) => {
      const hx1 = xCur, hx0 = xCur - 4;                    // the hallway (4 m: room for a couch to turn)
      rooms.push({ x0: hx0, x1: hx1, z0, z1, role: 'hall', kind: 'hall' });
      vWall(hx1, prevOpen);
      const wB = r1(R(...sz('bedroom').dep)), bx0 = hx0 - wB;
      const first = rooms.length;
      stack(c.roles, c.lens, bx0, hx0);
      const backs = rooms.slice(first);
      for (let i = 1; i < backs.length; i++) innerWalls.push(wallH(backs[i].x0, backs[i].x1, backs[i].z0)); // private rooms: separate walls
      vWall(hx0, backs.map(doorIn));                        // every private room opens onto its hallway
      // the next wing is reached through this wing's passage (a hall-type room), so open its far side
      const pass = backs.find(r => r.kind === 'passage'); // a passage room links this hallway to the next one
      prevOpen = pass ? [doorIn(pass)] : [];
      xCur = bx0; x0 = bx0;
    });
  }
  const W = x1 - x0;
  // front door on the living room's outer wall, facing the truck
  const fd = Math.max(Math.max(z0, -10.5) + 2.5, Math.min(Math.min(z1, 10.5) - 2.5, R(living.z0 + 2.4, living.z1 - 2.4)));
  const houseWalls = [
    wallH(x0, x1, z0), wallH(x0, x1, z1), wallV(x0, z0, z1),
    wallV(x1, z0, fd - DOOR * 0.6), wallV(x1, fd + DOOR * 0.6, z1),
    ...innerWalls,
  ].filter(w => w.x1 - w.x0 > 0.05 && w.z1 - w.z0 > 0.05);

  // ---- which rooms connect: every door joins the two rooms either side of it ----
  rooms.sort((a, b) => (a.x0 - b.x0) || (a.z0 - b.z0));
  rooms.forEach(r => { delete r.done; });
  const roomAtPt = (x, z) => rooms.findIndex(r => x > r.x0 && x < r.x1 && z > r.z0 && z < r.z1);
  const links = rooms.map(() => new Set());
  for (const d of doors) {
    const a = d.vertical ? roomAtPt(d.at - 0.5, d.c) : roomAtPt(d.c, d.at - 0.5);
    const b = d.vertical ? roomAtPt(d.at + 0.5, d.c) : roomAtPt(d.c, d.at + 0.5);
    if (a >= 0 && b >= 0 && a !== b) { links[a].add(b); links[b].add(a); }
  }
  const front = Math.max(0, rooms.findIndex(r => Math.abs(r.x1 - x1) < 0.01 && fd >= r.z0 && fd <= r.z1));
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
    frontDoor: { x: x1, z: fd },
  });
  level.doorsBetween = (a, b) => (links[rooms.indexOf(a)]?.has(rooms.indexOf(b)) ? 1 : 0);
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
    for (const o of byRole('office')) entries.push(['desk', o]);
    // boxes: at least one in every room, the rest by floor area; fragile favours kitchen/dining, heavy the office/laundry
    const furnCells = entries.reduce((a, [t]) => a + cellsOf(t), 0);
    const yardN = RI(1, 2);
    const nBoxes = Math.max(rooms.length + 1, Math.min(RI(14, 20), 56 - furnCells - yardN));
    const MIX = { kitchen: [0.4, 0.15, 0.45], dining: [0.45, 0.1, 0.45], office: [0.4, 0.5, 0.1], laundry: [0.5, 0.4, 0.1], bathroom: [0.6, 0.2, 0.2], bedroom: [0.6, 0.2, 0.2], living: [0.5, 0.25, 0.25] };
    const boxFor = (i) => { const m = MIX[role[i]] || MIX.living, u = rng(); return u < m[0] ? 'standard' : u < m[0] + m[1] ? 'heavy' : 'fragile'; };
    const totalArea = rooms.reduce((a, r) => a + area(r), 0);
    const boxes = rooms.map((_, i) => [boxFor(i), i]);
    while (boxes.length < nBoxes) { let t = rng() * totalArea, i = 0; for (; i < rooms.length - 1; i++) { t -= area(rooms[i]); if (t <= 0) break; } boxes.push([boxFor(i), i]); }
    // the full mix is always there
    if (!boxes.some(([t]) => t === 'heavy')) boxes[0][0] = 'heavy';
    if (!boxes.some(([t]) => t === 'fragile')) boxes[boxes.length > 1 ? 1 : 0][0] = 'fragile';
    entries.push(...boxes);
    for (let i = yardN; i--;) entries.push(['standard', -2]); // a couple of boxes already out on the lawn
  }

  // ---- place everything: clear of walls, doors and each other, furniture in its own room ----
  const doorPts = [...doors.map(d => d.vertical ? { x: d.at, z: d.c } : { x: d.c, z: d.at }), level.frontDoor];
  const placed = [];
  const totalArea = rooms.reduce((a, r) => a + area(r), 0);
  const roomByArea = () => { let t = rng() * totalArea; for (const r of rooms) { t -= area(r); if (t <= 0) return r; } return rooms[0]; };
  entries.sort((a, b) => (ITEM_TYPES[b[0]].furniture ? 1 : 0) - (ITEM_TYPES[a[0]].furniture ? 1 : 0) || cellsOf(b[0]) - cellsOf(a[0])); // big pieces first
  entries.forEach(([type, ri]) => {
    const t = ITEM_TYPES[type];
    const halfX = t.furniture ? t.w / 2 + 0.7 : 0.9, halfZ = t.furniture ? t.d / 2 + 0.7 : 0.9;
    const hw = Math.max(t.w, 1) / 2, hd = Math.max(t.d, 1) / 2;
    const inYard = ri === -2;
    const own = ri >= 0 ? rooms[ri] : null;
    /** can this piece sit at (x, z)? walls checked against its real rectangle; doorways and other pieces kept clear */
    const fits = (x, z, tight, yard) => {
      if (!yard && (x - halfX < x0 || x + halfX > x1 || z - halfZ < z0 || z + halfZ > z1)) return false;
      if (t.furniture ? [[-1, -1], [1, -1], [-1, 1], [1, 1], [0, -1], [0, 1], [-1, 0], [1, 0], [0, 0]].some(([sx, sz]) => level.hitsWall(x + sx * hw, z + sz * hd, 0.45))
        : level.hitsWall(x, z, 0.7)) return false;
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
      const overflow = exact && tries >= 160 && !t.furniture; // a full house spills a few boxes onto the lawn
      if (inYard || overflow) { x = R(x1 + 2, 8); z = R(-12, 12); if (Math.abs(z) < 4 && x > 5) continue; }
      else if (type === 'coffeetable' && tries < 12 && placed.some(([pt]) => pt === 'couch')) { // in front of the couch, like a real living room
        const [, cx, cz] = placed.find(([pt]) => pt === 'couch');
        [x, z] = [[cx, cz + 1.6], [cx, cz - 1.6], [cx + 0.6, cz + 1.7], [cx - 0.6, cz - 1.7], [cx + 2.6, cz], [cx - 2.6, cz]][tries % 6];
      }
      else { const r = own && (t.furniture || tries < 150) ? own : roomByArea(); x = R(r.x0 + halfX, r.x1 - halfX); z = R(r.z0 + halfZ, r.z1 - halfZ); }
      x = Math.round(x * 10) / 10; z = Math.round(z * 10) / 10;
      if (!fits(x, z, false, inYard || overflow)) continue;
      placed.push([type, x, z]);
      return;
    }
    if (own) { // a crowded room: scan it on a fine grid, a little tighter, before giving up
      for (const tight of [false, true]) for (let x = own.x0 + halfX; x <= own.x1 - halfX + 1e-6; x += 0.3) for (let z = own.z0 + halfZ; z <= own.z1 - halfZ + 1e-6; z += 0.3) {
        const px = Math.round(x * 10) / 10, pz = Math.round(z * 10) / 10;
        if (fits(px, pz, tight, false)) { placed.push([type, px, pz]); return; }
      }
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
    level.props.push({ kind: 'rug', x: (r.x0 + r.x1) / 2, z: (r.z0 + r.z1) / 2, w: Math.min(5, w * 0.45), d: Math.min(3.5, d * 0.35), color: pick([0xc8734f, 0xd9b26a, 0x8a9a6b, 0xb5654a, 0xe0c9a0]) }); // warm rugs (terracotta, mustard, sage, rust, oat)
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
