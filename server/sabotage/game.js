// Sabotage, "pack the house" (docs/superpowers/specs/2026-11-28-sabotage-packing-design.md).
// MoveRoom creates one of these when game === 'sabotage' and calls its hooks; every other mode never touches this file.
import { ITEM_TYPES } from '../../shared/logic.js';
import { FLOOR_DZ, mulberry32 } from '../../shared/level.js';
import { TRUCK } from '../../shared/world.js';
import { roomQuotas, mixBag } from '../../shared/sabotage.js';

const BOXES = new Set(['standard', 'heavy', 'fragile']);

export class SabotageGame {
  constructor(room) {
    this.room = room;
    this.quota = new Map();   // roomIndex -> boxes still to pack there (counts down)
    this.total = new Map();   // roomIndex -> boxes the room started with
    this.bags = new Map();    // roomIndex -> the room's box types, in packing order
    this.log = [];            // work log: { at, text }
  }

  get level() { return this.room.level; }

  /** which room (index into level.rooms) a point is in, or -1 */
  roomAt(x, z) {
    const L = this.level, k = L.floorOf ? L.floorOf(z) : 0, zz = z - FLOOR_DZ * k;
    return L.rooms.findIndex(r => (r.storey || 0) === k && x >= r.x0 && x <= r.x1 && zz >= r.z0 && zz <= r.z1);
  }

  /** The house starts unpacked: furniture stays, loose boxes become room quotas; the flat-box stack, the pads and the breaker go out. */
  setupWorld() {
    const room = this.room, items = room.items;
    let boxCells = 0;
    for (const [id, it] of [...items]) if (BOXES.has(it.type)) { boxCells++; items.delete(id); }
    const q = roomQuotas(this.level.rooms, boxCells), rng = mulberry32((this.level.seed >>> 0) ^ 0x5ab07a6e);
    for (const [ri, n] of q) { this.quota.set(ri, n); this.total.set(ri, n); this.bags.set(ri, mixBag(this.level.rooms[ri].role, n, rng)); }
    const prop = (id, type, x, z, extra = {}) => items.set(id, { id, type, x, z, state: 'floor', wrapped: false, assembled: false, carriers: [], earned: {}, task: null, helpers: [], g: null, ...extra });
    const rx = TRUCK.ramp.x0 - 1.2;
    prop('flatstack', 'flatstack', rx, TRUCK.ramp.z1 + 1.0);
    prop('padcrate', 'padcrate', rx, TRUCK.ramp.z0 - 1.0);
    const rooms = this.level.rooms.map((r, i) => [r, i]).filter(([r]) => !r.storey);
    const [br] = rooms.find(([r]) => r.role === 'garage') || rooms.find(([r]) => r.role === 'laundry') || rooms.find(([r]) => !['hall', 'passage', 'stairs'].includes(r.role)) || rooms[0];
    prop('breaker', 'breaker', br.x0 + 0.6, (br.z0 + br.z1) / 2);
  }

  tick(_dt) {}
  onTap(_p) { return false; }
  onHold(_p, _dt) { return false; }
  onSabotage(_p) {}
  onMeetingStart() {}
  onMeetingEnd() {}
  onBreak(_item, _how) { return false; }
  onLeave(_p) {}
  checkEnd() { return null; }
  snapshot() { return { quota: [...this.quota], total: [...this.total] }; }
}

export const isProp = (type) => !!ITEM_TYPES[type]?.tool;
