// Floor plans. A house is a set of rectangles: hallways laid out in one of several shapes (a spine behind the shared rooms,
// a cross hall to the back, a T of both, a side wing, two wings) and rooms sliced off the space around them in either
// orientation, each within its own size range. Walls are then built from the rooms themselves: a wall wherever two rooms
// (or a room and the outside) meet, a door cut wherever two rooms are connected, nothing where two hallways join. So
// wherever a room lands and however it's turned, its door opens onto the hallway it touches.
export const T = 0.4, DOOR = 3.2, HALL_W = 1.9;

/** Size limits per room type, metres: one side within `len` and the other within `dep` (rooms can be turned either way). */
export const ROOM_SIZES = {
  living: { len: [7, 10], dep: [8, 10] }, dining: { len: [6, 8], dep: [8, 10] }, kitchen: { len: [5, 7], dep: [8, 10] },
  main: { len: [7, 9], dep: [6.5, 8] }, bedroom: { len: [6, 9], dep: [6.5, 8] }, kids: { len: [6, 7], dep: [6.5, 8] },
  office: { len: [5, 7], dep: [6.5, 8] }, bathroom: { len: [5, 5.5], dep: [6.5, 8] }, laundry: { len: [5, 6], dep: [6.5, 8] },
  hall: { len: [4, 36], dep: [1.9, 1.9] }, passage: { len: [4, 6], dep: [6.5, 8] },
  stairs: { len: [7, 7.5], dep: [6.5, 10] }, garage: { len: [6, 8], dep: [8, 10] }, den: { len: [6, 10], dep: [6.5, 10] }, play: { len: [5, 8], dep: [6.5, 10] }, storage: { len: [4, 6], dep: [6.5, 10] },
};
const E = 1e-6;
const inR = (v, [lo, hi]) => v >= lo - E && v <= hi + E;
/** does a room of this kind fit an a × b rectangle (either way round)? */
export const sizeOk = (kind, a, b) => { const s = ROOM_SIZES[kind]; return !!s && ((inR(a, s.len) && inR(b, s.dep)) || (inR(b, s.len) && inR(a, s.dep))); };
/** the widths a room of this kind can have in a strip this deep, or null if it can't go there */
function widthRange(kind, depth) {
  const s = ROOM_SIZES[kind]; if (!s) return null;
  const a = inR(depth, s.dep) ? s.len : null, b = inR(depth, s.len) ? s.dep : null;
  if (a && b && Math.max(a[0], b[0]) <= Math.min(a[1], b[1]) + E) return [Math.min(a[0], b[0]), Math.max(a[1], b[1])];
  return a || b;
}
const roleOf = (k) => (k === 'main' || k === 'kids' ? 'bedroom' : k);
const PUBLIC = ['living', 'dining', 'kitchen', 'garage'];
const isPublic = (k) => PUBLIC.includes(k);
const isHall = (r) => r.kind === 'hall';

/**
 * Slice a strip of length L and the given depth into rooms of these kinds. Optional kinds (not in `keep`) are dropped from
 * the end while the minimum won't fit; fillers are added while the maximum falls short. Widths come out in 0.5 m steps
 * (plus any odd remainder on one room). Returns { kinds, lens } or null.
 */
export function fitStrip(rng, kinds, L, depth, { keep = [], fillers = [] } = {}) {
  let ks = kinds.filter(k => widthRange(k, depth));
  if (keep.some(k => kinds.includes(k) && !ks.includes(k))) return null;
  const sum = (arr, i) => arr.reduce((a, k) => a + widthRange(k, depth)[i], 0);
  while (ks.length && sum(ks, 0) > L + E) {
    let i = ks.length - 1; while (i >= 0 && keep.includes(ks[i])) i--;
    if (i < 0) return null;
    ks.splice(i, 1);
  }
  for (let guard = 0; sum(ks, 1) < L - E; guard++) {
    const fit = fillers.filter(k => widthRange(k, depth) && sum(ks, 0) + widthRange(k, depth)[0] <= L + E);
    if (!fit.length || guard > 8) return null;
    const fresh = fit.filter(k => !ks.includes(k)), cand = fresh.length ? fresh : fit; // a room type the strip doesn't have yet
    ks.push(cand[Math.floor(rng() * cand.length)]);
  }
  if (!ks.length) return null;
  const lens = ks.map(k => widthRange(k, depth)[0]);
  let extra = L - lens.reduce((a, b) => a + b, 0);
  for (let guard = 0; extra >= 0.5 - E && guard < 400; guard++) {
    const open = ks.map((_, i) => i).filter(i => lens[i] + 0.5 <= widthRange(ks[i], depth)[1] + E);
    if (!open.length) return null;
    lens[open[Math.floor(rng() * open.length)]] += 0.5; extra -= 0.5;
  }
  if (extra > E) { // an odd remainder (a hallway's width): give it to a room with space for it
    const i = ks.findIndex((k, j) => lens[j] + extra <= widthRange(k, depth)[1] + E);
    if (i < 0) return null;
    lens[i] += extra;
  }
  return { kinds: ks, lens };
}

