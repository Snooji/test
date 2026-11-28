// Sabotage, "pack the house" (docs/superpowers/specs/2026-11-28-sabotage-packing-design.md).
// MoveRoom creates one of these when game === 'sabotage' and calls its hooks; every other mode never touches this file.
import { ITEM_TYPES } from '../../shared/logic.js';
import { FLOOR_DZ, mulberry32 } from '../../shared/level.js';
import { TRUCK } from '../../shared/world.js';
import { roomQuotas, mixBag, SAB } from '../../shared/sabotage.js';

const BOXES = new Set(['standard', 'heavy', 'fragile']);

export class SabotageGame {
  constructor(room) {
    this.room = room;
    this.quota = new Map();   // roomIndex -> boxes still to pack there (counts down)
    this.total = new Map();   // roomIndex -> boxes the room started with
    this.bags = new Map();    // roomIndex -> the room's box types, in packing order
    this.log = [];            // work log: { at, text }
    this.packing = new Map(); // packerId -> { roomIndex, t, partnerId }
    this.seq = 0;
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

  tick(_dt) {
    // a pack job stops (and starts over) the moment its packer lets go or puts the flat box down
    for (const [id, job] of this.packing) {
      const p = this.room.players.get(id);
      if (!p || !p.in.hold || !this.carrying(p, 'flatbox') || job.seen !== this.room.elapsed) this.packing.delete(id);
    }
  }

  carrying(p, type) { const it = p.carry && this.room.items.get(p.carry); return it && it.type === type ? it : null; }
  near(p, it, r = 1.6) { return Math.hypot(p.x - it.x, p.z - it.z) < r; }
  /** a private hint, at most once every 4 s for the same text */
  hint(p, text) { const t = this.room.elapsed || 0; if (p.sabHint?.text === text && t - p.sabHint.at < 4) return; p.sabHint = { text, at: t }; this.room.tell(p, text); }
  note(text) { this.log.push({ at: Math.round(this.room.elapsed || 0), text }); if (this.log.length > 30) this.log.shift(); }
  newItem(type, x, z, extra = {}) {
    const id = 's' + (++this.seq);
    this.room.items.set(id, { id, type, x, z, state: 'floor', wrapped: false, assembled: false, carriers: [], earned: {}, task: null, helpers: [], g: null, value: 1, ...extra });
    return this.room.items.get(id);
  }

  /** taps on the Sabotage props: the stack hands you a flat box; the crate, breaker and piles are worked by holding */
  onTap(p, item) {
    if (item || p.dolly || p.flatDolly) return false;
    const st = this.room.items.get('flatstack');
    const target = this.room.nearestItem(p);
    if (st && (target?.id === 'flatstack' || this.near(p, st))) { // right by the stack: a flat box, whatever else is near
      const fb = this.newItem('flatbox', p.x, p.z, { state: 'carried', carriers: [p.id] });
      p.carry = fb.id;
      this.room.event({ kind: 'emote', id: p.id, e: '📦' });
      return true;
    }
    return !!target && ['padcrate', 'breaker', 'pile'].includes(target.type); // not things you pick up
  }

  /** holding ACTION: pack a flat box in this room (faster with a partner holding alongside) */
  onHold(p, dt) {
    if (this.carrying(p, 'flatbox')) return this.pack(p, dt);
    // an empty-handed mover holding next to a packer is their partner (the packer's job does the counting)
    if (!p.carry) for (const [id, job] of this.packing) {
      const q = this.room.players.get(id);
      if (q && q !== p && Math.hypot(q.x - p.x, q.z - p.z) <= SAB.PAIR_RADIUS) { p.task = { id: q.carry, kind: 'pack' }; return true; }
    }
    return false;
  }

  pack(p, dt) {
    const ri = this.roomAt(p.x, p.z), r = this.level.rooms[ri];
    if (ri < 0 || !this.total.has(ri)) { this.hint(p, '📦 Pack boxes inside a room, not in a hallway.'); return true; }
    if (!(this.quota.get(ri) > 0)) { this.hint(p, `✅ The ${r.name.toLowerCase()} is all packed. Take this box to another room.`); return true; }
    const job = this.packing.get(p.id) || { roomIndex: ri, t: 0, partnerId: null };
    if (job.roomIndex !== ri) { job.roomIndex = ri; job.t = 0; }
    const partner = [...this.room.players.values()].find(o => o !== p && this.room.isActive(o) && !o.carry && o.in.hold && Math.hypot(o.x - p.x, o.z - p.z) <= SAB.PAIR_RADIUS);
    job.partnerId = partner?.id || null;
    job.t += dt / (partner ? SAB.PACK_PAIR : SAB.PACK_SOLO);
    job.seen = this.room.elapsed;
    this.packing.set(p.id, job);
    p.task = { id: p.carry, kind: 'pack', p: +Math.min(1, job.t).toFixed(2) };
    if (job.t < 1 - 1e-6) return true;
    // done: the flat box becomes the room's next box, at the packer's feet
    const fb = this.carrying(p, 'flatbox');
    this.room.items.delete(fb.id); p.carry = null; this.packing.delete(p.id);
    const type = this.bags.get(ri).shift() || 'standard';
    this.quota.set(ri, this.quota.get(ri) - 1);
    this.newItem(type, p.x + Math.sin(p.face) * 0.7, p.z + Math.cos(p.face) * 0.7, { room: ri, shownType: type, lastHandlers: [p.id, partner?.id].filter(Boolean) });
    p.packed = (p.packed || 0) + 1; if (partner) partner.packed = (partner.packed || 0) + 1;
    this.note(`${partner ? `${p.name} + ${partner.name}` : p.name} packed a box in the ${r.name}`);
    this.room.event({ kind: 'emote', id: p.id, e: '📦' });
    return true;
  }

  onSabotage(_p) {}
  onMeetingStart() {}
  onMeetingEnd() {}
  onBreak(_item, _how) { return false; }
  onLeave(p) {
    const fb = this.carrying(p, 'flatbox');
    if (fb) { this.room.items.delete(fb.id); p.carry = null; }
    this.packing.delete(p.id);
  }
  checkEnd() { return null; }
  snapshot() { return { quota: [...this.quota], total: [...this.total] }; }
}

export const isProp = (type) => !!ITEM_TYPES[type]?.tool;
