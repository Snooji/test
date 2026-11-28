// Sabotage, "pack the house" (docs/superpowers/specs/2026-11-28-sabotage-packing-design.md).
// MoveRoom creates one of these when game === 'sabotage' and calls its hooks; every other mode never touches this file.
import { ITEM_TYPES } from '../../shared/logic.js';
import { FLOOR_DZ, mulberry32 } from '../../shared/level.js';
import { TRUCK } from '../../shared/world.js';
import { roomQuotas, mixBag, SAB, HOLD, pileValueFactor } from '../../shared/sabotage.js';
import { inRamp } from '../../shared/world.js';
import { dealRoles, jobsFor } from './roles.js';
import { pickSabotage, blocked, applySabotage, pickRepair, applyRepair } from './actions.js';
import { driveOffCheck } from '../../shared/logic.js';

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
    this.houseValue = 0;      // everything the house holds, furniture + every box it will be packed into
    this.lostValue = 0;       // broken, damaged or spoiled: the saboteurs' score
    this.cooldown = new Map();  // saboteurId -> seconds until they can sabotage again
    this.sabHolds = new Map();  // saboteurId -> { action, id|room, t, x, z }
    this.history = [];          // every finished sabotage: { by, action, at, x, z } (the end screen tells all)
    this.fixes = new Map();     // repair key -> { t, tick }
    this.dark = new Map();      // roomIndex -> seconds of darkness left
    this.padsOutT = 0; this.weakLeft = 0;
    this.strapped = new Set();  // truck pieces the Driver strapped down
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
    for (const it of items.values()) if (!ITEM_TYPES[it.type].tool) this.houseValue += ITEM_TYPES[it.type].pts;
    for (const bag of this.bags.values()) for (const t of bag) this.houseValue += ITEM_TYPES[t].pts;
  }

  worth(it) { return ITEM_TYPES[it.type].pts * (it.value ?? 1); }
  lose(amount) { this.lostValue = +(this.lostValue + amount).toFixed(3); }

  /** the nearest spot a mover can reach (never inside a wall or on the ramp) */
  walkable(x, z) {
    const ok = (a, b) => !this.level.hitsWall(a, b, 0.45) && !inRamp(a, b);
    if (ok(x, z)) return { x, z };
    for (let r = 0.25; r <= 4; r += 0.25) for (let k = 0; k < 16; k++) {
      const a = (k / 16) * Math.PI * 2, px = x + Math.cos(a) * r, pz = z + Math.sin(a) * r;
      if (ok(px, pz)) return { x: +px.toFixed(2), z: +pz.toFixed(2) };
    }
    return { x: 6, z: 0 }; // the yard by the truck
  }

  /** Something broke. Sabotage keeps it broken: a fragile box (or a broken piece) is lost; a standard or heavy box bursts
   *  into a pile that can be repacked. Returns true so the room doesn't respawn it. */
  onBreak(item) {
    this.room.items.delete(item.id);
    if (item.type === 'standard' || item.type === 'heavy') {
      const at = this.walkable(item.x, item.z);
      this.newItem('pile', at.x, at.z, { contents: item.type, value: item.value ?? 1, bornAt: this.room.elapsed || 0, room: item.room });
      this.room.event({ kind: 'toast', text: `💥 A ${ITEM_TYPES[item.type].label.toLowerCase()} burst! Repack the pile quickly to save what's inside.`, cls: 'crunch' });
    } else this.lose(this.worth(item));
    return true;
  }

  /** a piece of furniture got knocked about: worth half from now on, and it counts against the drive-off */
  damage(item, why) {
    if (item.damaged) return;
    const before = this.worth(item);
    item.damaged = why; item.value = (item.value ?? 1) * SAB.DAMAGED_VALUE;
    this.lose(before - this.worth(item));
  }

  /** the furniture dolly wobbled too much with a piece on it: the piece slides off and is damaged */
  pieceFalls(p, fd) {
    const piece = this.room.items.get(fd.piece);
    fd.piece = null;
    if (!piece) return;
    const at = this.walkable(fd.x + Math.cos(p.face) * 1.2, fd.z - Math.sin(p.face) * 1.2);
    Object.assign(piece, { state: 'floor', flatId: null, x: at.x, z: at.z, carriers: [] });
    this.damage(piece, 'fell off the dolly');
    this.room.event({ kind: 'toast', text: `😬 The ${ITEM_TYPES[piece.type].label.toLowerCase()} slid off the furniture dolly. Damaged!`, cls: 'crunch' });
  }

  /** deal roles at the start of the round and tell each mover theirs (saboteurs also learn their partner) */
  dealRoles(rng = Math.random) {
    const movers = this.room.movers(), roles = dealRoles(movers, rng);
    for (const p of movers) {
      p.role = roles.get(p.id); p.saboteur = p.role === 'saboteur';
      p.meetingsLeft = p.role === 'foreman' ? 2 : 1; p.ghost = false;
    }
    this.hadDriver = movers.length >= 5;
    for (const p of movers) {
      const card = { kind: 'role', role: p.role, saboteur: p.saboteur };
      if (p.saboteur) card.partners = movers.filter(o => o !== p && o.saboteur).map(o => o.id);
      this.room.clients.find(c => c.sessionId === p.id)?.send('evt', card);
    }
  }
  jobsFor(p) { return jobsFor(this, p); }
  /** a crew role whose holder is gone passes to a living crew mover (only the Driver needs passing on) */
  keepDriver() {
    if (!this.hadDriver) return;
    const live = this.room.movers().filter(p => this.room.isActive(p) && !p.ghost && !p.saboteur);
    if (live.some(p => p.role === 'driver')) return;
    const next = live.find(p => p.role === 'mover') || live[0];
    if (next) { next.role = 'driver'; this.room.event({ kind: 'toast', text: `🚚 ${next.name} is the Driver now.` }); }
  }

  tick(dt) {
    this.keepDriver();
    for (const [id, t] of this.cooldown) this.cooldown.set(id, Math.max(0, t - dt));
    for (const [ri, t] of this.dark) { if (t - dt <= 0) this.dark.delete(ri); else this.dark.set(ri, t - dt); }
    if (this.padsOutT > 0) this.padsOutT = Math.max(0, this.padsOutT - dt);
    this.tickSabotage(dt);
    this.tickTampered(dt);
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
      if (this.weakLeft > 0) { this.weakLeft--; fb.weak = true; }
      p.carry = fb.id;
      this.room.event({ kind: 'emote', id: p.id, e: '📦' });
      return true;
    }
    return !!target && ['padcrate', 'breaker', 'pile'].includes(target.type); // not things you pick up
  }

  /** holding ACTION: pack a flat box in this room (faster with a partner holding alongside) */
  onHold(p, dt) {
    if (this.carrying(p, 'flatbox')) return this.pack(p, dt);
    if (!p.carry && !p.ghost) {
      const job = pickRepair(this, p);
      if (job) {
        p.task = { id: job.key, kind: job.kind };
        const f = this.fixes.get(job.key) || { t: 0, tick: -1 };
        // a two-mover repair only moves with a second mover holding beside it
        const helpers = job.pair ? [...this.room.players.values()].filter(o => this.room.isActive(o) && !o.carry && o.in.hold && Math.hypot(o.x - job.pair.x, o.z - job.pair.z) < 1.6).length : 1;
        if (helpers >= (job.pair ? 2 : 1) && f.tick !== this.room.elapsed) { f.t += dt / job.secs; f.tick = this.room.elapsed; }
        this.fixes.set(job.key, f);
        if (f.t >= 1 - 1e-6) { this.fixes.delete(job.key); applyRepair(this, job); this.note(`${p.name} ${{ restrap: 'strapped the load', breaker: 'flipped the breaker', refillPads: 'refilled the pads', fixWheel: 'fixed a dolly wheel', retape: 're-taped a box' }[job.kind]}`); }
        return true;
      }
    }
    // an empty-handed mover holding next to a packer is their partner (the packer's job does the counting)
    if (!p.carry) for (const [id, job] of this.packing) {
      const q = this.room.players.get(id);
      if (q && q !== p && Math.hypot(q.x - p.x, q.z - p.z) <= SAB.PAIR_RADIUS) { p.task = { id: q.carry, kind: 'pack' }; return true; }
    }
    return false;
  }

  pack(p, dt) {
    const pile = [...this.room.items.values()].find(i => i.type === 'pile' && this.near(p, i, 1.3));
    if (pile) return this.repack(p, pile, dt);
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
    const weak = fb.weak ? { tampered: 'weak', tell: 'sag' } : {};
    const type = this.bags.get(ri).shift() || 'standard';
    this.quota.set(ri, this.quota.get(ri) - 1);
    this.newItem(type, p.x + Math.sin(p.face) * 0.7, p.z + Math.cos(p.face) * 0.7, { room: ri, shownType: type, lastHandlers: [p.id, partner?.id].filter(Boolean), ...weak });
    p.packed = (p.packed || 0) + 1; if (partner) partner.packed = (partner.packed || 0) + 1;
    this.note(`${partner ? `${p.name} + ${partner.name}` : p.name} packed a box in the ${r.name}`);
    this.room.event({ kind: 'emote', id: p.id, e: '📦' });
    return true;
  }

  partnerOf(p) { return [...this.room.players.values()].find(o => o !== p && this.room.isActive(o) && !o.carry && o.in.hold && Math.hypot(o.x - p.x, o.z - p.z) <= SAB.PAIR_RADIUS) || null; }

  /** repack a burst box's pile into a new box (marked fragile); the sooner, the more of it is saved */
  repack(p, pile, dt) {
    const job = this.packing.get(p.id)?.pileId === pile.id ? this.packing.get(p.id) : { pileId: pile.id, t: 0, partnerId: null };
    const partner = this.partnerOf(p);
    job.partnerId = partner?.id || null;
    job.t += dt / (partner ? SAB.REPACK_PAIR : SAB.REPACK_SOLO);
    job.seen = this.room.elapsed;
    this.packing.set(p.id, job);
    p.task = { id: p.carry, kind: 'pack', p: +Math.min(1, job.t).toFixed(2) };
    if (job.t < 1 - 1e-6) return true;
    const fb = this.carrying(p, 'flatbox');
    this.room.items.delete(fb.id); this.room.items.delete(pile.id); p.carry = null; this.packing.delete(p.id);
    const contents = ITEM_TYPES[pile.contents].pts * (pile.value ?? 1), f = pileValueFactor((this.room.elapsed || 0) - pile.bornAt);
    this.lose(contents * (1 - f));
    this.newItem('fragile', pile.x, pile.z, { value: (contents * f) / ITEM_TYPES.fragile.pts, repacked: pile.contents, shownType: 'fragile', room: pile.room, lastHandlers: [p.id, partner?.id].filter(Boolean) });
    this.note(`${partner ? `${p.name} + ${partner.name}` : p.name} repacked a burst box (${Math.round(f * 100)}% saved)`);
    return true;
  }

  /** a room's light switch: just inside its corner */
  switchOf(ri) { const r = this.level.rooms[ri]; return { x: r.x0 + 0.5, z: r.z0 + 0.5 + FLOOR_DZ * (r.storey || 0) }; }

  /** the Sabotage button: start the best sabotage in reach (it finishes after its hold if the saboteur stays put) */
  onSabotage(p) {
    if (!p.saboteur || !this.room.isActive(p) || p.ghost || this.sabHolds.has(p.id)) return;
    if ((this.cooldown.get(p.id) || 0) > 0) return this.hint(p, `🤫 Lie low: ${Math.ceil(this.cooldown.get(p.id))} s until you can sabotage again.`);
    const job = pickSabotage(this, p);
    if (!job) return this.hint(p, '🤫 Nothing to sabotage right here.');
    const why = blocked(this, p, job);
    if (why) return this.hint(p, `🤫 ${why}`);
    this.sabHolds.set(p.id, { ...job, t: 0, x: p.x, z: p.z });
  }
  tickSabotage(dt) {
    for (const [id, job] of this.sabHolds) {
      const p = this.room.players.get(id);
      const gone = !p || !this.room.isActive(p) || Math.hypot(p.x - job.x, p.z - job.z) > 0.8 || (job.id && !this.room.items.has(job.id));
      if (gone) { this.sabHolds.delete(id); continue; }
      p.task = { id: job.id || null, kind: 'sabotage' };
      if ((job.t += dt) < HOLD[job.action] - 1e-6) continue;
      this.sabHolds.delete(id);
      if (blocked(this, p, job)) continue;
      applySabotage(this, p, job);
      this.cooldown.set(id, SAB.SAB_COOLDOWN);
      this.history.push({ by: id, action: job.action, at: Math.round(this.room.elapsed || 0), x: +p.x.toFixed(1), z: +p.z.toFixed(1) });
      this.onSabotageDone?.(p, job);
    }
  }

  /** tampered boxes: cut tape bursts on the first lift; a weak box may burst on lifting and while carried; a loose
   *  two-wheel dolly drops its top box every few seconds it's pushed */
  tickTampered(dt) {
    const rng = this.rng || Math.random;
    for (const it of [...this.room.items.values()]) {
      if (it.state === 'carried' && (it.tampered === 'cut' || it.tampered === 'weak')) {
        const first = !it.liftSeen; it.liftSeen = true;
        if ((first && (it.tampered === 'cut' || rng() < SAB.WEAK_BURST_ON_LIFT)) || (it.tampered === 'weak' && rng() < SAB.WEAK_BURST_PER_S * dt)) this.burst(it, 'burst open');
      } else if (it.state !== 'carried') it.liftSeen = false;
      if (it.type === 'dolly' && it.loose && it.state === 'pushed' && it.stack.length) {
        const pu = this.room.players.get(it.pusher);
        if (pu && Math.hypot(pu.in.mx, pu.in.mz) > 0.5 && (it.looseT = (it.looseT || 0) + dt) >= 6) { it.looseT = 0; this.dropTop(it); }
      }
    }
  }
  dropTop(d) {
    const box = this.room.items.get(d.stack.pop());
    if (!box) return;
    const at = this.walkable(d.x + 0.9, d.z);
    Object.assign(box, { state: 'floor', dollyId: null, x: at.x, z: at.z });
    if (box.type === 'fragile') this.burst(box, 'fell off the wobbly dolly');
    else this.room.event({ kind: 'toast', text: '😬 A box fell off the wobbly dolly!' });
  }
  /** a packed box gives way: whoever held it drops it, and it breaks (fragile: lost; else a pile to repack) */
  burst(it, how) {
    for (const id of it.carriers || []) { const o = this.room.players.get(id); if (o) { o.carry = null; o.loadMode = false; } }
    it.carriers = []; it.state = 'broken';
    this.room.recordBreak(it, [], how);
    this.onBreak(it);
  }

  /** pieces in the truck that would topple off a wobbly tower at the drive-off (and aren't strapped) */
  wobbly() { return driveOffCheck(this.room.grid).damaged.filter(d => /topple/.test(d.reason) && !this.strapped.has(d.id)).map(d => d.id); }
  /** the drive-off safety % as it stands: strapped pieces don't topple */
  liveSafety() {
    const chk = driveOffCheck(this.room.grid), total = this.room.grid.items.size;
    if (!total) return 100;
    const bad = chk.damaged.filter(d => !(/topple/.test(d.reason) && this.strapped.has(d.id))).length;
    return Math.round((100 * (total - bad)) / total);
  }
  onMeetingStart() {}
  onMeetingEnd() {}
  onLeave(p) {
    this.sabHolds.delete(p.id);
    const fb = this.carrying(p, 'flatbox');
    if (fb) { this.room.items.delete(fb.id); p.carry = null; }
    this.packing.delete(p.id);
  }
  checkEnd() { return null; }
  snapshot() {
    const roles = {};
    for (const p of this.room.players.values()) if (p.role) roles[p.id] = p.role === 'saboteur' ? 'mover' : p.role; // never who the saboteurs are
    return { quota: [...this.quota], total: [...this.total], roles, lost: Math.round(this.lostValue), houseValue: this.houseValue,
      dark: [...this.dark.keys()], padsOut: this.padsOutT > 0 };
  }
}

export const isProp = (type) => !!ITEM_TYPES[type]?.tool;