/** rooms from a strip: axis 'z' stacks them from z0 up; axis 'x' from the front (x1) back */
function stack(blk, axis, kinds, lens, block) {
  const out = [];
  let p = axis === 'z' ? blk.z0 : blk.x1;
  kinds.forEach((k, i) => {
    const last = i === kinds.length - 1;
    if (axis === 'z') { const q = last ? blk.z1 : p + lens[i]; out.push({ x0: blk.x0, x1: blk.x1, z0: p, z1: q, kind: k, role: roleOf(k), block }); p = q; }
    else { const q = last ? blk.x0 : p - lens[i]; out.push({ x0: q, x1: p, z0: blk.z0, z1: blk.z1, kind: k, role: roleOf(k), block }); p = q; }
  });
  return out;
}

/** the edge two rooms share: { vertical, at, lo, hi } (vertical = a wall running along z at x = at), or null */
export function sharedEdge(A, B) {
  for (const [ax, bx] of [[A.x1, B.x0], [A.x0, B.x1]]) if (Math.abs(ax - bx) < E) {
    const lo = Math.max(A.z0, B.z0), hi = Math.min(A.z1, B.z1);
    if (hi - lo > E) return { vertical: true, at: ax, lo, hi };
  }
  for (const [az, bz] of [[A.z1, B.z0], [A.z0, B.z1]]) if (Math.abs(az - bz) < E) {
    const lo = Math.max(A.x0, B.x0), hi = Math.min(A.x1, B.x1);
    if (hi - lo > E) return { vertical: false, at: az, lo, hi };
  }
  return null;
}
const edgeLen = (A, B) => { const e = sharedEdge(A, B); return e ? e.hi - e.lo : 0; };
const canDoor = (A, B, w = DOOR) => edgeLen(A, B) >= w + 0.8 - E;

/**
 * Ground floor plan, at z0 = 0. Returns { rooms, conns, W, D, layout, openPlan, garage } or null when this attempt can't be
 * made to fit (the caller tries again). conns: { a, b, type: 'door' | 'open', w } with a, b rooms.
 */
