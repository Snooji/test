// Map layout shared by server (collision, spawns) and client (rendering).
// Top-down coordinates: x → right (toward the truck), z → down. Units ≈ meters.

export const CELL = 1.2;                 // truck grid cell size
export const TRUCK = {
  bayX0: 13, bayX1: 13 + 4 * CELL,       // cargo bay (x 13 → 17.8)
  z0: -2 * CELL, z1: 2 * CELL,           // bay width (z −2.4 → 2.4)
  cabX1: 21.5,
  floorY: 0.5,
  ramp: { x0: 9.4, x1: 13, z0: -2.4, z1: 2.4 }, // standing here with an item = load mode
};

/** grid (gx along z / width, gz along x / depth, gz=0 nearest the cab) → world center of cell */
export function gridToWorld(gx, gz, y, w = 1, d = 1) {
  return {
    x: TRUCK.bayX1 - (gz + d / 2) * CELL,
    z: TRUCK.z0 + (gx + w / 2) * CELL,
    y: TRUCK.floorY + y * CELL,
  };
}

const T = 0.4; // wall thickness
const wallH = (x0, x1, z) => ({ x0, x1, z0: z - T / 2, z1: z + T / 2 });
const wallV = (x, z0, z1) => ({ x0: x - T / 2, x1: x + T / 2, z0, z1 });

// House: x −22 → 0, z −12 → 12. Four rooms, front door on the right wall (living room).
export const ROOMS = [
  { name: 'Living Room', x0: -11, x1: 0, z0: -12, z1: 0, floor: 0x3b3561 },
  { name: 'Kitchen', x0: -11, x1: 0, z0: 0, z1: 12, floor: 0x2f4f5e },
  { name: 'Bedroom', x0: -22, x1: -11, z0: -12, z1: 0, floor: 0x4a3358 },
  { name: 'Star Office', x0: -22, x1: -11, z0: 0, z1: 12, floor: 0x33465e },
];

export const WALLS = [
  // outer
  wallH(-22, 0, -12), wallH(-22, 0, 12), wallV(-22, -12, 12),
  wallV(0, -12, -6), wallV(0, -2, 12),          // front door gap z −6 → −2
  // interior vertical x=−11, doors z −7→−4 and 4→7
  wallV(-11, -12, -7), wallV(-11, -4, 4), wallV(-11, 7, 12),
  // interior horizontal z=0, doors x −17→−14 and −6→−3
  wallH(-22, -17, 0), wallH(-14, -6, 0), wallH(-3, 0, 0),
  // truck body: side walls + cab; invisible lip stops walking into the bay
  { x0: 13, x1: TRUCK.cabX1, z0: -2.8, z1: -2.4 },
  { x0: 13, x1: TRUCK.cabX1, z0: 2.4, z1: 2.8 },
  { x0: 13, x1: 13.3, z0: -2.4, z1: 2.4, invisible: true },
  // yard bounds
  { x0: -24, x1: 24, z0: -15, z1: -14, invisible: true },
  { x0: -24, x1: 24, z0: 14, z1: 15, invisible: true },
  { x0: -24, x1: -23, z0: -15, z1: 15, invisible: true },
  { x0: 23, x1: 24, z0: -15, z1: 15, invisible: true },
];

// Decorative props (client only; no collision so nothing gets stuck).
export const PROPS = [
  { kind: 'rug', x: -5.5, z: -6, w: 5, d: 3.5, color: 0xe76f51 },
  { kind: 'rug', x: -16.5, z: -6, w: 4, d: 3, color: 0x8ecae6 },
  { kind: 'counter', x: -5.5, z: 11, w: 10, d: 1.2, color: 0xdddddd },
  { kind: 'bed', x: -19, z: -9, w: 3, d: 4, color: 0xa78bfa },
  { kind: 'plant', x: -1.2, z: -11 }, { kind: 'plant', x: -21, z: 11 },
  { kind: 'plant', x: 2, z: -7 }, { kind: 'plant', x: 2, z: 7 },
  { kind: 'mailbox', x: 6, z: -9 },
];

export const PLAYER_SPAWNS = [
  { x: 11.2, z: -1.6 }, { x: 11.2, z: -0.5 }, { x: 11.2, z: 0.6 }, { x: 11.2, z: 1.7 },
];

// [type, x, z]
export const ITEM_SPAWNS = [
  // Living room
  ['couch', -6, -9], ['lamp', -2, -10.5], ['standard', -9, -2.5], ['standard', -8, -2.5],
  ['fragile', -3, -3], ['heavy', -9.5, -10.5], ['standard', -4, -5],
  // Kitchen
  ['table', -6, 6], ['fragile', -2, 10], ['fragile', -3.2, 10], ['fragile', -8.5, 9.5],
  ['heavy', -9.5, 2.5], ['standard', -1.5, 3], ['fragile', -4, 2.4],
  // Bedroom
  ['lamp', -21, -1.5], ['standard', -15, -10.5], ['standard', -13, -10], ['heavy', -20.5, -4],
  ['fragile', -14, -2], ['standard', -16, -4],
  // Office
  ['desk', -16.5, 6], ['heavy', -20.5, 10.5], ['heavy', -20.5, 9], ['standard', -13, 2.5],
  ['standard', -13, 10.5], ['fragile', -19, 2.5], ['heavy', -15, 10.5],
  // Yard leftovers
  ['standard', 4, -10], ['standard', 5, 9],
];

export const CAT_WAYPOINTS = [
  [-5, -6], [-16, -6], [-16, 6], [-5, 6], [-2, -4], [3, -4], [-8, 3], [-19, -8], [-14, 9],
];

/** circle vs AABB overlap */
export function hitsWall(x, z, r) {
  for (const w of WALLS) {
    const cx = Math.max(w.x0, Math.min(x, w.x1));
    const cz = Math.max(w.z0, Math.min(z, w.z1));
    if ((x - cx) ** 2 + (z - cz) ** 2 < r * r) return true;
  }
  return false;
}

export function inRamp(x, z) {
  const r = TRUCK.ramp;
  return x >= r.x0 && x <= r.x1 && z >= r.z0 && z <= r.z1;
}

export function roomAt(x, z) {
  return ROOMS.find(r => x >= r.x0 && x <= r.x1 && z >= r.z0 && z <= r.z1)?.name || 'Yard';
}
