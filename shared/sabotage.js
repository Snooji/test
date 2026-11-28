// Sabotage, "pack the house": the rules and numbers shared by the server, the AI, the client and the tests.
// (docs/superpowers/specs/2026-11-28-sabotage-packing-design.md)

export const SAB = {
  PACK_SOLO: 7, PACK_PAIR: 3,             // seconds to pack a flat box in a room: alone / with a partner holding alongside
  REPACK_SOLO: 5, REPACK_PAIR: 2.5,       // seconds to repack a burst box's pile
  PAIR_RADIUS: 1.5,                       // a partner within this many metres speeds a two-person job up
  PILE_FULL_S: 10, PILE_HALF_S: 40,       // a pile keeps full value for 10 s, then fades to half by 40 s
  SAB_COOLDOWN: 20,                       // seconds between one saboteur's sabotages
  WEAK_BATCH: 3, WEAK_BURST_ON_LIFT: 0.35, WEAK_BURST_PER_S: 0.02,
  LIGHTS_OUT_S: 40, PADS_OUT_S: 30, INSPECT_COOLDOWN: 20, MEETING_COOLDOWN: 30,
  LOSS_LINE: 0.35,                        // saboteurs win once this share of the house's value is lost
  SAFETY_LINE: 70,                        // the crew must drive off at this safety % or better
  GHOST_SPEED: 0.5, DAMAGED_VALUE: 0.5, SIGHT_M: 9, DARK_SIGHT_M: 2,
};

/** seconds each hold takes */
export const HOLD = { weaken: 2, cutTape: 1.5, mislabel: 2, loosen: 2, snag: 2, stashPads: 2, lightsOut: 1.5, pullTruck: 2.5,
  retape: 2, fixWheel: 3, refillPads: 2, breaker: 2, inspect: 2, restrap: 3 };

/** what's in each room's boxes: [standard, heavy, fragile] shares. Halls, passages and stairs hold no boxes. */
const KIDS = [0.75, 0.05, 0.2];
export const BOX_MIX = {
  kitchen: [0.25, 0.15, 0.6], bathroom: [0, 0, 1], living: [0.45, 0.3, 0.25], office: [0.3, 0.45, 0.25],
  bedroom: [0.55, 0.15, 0.3], dining: [0.5, 0.3, 0.2], garage: [0.35, 0.65, 0], laundry: [0.55, 0.4, 0.05],
  kids: KIDS, play: KIDS, den: [0.6, 0.25, 0.15], storage: [0.5, 0.45, 0.05],
};
const NO_BOXES = new Set(['hall', 'passage', 'stairs']);
const TYPES = ['standard', 'heavy', 'fragile'];

/** split n by weights into whole numbers that add up to n (largest remainder) */
function apportion(weights, n) {
  const sum = weights.reduce((a, b) => a + b, 0) || 1;
  const raw = weights.map(w => (w / sum) * n), out = raw.map(Math.floor);
  let left = n - out.reduce((a, b) => a + b, 0);
  const order = raw.map((r, i) => [r - Math.floor(r), i]).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  for (let k = 0; left > 0; k = (k + 1) % order.length, left--) out[order[k][1]]++;
  return out;
}

/** boxes per room: every room that holds boxes gets at least one (when there are enough), the rest by floor area */
export function roomQuotas(rooms, boxCells) {
  const eligible = rooms.map((r, i) => [r, i]).filter(([r]) => !NO_BOXES.has(r.role));
  const q = new Map();
  if (!eligible.length || boxCells <= 0) return q;
  const area = (r) => (r.x1 - r.x0) * (r.z1 - r.z0);
  const base = Math.min(1, Math.floor(boxCells / eligible.length)) ? 1 : 0;
  // fewer boxes than rooms: the biggest rooms get one each
  if (!base) { [...eligible].sort((a, b) => area(b[0]) - area(a[0])).slice(0, boxCells).forEach(([, i]) => q.set(i, 1)); return q; }
  const extra = apportion(eligible.map(([r]) => area(r)), boxCells - eligible.length);
  eligible.forEach(([, i], k) => q.set(i, 1 + extra[k]));
  return q;
}

/** the room's n boxes, in a shuffled order (each box's type is only revealed when it's packed) */
export function mixBag(role, n, rng = Math.random) {
  const counts = apportion(BOX_MIX[role] || [1, 0, 0], n);
  const bag = counts.flatMap((c, k) => Array(c).fill(TYPES[k]));
  for (let i = bag.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [bag[i], bag[j]] = [bag[j], bag[i]]; }
  return bag;
}

/** how much of a burst box's contents a repack still saves, by how long the pile has been lying there */
export function pileValueFactor(ageSec) {
  if (ageSec <= SAB.PILE_FULL_S) return 1;
  if (ageSec >= SAB.PILE_HALF_S) return 0.5;
  return 1 - 0.5 * (ageSec - SAB.PILE_FULL_S) / (SAB.PILE_HALF_S - SAB.PILE_FULL_S);
}

/** who has won, if anyone (no timer: the round runs until one of these) */
export function sabotageOutcome({ houseValue, lostValue, saboteursAlive, crewAlive, houseEmpty, safety, saboteursOut }) {
  if (saboteursOut) return { winner: 'crew', reason: 'The crew caught every saboteur!' };
  if (houseValue > 0 && lostValue >= SAB.LOSS_LINE * houseValue - 1e-9) return { winner: 'saboteur', reason: 'Too much got broken. The saboteurs win!' };
  if (saboteursAlive >= crewAlive) return { winner: 'saboteur', reason: 'The saboteurs outnumber the crew!' };
  if (houseEmpty) return safety >= SAB.SAFETY_LINE
    ? { winner: 'crew', reason: `The house is empty and the load is ${safety}% safe. The crew wins!` }
    : { winner: 'saboteur', reason: `Failed inspection: the load is only ${safety}% safe. The saboteurs win!` };
  return null;
}