function planGround(rng, { exact, mansion, multi, layout }) {
  const pickStep = (lo, hi) => lo + 0.5 * Math.floor(rng() * (Math.round((hi - lo) / 0.5) + 1));
  const shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
  const randLen = (kinds, depth) => kinds.reduce((a, k) => { const r = widthRange(k, depth); return a + (r ? pickStep(r[0], r[1]) : 0); }, 0);
  /** How a strip sits next to the one it's built against (length L): the same length (a plain rectangle), shorter and
   *  flush with one end or centred (an L, or a T with the stem out back), or longer, sticking out past one or both ends.
   *  Returns where it starts (relative to the other strip's start) and how long it is. */
  const lineUp = (L, maxTotal = 26) => {
    const u = rng(), cut = pickStep(5, 9);
    if (u < 0.3 || L - cut < 6.5) return { a: 0, len: L };
    if (u < 0.68) { const len = L - cut, k = Math.floor(rng() * 3); return { a: k === 0 ? 0 : k === 1 ? L - len : Math.round(L - len) / 2, len }; } // flush with one end, or centred
    const len = Math.min(maxTotal, L + cut); if (len <= L + E) return { a: 0, len: L };
    const extra = len - L, where = Math.floor(rng() * 3);
    return { a: where === 0 ? 0 : where === 1 ? -extra : -Math.round(extra) / 2, len };
  };
  const tiny = layout === 'cottage';
  // shared rooms: orders where dining touches the living room and the kitchen touches one of them
  const pubOrders = tiny ? [['living', 'kitchen'], ['kitchen', 'living']]
    : [['living', 'dining', 'kitchen'], ['kitchen', 'dining', 'living'], ['dining', 'living', 'kitchen'], ['kitchen', 'living', 'dining']];
  let pub = [...pubOrders[Math.floor(rng() * pubOrders.length)]];
  if (layout === 'wing') pub = ['living', 'dining', 'kitchen']; // a row from the front wall back: the living room takes the front wall
  const garage = !tiny && rng() < 0.3;
  if (garage) { if (pub[0] === 'kitchen' && layout !== 'wing') pub.unshift('garage'); else if (pub[pub.length - 1] === 'kitchen') pub.push('garage'); }
  const openPlan = !tiny && rng() < 0.45;
  const nBeds = tiny ? 1 : mansion ? 3 : exact ? 2 : 1 + Math.floor(rng() * 3);
  const beds = Array.from({ length: nBeds }, (_, i) => (i === 0 ? 'main' : i === 2 ? 'kids' : 'bedroom'));
  // private rooms: bedrooms (upstairs in a multi-floor house, where the ground floor keeps the stairwell instead)
  let priv = multi ? ['stairs', ...shuffle(['office', 'bathroom', 'laundry'])] : shuffle([...beds, 'bathroom', 'office', 'laundry']);
  if (!multi) { const b = priv.findIndex(k => ROOM_SIZES[k] && roleOf(k) === 'bedroom'); if (b > 0) priv.unshift(...priv.splice(b, 1)); } // first, and kept, however short the wing
  if (layout === 'cross' || layout === 'tee') { // rooms either side of a short hall: the stairwell and bedrooms first, at most four (seven in a mansion)
    const rank = (k) => (k === 'stairs' ? 0 : roleOf(k) === 'bedroom' ? 1 : 2);
    priv = priv.map((k, i) => [k, i]).sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1]).map(([k]) => k).slice(0, mansion ? 7 : 4);
  }
  // multi-floor: where the stairs go, always open (no door) and easy to find —
  //   'end':    at the end of the spine hallway, which runs straight onto them
  //   'bay':    a bay off the side of a hallway running across the house (flights perpendicular to it), sometimes at its end
  //   'living': right off the living room, through a wide opening
  let stairAt = null;
  if (multi) {
    stairAt = layout === 'spine' ? (rng() < 0.65 ? 'end' : 'living') : layout === 'wing' ? 'bay' : (rng() < 0.65 ? 'bay' : 'living');
    const li = pub.indexOf('living');
    if (stairAt === 'living' && li > 0 && li < pub.length - 1) stairAt = layout === 'spine' ? 'end' : 'bay'; // living in the middle: no free side
    if (stairAt !== 'bay') priv = priv.filter(k => k !== 'stairs');
    else if (rng() < 0.5) { priv = priv.filter(k => k !== 'stairs'); priv.splice(Math.ceil(priv.length / 2), 0, 'stairs'); } // at the far end of its side of the hall
  }
  const keepPriv = [priv[0], ...(stairAt === 'bay' ? ['stairs'] : [])];
  const FILL = ['office', 'laundry', 'bathroom', 'storage'];
  const rooms = [], conns = [];
  const door = (a, b, w = DOOR) => conns.push({ a, b, type: 'door', w });
  const open = (a, b) => conns.push({ a, b, type: 'open' });
  const hallOf = (x0, x1, z0, z1) => { const h = { x0, x1, z0, z1, kind: 'hall', role: 'hall', block: 'hall' }; rooms.push(h); return h; };
  /** doors along a strip of shared rooms (living–dining, dining–kitchen, kitchen–garage, living–kitchen) */
  const pubDoors = (strip) => {
    for (let i = 1; i < strip.length; i++) {
      const a = strip[i - 1], b = strip[i];
      if (!isPublic(a.kind) || !isPublic(b.kind)) continue;
      const pair = [a.kind, b.kind].sort().join();
      if (a.kind === 'garage' || b.kind === 'garage') { if (pair === 'garage,kitchen') door(a, b); continue; }
      door(a, b, openPlan && pair === 'dining,living' && canDoor(a, b, 5) ? 5 : DOOR);
    }
  };
  /** every room of a strip opens onto the hallway it touches (shared rooms: the living room always, others now and then) */
  const toHall = (strip, hall, pSome = 0.5) => {
    for (const r of strip) {
      if (!canDoor(r, hall)) continue;
      if (r.kind === 'garage' || r.kind === 'stairs') continue; // (stairs connect by an opening, set where they're placed)
      if (!isPublic(r.kind) || r.kind === 'living' || rng() < pSome) door(r, hall);
    }
  };
  const ensuite = (strip) => { for (let i = 1; i < strip.length; i++) { const [a, b] = [strip[i - 1], strip[i]]; const ks = [roleOf(a.kind), roleOf(b.kind)]; if (ks.includes('bedroom') && ks.includes('bathroom') && rng() < 0.3 && canDoor(a, b)) door(a, b); } };

  const wF = pickStep(8, 10);
  if (tiny || layout === 'spine' || layout === 'tee' || layout === 'cross') {
    // ---- shared rooms along the front wall (x1 side), stacked along z ----
    const extra = (layout !== 'cross' && !tiny && !multi && rng() < 0.3) ? (wF <= 9 && nBeds < 3 && rng() < 0.5 ? 'bedroom' : 'den') : null;
    let front = [...pub]; if (extra) { if (rng() < 0.5) front.push(extra); else front.unshift(extra); }
    if (stairAt === 'living') { if (front.indexOf('living') === 0) front.unshift('stairs'); else front.push('stairs'); } // on the living room's free side
    let L;
    if (layout === 'cross' || layout === 'tee') {
      // the space behind is two blocks either side of a hall running to the back: its depth sets the house length
      var dN = pickStep(6.5, 8), dS = pickStep(6.5, 8);
      L = dN + HALL_W + dS;
    } else L = Math.min(26, Math.round(randLen(front, wF) * 2) / 2);
    const fs = fitStrip(rng, front, L, wF, { keep: ['living', 'kitchen', ...(stairAt === 'living' ? ['stairs'] : [])], fillers: layout === 'cross' ? ['den'] : ['den', 'office', 'storage'] });
    if (!fs) return null;
    const fBlk = { x0: -wF, x1: 0, z0: 0, z1: L };
    const F = stack(fBlk, 'z', fs.kinds, fs.lens, 'front'); rooms.push(...F);
    pubDoors(F);
    if (stairAt === 'living') { // the stairs open straight off the living room (a wide opening onto the landing)
      const st = F.find(r => r.kind === 'stairs'), lv = F.find(r => r.kind === 'living');
      if (!st || !sharedEdge(st, lv)) return null;
      st.block = 'stairs'; st.laneSide = 'x0'; open(st, lv);
    }
    if (tiny) { // cottage: bedroom straight off the living room, bathroom off the bedroom
      const wB = pickStep(6.5, 8);
      const living = F.find(r => r.kind === 'living');
      const order = living.z0 < E ? ['main', 'bathroom'] : ['bathroom', 'main'];
      const bs = fitStrip(rng, order, L, wB, { keep: ['main'], fillers: ['bathroom'] });
      if (!bs) return null;
      const B = stack({ x0: -wF - wB, x1: -wF, z0: 0, z1: L }, 'z', bs.kinds, bs.lens, 'back'); rooms.push(...B);
      const bed = B.find(r => r.kind === 'main');
      if (!bed || !canDoor(living, bed)) return null;
      door(living, bed);
      for (const r of B) if (r !== bed) { if (canDoor(r, bed)) door(r, bed); else return null; }
      return { rooms, conns, W: wF + wB, D: L, layout, openPlan: false, garage: false };
    }
    if (layout === 'cross') {
      // ---- a hall from the shared rooms straight to the back wall, private rooms either side of it ----
      const hz0 = dN, hz1 = dN + HALL_W;
      const cover = F.find(r => r.z0 <= hz0 - 0.3 + E && r.z1 >= hz1 + 0.3 - E);
      if (!cover || !isPublic(cover.kind) || cover.kind === 'garage') return null;
      const half = Math.ceil(priv.length / 2), pa = priv.slice(0, half), pb = priv.slice(half);
      // each side of the hall runs back as far as its own rooms need: different lengths leave a notch at a back corner
      const Lx = Math.round(randLen(pa, dN) * 2) / 2, LxS = Math.round(randLen(pb.length ? pb : ['office'], dS) * 2) / 2;
      const na = fitStrip(rng, pa, Lx, dN, { keep: keepPriv, fillers: FILL }), nb = na && fitStrip(rng, pb.length ? pb : ['office'], LxS, dS, { fillers: FILL });
      if (!na || !nb || na.kinds.length + nb.kinds.length > (mansion ? 8 : 5)) return null;
      const LxMax = Math.max(Lx, LxS);
      const hall = hallOf(-wF - LxMax, -wF, hz0, hz1);
      const N = stack({ x0: -wF - Lx, x1: -wF, z0: 0, z1: hz0 }, 'x', na.kinds, na.lens, 'north');
      const S = stack({ x0: -wF - LxS, x1: -wF, z0: hz1, z1: L }, 'x', nb.kinds, nb.lens, 'south');
      rooms.push(...N, ...S);
      open(cover, hall);
      for (const r of [...N, ...S]) { if (r.kind === 'stairs') { open(r, hall); r.laneSide = 'x0'; continue; } if (!canDoor(r, hall)) return null; door(r, hall); }
      ensuite(N); ensuite(S);
      return { rooms, conns, W: wF + LxMax, D: L, layout, openPlan, garage: fs.kinds.includes('garage') };
    }
    // ---- a hallway along the back of the shared rooms (spine: it also runs the length of the private wing behind,
    //      which can be shorter, longer or offset: L- and T-shaped houses) ----
    const wingSpan = layout === 'spine' ? lineUp(L) : { a: 0, len: L };
    let h0 = Math.min(0, wingSpan.a), h1 = Math.max(L, wingSpan.a + wingSpan.len);
    if (h1 - h0 > 26 + E) return null;
    const wB0 = pickStep(6.5, 8);
    let endStairs = null;
    if (stairAt === 'end') { // the last 7 m of the hallway and the wing beside it become the stairwell: the hall runs onto the stairs
      const SL = pickStep(7, 7.5), atEnd = rng() < 0.5;
      const z0s = atEnd ? h1 - SL : h0, z1s = atEnd ? h1 : h0 + SL;
      if (atEnd) h1 -= SL; else h0 += SL;
      const wa = Math.max(wingSpan.a, h0), wb = Math.min(wingSpan.a + wingSpan.len, h1);
      if (wb - wa < 6.5 - E) return null;
      wingSpan.a = wa; wingSpan.len = wb - wa;
      endStairs = { x0: -wF - HALL_W - wB0, x1: -wF, z0: z0s, z1: z1s, kind: 'stairs', role: 'stairs', block: 'stairs', laneSide: 'x0' };
    }
    const hall = hallOf(-wF - HALL_W, -wF, h0, h1);
    if (endStairs) {
      rooms.push(endStairs);
      open(endStairs, hall);
      const lv = rooms.find(r => r.kind === 'living' && sharedEdge(r, endStairs));
      if (lv) open(endStairs, lv); // the living room beside it opens onto the stairs too
    }
    toHall(F, hall);
    const hx0 = -wF - HALL_W;
    if (layout === 'tee') { // ... with a second hall off it, straight to the back wall, private rooms either side
      const hz0 = dN, hz1 = dN + HALL_W;
      const half = Math.ceil(priv.length / 2), pa = priv.slice(0, half), pb = priv.slice(half);
      const Lx = Math.round(randLen(pa, dN) * 2) / 2, LxS = Math.round(randLen(pb.length ? pb : ['office'], dS) * 2) / 2; // (see cross)
      const na = fitStrip(rng, pa, Lx, dN, { keep: keepPriv, fillers: FILL }), nb = na && fitStrip(rng, pb.length ? pb : ['office'], LxS, dS, { fillers: FILL });
      if (!na || !nb || na.kinds.length + nb.kinds.length > (mansion ? 8 : 4)) return null;
      const LxMax = Math.max(Lx, LxS);
      const xh = hallOf(hx0 - LxMax, hx0, hz0, hz1);
      open(hall, xh);
      const N = stack({ x0: hx0 - Lx, x1: hx0, z0: 0, z1: hz0 }, 'x', na.kinds, na.lens, 'north');
      const S = stack({ x0: hx0 - LxS, x1: hx0, z0: hz1, z1: L }, 'x', nb.kinds, nb.lens, 'south');
      rooms.push(...N, ...S);
      for (const r of [...N, ...S]) {
        if (r.kind === 'stairs') { open(r, xh); r.laneSide = 'x0'; continue; } // a bay off the hall: no door, flights running away from it
        const viaSpine = canDoor(r, hall) && rng() < 0.35; // the room on the corner may open onto either hall
        if (viaSpine) door(r, hall); else if (canDoor(r, xh)) door(r, xh); else return null;
      }
      ensuite(N); ensuite(S);
      return { rooms, conns, W: wF + HALL_W + LxMax, D: L, layout, openPlan, garage: fs.kinds.includes('garage') };
    }
    // spine: one wing of private rooms behind the hallway (two wings joined by a passage in a Moon Mansion)
    let x = hx0, prevHall = hall;
    const wings = mansion ? 2 : 1;
    const wingLists = mansion
      ? (multi ? [['stairs', 'passage', 'bathroom', 'office'], ['den', 'laundry', 'office', 'bathroom']] : [['passage', beds[0], 'bathroom', 'office'], [beds[1], beds[2], 'laundry', 'den', 'bathroom']])
      : [priv];
    if (stairAt && stairAt !== 'bay') wingLists[0] = wingLists[0].filter(k => k !== 'stairs');
    for (let wi = 0; wi < wings; wi++) {
      const wB = wi === 0 ? wB0 : pickStep(6.5, 8);
      const keep = wingLists[wi].filter(k => k === 'stairs' || k === 'passage' || k === wingLists[wi][0]);
      const ws = fitStrip(rng, wingLists[wi], wingSpan.len, wB, { keep, fillers: FILL });
      if (!ws) return null;
      const B = stack({ x0: x - wB, x1: x, z0: wingSpan.a, z1: wingSpan.a + wingSpan.len }, 'z', ws.kinds, ws.lens, 'wing' + wi);
      rooms.push(...B);
      for (const r of B) { if (r.kind === 'stairs') { open(r, prevHall); r.laneSide = 'x0'; continue; } if (!canDoor(r, prevHall)) return null; door(r, prevHall); }
      ensuite(B);
      x -= wB;
      if (wi < wings - 1) { // the next wing: another hallway, reached through this wing's passage
        const pass = B.find(r => r.kind === 'passage');
        const h2 = hallOf(x - HALL_W, x, wingSpan.a, wingSpan.a + wingSpan.len);
        if (!pass || !canDoor(pass, h2)) return null;
        door(pass, h2);
        prevHall = h2; x -= HALL_W;
      }
    }
    return { rooms, conns, W: -x, D: L, layout, openPlan, garage: fs.kinds.includes('garage') };
  }

  if (layout === 'wing') {
    // ---- side wing: the shared rooms in a row from the front wall back (living room first), a hallway running the
    //      width of the house beside them, private rooms along its other side (and a second wing beyond in a mansion) ----
    const dP = pickStep(8, 10);
    const W = Math.round(randLen(pub, dP) * 2) / 2;
    const ps = fitStrip(rng, pub, W, dP, { keep: ['living', 'kitchen'], fillers: ['den'] });
    if (!ps || ps.kinds[0] !== 'living') return null;
    const two = mansion;
    const dQ = pickStep(6.5, 8), dQ2 = two ? pickStep(6.5, 8) : 0;
    const D = dP + HALL_W + dQ + (two ? HALL_W + dQ2 : 0);
    if (D > 26 + E) return null;
    const z0P = two ? dQ2 + HALL_W : 0;
    const P = stack({ x0: -W, x1: 0, z0: z0P, z1: z0P + dP }, 'x', ps.kinds, ps.lens, 'front');
    rooms.push(...P);
    pubDoors(P);
    const sides = two ? [[z0P + dP, 1, dQ], [z0P, -1, dQ2]] : [[z0P + dP, 1, dQ]];
    const lists = two ? [priv.slice(0, Math.ceil(priv.length / 2)), priv.slice(Math.ceil(priv.length / 2))] : [priv];
    for (let si = 0; si < sides.length; si++) {
      const [edge, dir, dep] = sides[si];
      const h = dir > 0 ? hallOf(-W, 0, edge, edge + HALL_W) : hallOf(-W, 0, edge - HALL_W, edge);
      toHall(P, h);
      // the private wing can stop short of the front wall or the back, or run deeper than the shared rooms
      const sp = lineUp(W, 34);
      const qx1 = Math.min(0, -sp.a), qx0 = qx1 - sp.len; // measured back from the front wall, never out past it toward the truck
      const qs = fitStrip(rng, lists[si].length ? lists[si] : ['office'], sp.len, dep, { keep: si === 0 ? keepPriv : [], fillers: FILL });
      if (!qs || qs.kinds.length > (mansion ? 5 : 4)) return null;
      if (qx0 < -W - E) { // deeper than the shared rooms: the hallway runs on to reach them
        const hh = rooms.find(r => r === h); hh.x0 = qx0;
      }
      const blk = dir > 0 ? { x0: qx0, x1: qx1, z0: edge + HALL_W, z1: edge + HALL_W + dep } : { x0: qx0, x1: qx1, z0: edge - HALL_W - dep, z1: edge - HALL_W };
      const Q = stack(blk, 'x', qs.kinds, qs.lens, 'wing' + si);
      rooms.push(...Q);
      for (const r of Q) { if (r.kind === 'stairs') { open(r, h); r.laneSide = 'x0'; continue; } if (!canDoor(r, h)) return null; door(r, h); }
      ensuite(Q);
    }
    return { rooms, conns, W: -Math.min(...rooms.map(r => r.x0)), D, layout, openPlan, garage: ps.kinds.includes('garage') };
  }
  return null;
}

/** Upstairs: the same walls (stairwell, hallways, passage), new rooms: this floor's bedrooms, then whatever fits. */
function planUpper(rng, ground, bedsHere, drop = null) {
  // `drop`: ground rooms this floor leaves out (a smaller upper floor, set back over the private wing; roofed below)
  const kept = ground.rooms.filter(r => !drop?.has(r));
  const rooms = kept.map(r => ({ ...r }));
  const at = new Map(kept.map((r, i) => [r, rooms[i]]));
  const halls = rooms.filter(isHall);
  const touchesHall = (r) => halls.some(h => canDoor(r, h));
  const pool = ['bathroom', 'office', 'laundry', 'den', 'play', 'storage'];
  const free = rooms.filter(r => !isHall(r) && r.kind !== 'stairs' && r.kind !== 'passage');
  // bedrooms go in rooms on a hallway that are bedroom-sized
  const order = free.map((r, i) => [r, (i * 7 + Math.floor(rng() * 1000)) % 997]).sort((a, b) => a[1] - b[1]).map(([r]) => r);
  const beds = [...bedsHere];
  const done = new Set();
  for (const onHall of [true, false]) for (const r of order) { // a room on a hallway if there is one
    if (!beds.length || done.has(r) || touchesHall(r) !== onHall) continue;
    const k = beds.find(b => sizeOk(b, r.x1 - r.x0, r.z1 - r.z0));
    if (k) { r.kind = k; r.role = roleOf(k); beds.splice(beds.indexOf(k), 1); done.add(r); }
  }
  const used = {};
  for (const r of order) {
    if (done.has(r)) continue;
    const w = r.x1 - r.x0, d = r.z1 - r.z0;
    const opts = pool.filter(k => sizeOk(k, w, d)).sort((a, b) => (used[a] || 0) - (used[b] || 0));
    const k = opts.length ? opts[Math.min(opts.length - 1, Math.floor(rng() * Math.min(2, opts.length)))] : null;
    if (!k) return null;
    r.kind = k; r.role = k; used[k] = (used[k] || 0) + 1;
  }
  // connections: hallway joins and the stairwell / passage doors as downstairs; every other room opens onto a hallway it
  // touches, or failing that onto a room next door that's already reachable
  const conns = [];
  for (const c of ground.conns) {
    const a = at.get(c.a), b = at.get(c.b);
    if (!a || !b) continue; // one end isn't on this floor
    if (c.type === 'open' || ['stairs', 'passage'].includes(a.kind) || ['stairs', 'passage'].includes(b.kind)) conns.push({ ...c, a, b });
  }
  const linked = new Set(halls);
  for (const c of conns) { linked.add(c.a); linked.add(c.b); }
  for (const r of free) {
    const h = halls.find(h => canDoor(r, h));
    if (h) { conns.push({ a: r, b: h, type: 'door', w: DOOR }); linked.add(r); }
  }
  for (let guard = 0; guard < 20 && free.some(r => !linked.has(r)); guard++) {
    for (const r of free) {
      if (linked.has(r)) continue;
      const n = rooms.find(o => linked.has(o) && !isHall(o) && canDoor(r, o));
      if (n) { conns.push({ a: r, b: n, type: 'door', w: DOOR }); linked.add(r); }
    }
  }
  if (free.some(r => !linked.has(r))) return null;
  // everything on this floor must be reachable from its stairwell (a dropped block could cut a hallway off)
  const wellUp = rooms.find(r => r.kind === 'stairs');
  if (wellUp) {
    const seen = new Set([wellUp]);
    for (let grew = true; grew;) { grew = false; for (const c of conns) for (const [p, q] of [[c.a, c.b], [c.b, c.a]]) if (seen.has(p) && !seen.has(q)) { seen.add(q); grew = true; } }
    if (rooms.some(r => !seen.has(r))) return null;
  }
  return { rooms, conns };
}

/**
 * Walls for one floor from its rooms: along every line where room edges lie, a wall over each stretch with a room on
 * at least one side, except where the two rooms are joined by an opening; door gaps cut where they're joined by a door.
 * Returns { walls, doors, opens } (doors in the renderer's format { vertical, at, c, w }).
 */
export function buildWalls(rng, rooms, conns, { frontDoor = null, x1 = null } = {}) {
  const gaps = [], doors = [], opens = [];
  const openPairs = new Set();
  const key = (a, b) => [rooms.indexOf(a), rooms.indexOf(b)].sort((p, q) => p - q).join();
  for (const c of conns) {
    const e = sharedEdge(c.a, c.b);
    if (!e) throw new Error(`plan: ${c.a.kind} and ${c.b.kind} don't touch`);
    if (c.type === 'open') { openPairs.add(key(c.a, c.b)); opens.push({ vertical: e.vertical, at: e.at, c: (e.lo + e.hi) / 2, w: e.hi - e.lo }); continue; }
    const w = c.w || DOOR, len = e.hi - e.lo;
    const m = len >= w + 1.6 ? 0.8 : 0.4;
    if (len < w + 2 * m - E) throw new Error(`plan: no room for a door between ${c.a.kind} and ${c.b.kind}`);
    const cc = e.lo + w / 2 + m + rng() * (len - w - 2 * m);
    gaps.push({ vertical: e.vertical, at: e.at, lo: cc - w / 2, hi: cc + w / 2 });
    doors.push({ vertical: e.vertical, at: e.at, c: cc, w });
  }
  if (frontDoor) gaps.push({ vertical: true, at: x1, lo: frontDoor - DOOR * 0.6, hi: frontDoor + DOOR * 0.6 });
  const walls = [];
  for (const vertical of [false, true]) {
    // vertical walls run along z at a fixed x; horizontal ones along x at a fixed z
    const lines = new Set(rooms.flatMap(r => (vertical ? [r.x0, r.x1] : [r.z0, r.z1]).map(v => Math.round(v * 1000) / 1000)));
    for (const v of lines) {
      const onLine = (r, side) => Math.abs((vertical ? (side ? r.x0 : r.x1) : (side ? r.z0 : r.z1)) - v) < 1e-3;
      const near = rooms.filter(r => onLine(r, 0) || onLine(r, 1));
      const cuts = [...new Set(near.flatMap(r => (vertical ? [r.z0, r.z1] : [r.x0, r.x1])))].sort((a, b) => a - b);
      let run = null;
      const flush = () => { if (run && run[1] - run[0] > 0.05) walls.push(vertical ? { x0: v - T / 2, x1: v + T / 2, z0: run[0], z1: run[1] } : { x0: run[0], x1: run[1], z0: v - T / 2, z1: v + T / 2 }); run = null; };
      const lineGaps = gaps.filter(g => g.vertical === vertical && Math.abs(g.at - v) < 1e-3);
      for (let i = 1; i < cuts.length; i++) {
        const a = cuts[i - 1], b = cuts[i], mid = (a + b) / 2;
        const inSpan = (r) => (vertical ? r.z0 < mid && r.z1 > mid : r.x0 < mid && r.x1 > mid);
        const lo = near.find(r => onLine(r, 0) && inSpan(r)), hi = near.find(r => onLine(r, 1) && inSpan(r));
        if ((!lo && !hi) || (lo && hi && openPairs.has(key(lo, hi)))) { flush(); continue; }
        // this stretch is wall, minus any door gaps in it
        let p = a;
        for (const g of lineGaps.filter(g => g.hi > a && g.lo < b).sort((g1, g2) => g1.lo - g2.lo)) {
          if (g.lo > p) { if (run && Math.abs(run[1] - p) < 1e-6) run[1] = g.lo; else { flush(); run = [p, g.lo]; } }
          flush(); p = Math.max(p, g.hi);
        }
        if (b > p) { if (run && Math.abs(run[1] - p) < 1e-6) run[1] = b; else { flush(); run = [p, b]; } }
      }
      flush();
    }
  }
  return { walls, doors, opens };
}

const LAYOUTS = ['spine', 'spine', 'cross', 'tee', 'wing', 'wing'];
/**
 * A whole house: ground floor plus upstairs floors, in local coordinates (x1 = 0 at the front wall, z0 = 0).
 * Returns { floors: [{ rooms, conns }], W, D, layout, openPlan, garage }.
 */
export function planHouse(rng, { exact = false, mansion = false, floors = 1 } = {}) {
  const multi = floors > 1;
  const bedKinds = ['main', 'bedroom', 'kids'];
  /** upstairs floors on this ground plan, or null if they can't be made (or, in a house with stairs, no bedroom fits up there) */
  const uppers = (ground) => {
    const out = [];
    // some houses are smaller upstairs: from floor `from` up, the front block of shared rooms is single-storey (roofed)
    const front = ground.rooms.filter(r => r.block === 'front');
    const smaller = multi && rng() < 0.45 && front.length && !ground.rooms.some(r => r.block === 'front' && r.kind === 'stairs');
    let from = smaller ? 1 + Math.floor(rng() * (floors - 1)) : floors;
    for (let k = 1; k < floors; k++) {
      const bedsHere = bedKinds.filter((_, i) => i % (floors - 1) === k - 1);
      let up = null;
      if (k >= from) {
        for (let attempt = 0; attempt < 6 && !up; attempt++) up = planUpper(rng, ground, bedsHere, new Set(front));
        if (!up && k > from) return null; // a floor above can never be bigger than the one below it (nothing to stand on)
        if (!up) from = floors;            // couldn't set this one back: the whole house keeps its full footprint
      }
      for (let attempt = 0; attempt < 6 && !up; attempt++) up = planUpper(rng, ground, bedsHere);
      if (!up) return null;
      out.push(up);
    }
    if (multi && !out.some(f => f.rooms.some(r => r.role === 'bedroom'))) return null;
    return out;
  };
  for (let attempt = 0; attempt < 80; attempt++) {
    const layout = !multi && !mansion && !exact && rng() < 0.15 ? 'cottage' : LAYOUTS[Math.floor(rng() * LAYOUTS.length)];
    const g = planGround(rng, { exact, mansion, multi, layout: mansion && layout === 'cross' ? 'spine' : layout });
    if (!g) continue;
    // strips of different lengths can start before z = 0: put the house's corner back at (front wall, z = 0)
    const zMin = Math.min(...g.rooms.map(r => r.z0)), zMax = Math.max(...g.rooms.map(r => r.z1));
    for (const r of g.rooms) { r.z0 -= zMin; r.z1 -= zMin; }
    g.D = zMax - zMin; g.W = -Math.min(...g.rooms.map(r => r.x0));
    if (g.D > 26 + E) continue;
    { // every room reachable from the living room (a stairwell taking the end of a hall mustn't cut a room off)
      const seen = new Set([g.rooms.find(r => r.kind === 'living')]);
      for (let grew = true; grew;) { grew = false; for (const c of g.conns) for (const [p, q] of [[c.a, c.b], [c.b, c.a]]) if (seen.has(p) && !seen.has(q)) { seen.add(q); grew = true; } }
      if (g.rooms.some(r => !seen.has(r))) continue;
    }
    if (!mansion && !multi && g.rooms.length > 9) continue; // a family home, not a maze
    if (g.W > (mansion ? 36 : 34)) continue;               // the yard and the world edge
    const up = uppers(g);
    if (!up) continue;
    return { floors: [{ rooms: g.rooms, conns: g.conns }, ...up], W: g.W, D: g.D, layout: g.layout, openPlan: g.openPlan, garage: g.garage };
  }
  throw new Error('house plan: no layout fitted'); // never seen across thousands of seeds (test/houseplan.test.js)
}
