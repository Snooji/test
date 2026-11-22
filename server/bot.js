// AI movers. A Bot drives a normal player record by writing its inputs each tick,
// so it obeys exactly the same movement, carry and loading rules as a human.
import { ITEM_TYPES, GRID, footprint, cloneGrid, placeItem, shapeCells, shapeDrop, isRemovable, topItemAt, canFitAny } from '../shared/logic.js';
import { inRamp } from '../shared/world.js';

export const DIFFICULTY = {
  easy:   { speed: 0.7,  react: [0.9, 1.6],  sloppy: 1,    wrap: 0.3, help: 0.4, callout: 0.15, accuracy: 0.35, dash: false, follow: 0.45 },
  normal: { speed: 0.88, react: [0.4, 0.9],  sloppy: 0.25, wrap: 0.7, help: 0.9, callout: 0.4,  accuracy: 0.6,  dash: true,  follow: 0.8 },
  hard:   { speed: 1,    react: [0.15, 0.4], sloppy: 0,    wrap: 1,   help: 1,   callout: 0.7,  accuracy: 0.85, dash: true,  follow: 1 },
};

export const BOT_NAMES = ['Beep', 'Sprocket', 'Orbit', 'Nebby', 'Kip', 'Bolt', 'Pixel', 'Comet'];
const RAMP_TARGET = { x: 11.2, z: 0 };
const LINES = {
  accuse: (n) => [`I saw ${n} at the truck right before the crunch!`, `${n} was carrying something heavy… just saying.`, `It was ${n}. Trust me, I have three eyes.`],
  defend: ['Wasn’t me, I was in the kitchen.', 'I only carry standard boxes, I swear.', 'Beep boop, I am innocent.', 'Check the cat. The cat knows.'],
};
const pick = (arr, rng = Math.random) => arr[Math.floor(rng() * arr.length)];

/** Choose where to drop `item` in the truck. Returns {gx, gz, rot} or null when nothing fits.
 *  evil = saboteur: crush something if it can. */
export function choosePlacement(grid, item, difficulty, rng = Math.random, evil = false) {
  const t = ITEM_TYPES[item.type];
  const opts = [];
  for (const rot of t.w !== t.d ? [0, 1] : [0]) {
    const { w, d } = footprint(item.type, rot);
    for (let gx = 0; gx <= GRID.W - w; gx++) for (let gz = 0; gz <= GRID.D - d; gz++) {
      const res = placeItem(cloneGrid(grid), { ...item, loaderIds: [] }, gx, gz, rot);
      if (!res.ok) continue;
      let score = -res.broken.length * 1000 - (res.selfBroken ? 500 : 0);
      if (t.heavy || t.furniture) score -= res.y * 10;
      else if (t.fragile) score += res.y * 4;
      else score -= res.y * 2;
      score -= gz * 1.5;                 // fill from the cab end
      score += rng() * 0.5;              // tie-break
      opts.push({ gx, gz, rot, score });
    }
  }
  if (!opts.length) return null;
  if (evil) {
    const crushers = opts.filter(o => o.score <= -500);
    if (crushers.length && rng() < 0.75) return crushers[Math.floor(rng() * crushers.length)];
    return opts[Math.floor(rng() * opts.length)];
  }
  const cfg = DIFFICULTY[difficulty] || DIFFICULTY.normal;
  if (rng() < cfg.sloppy) return opts[Math.floor(rng() * opts.length)];
  opts.sort((a, b) => b.score - a.score);
  return opts[0];
}

export class Bot {
  constructor(room, player, difficulty = 'normal', rng = Math.random) {
    this.room = room; this.p = player; this.rng = rng;
    this.setDifficulty(difficulty);
    this.reset();
  }
  setDifficulty(d) { this.difficulty = DIFFICULTY[d] ? d : 'normal'; this.cfg = DIFFICULTY[this.difficulty]; }
  reset() {
    this.targetId = null; this.path = null; this.pathI = 0; this.repathT = 0;
    this.waitT = this.react(); this.waitAlone = 0; this.stuckT = 0; this.last = null; this.placed = null;
    this.wantsWrap = false; this.calloutAt = null;
    this.sus = {}; this.skipUntil = new Map(); this.setAside = null; this.holdT = 0; this.t = 0; this.stuckCache = null;
  }
  skipping(id) { return (this.skipUntil.get(id) || 0) > this.t; }

  // ---------- Full load: follow the known-good packing ----------
  plan() { return this.room.isExact() && this.room.level.solution ? this.room.level.solution : null; }
  colTop(x, z) { const col = this.room.grid.cells[x][z]; for (let y = GRID.H - 1; y >= 0; y--) if (col[y]) return y + 1; return 0; }
  slotReady(sl) {
    const g = this.room.grid;
    if (!sl.cells.every(([x, y, z]) => !g.cells[x][z][y])) return false;
    if (shapeDrop(g, shapeCells(sl.type, sl.rot), sl.gx, sl.gz) !== sl.y) return false;
    // no gap underneath any column of the piece (an arm or a bed over an empty cell can never be filled later)
    const low = new Map();
    for (const [x, y, z] of sl.cells) { const k = x + ',' + z; if (!low.has(k) || low.get(k)[2] > y) low.set(k, [x, z, y]); }
    for (const [x, z, y] of low.values()) if (this.colTop(x, z) !== y) return false;
    return true;
  }
  openSlot(type) { return this.plan()?.find(sl => sl.type === type && this.slotReady(sl)) || null; }
  misplaced() {
    const plan = this.plan(), g = this.room.grid, out = [];
    const keys = new Set(plan.map(sl => sl.type + ':' + sl.cells.map(c => c.join(',')).sort().join(';')));
    for (const [id, rec] of g.items) {
      const abs = rec.cells.map(([x, y, z]) => [rec.x + x, rec.y + y, rec.z + z]);
      const k = rec.type + ':' + abs.map(c => c.join(',')).sort().join(';');
      // sitting over a gap is as bad as being in the wrong spot
      const overGap = abs.some(([x, y, z]) => y > 0 && !g.cells[x][z][y - 1]);
      if ((!keys.has(k) || overGap) && isRemovable(g, id)) out.push(rec);
    }
    return out.sort((a, b) => b.y - a.y);
  }
  truckStuck() {
    const room = this.room;
    const key = room.gridVersion + ':' + room.loadedCountCache();
    if (this.stuckCache?.key === key) return this.stuckCache.v;
    const remaining = [...room.items.values()].filter(i => i.state === 'floor' || i.state === 'carried');
    const v = remaining.length > 0 && !remaining.some(i => this.openSlot(i.type)) && this.misplaced().length > 0;
    this.stuckCache = { key, v };
    return v;
  }
  isUnloader() {
    for (const b of this.room.bots.values()) if (this.room.isActive(b.p) && !b.p.saboteur) return b === this;
    return false;
  }
  unload(dt) {
    const p = this.p;
    if (p.loadMode && p.unloading) {
      this.idle();
      const m = this.misplaced()[0];
      if (!m) { p.pending.dashN = 1; return; }
      for (const [x, , z] of m.cells) {
        if (topItemAt(this.room.grid, m.x + x, m.z + z) === m.id) { p.cursor.gx = m.x + x; p.cursor.gz = m.z + z; break; }
      }
      p.pending.tapN = 1;
      this.waitT = this.react();
      return;
    }
    if (!inRamp(p.x, p.z)) return this.goTo(RAMP_TARGET, dt, false);
    this.idle();
    p.in.hold = true; // hold on the ramp → unload mode
  }
  react() { const [a, b] = this.cfg.react; return a + this.rng() * (b - a); }
  idle() { this.p.in.mx = 0; this.p.in.mz = 0; this.p.in.hold = false; }

  // ---------- per tick ----------
  think(dt) {
    const room = this.room, p = this.p;
    this.t += dt;
    if (room.phase !== 'playing' || !room.isActive(p)) { this.idle(); return; }
    if (this.calloutAt !== null && (this.calloutAt -= dt) <= 0) { this.calloutAt = null; room.callMeeting(p.id); }
    if (this.waitT > 0) { this.waitT -= dt; this.idle(); return; }

    const item = p.carry ? room.items.get(p.carry) : null;
    if (p.loadMode && item) return this.load(item);
    if (item) return this.carry(item, dt);
    if (this.plan() && (p.unloading || (this.isUnloader() && this.truckStuck()))) return this.unload(dt);
    this.fetch(dt);
  }

  load(item) {
    this.idle();
    const plan = this.plan();
    if (plan && !this.p.saboteur) {
      const slot = this.openSlot(item.type);
      if (slot && this.rng() < this.cfg.follow) {
        this.p.cursor = { gx: slot.gx, gz: slot.gz, rot: slot.rot };
        this.p.pending.tapN = 1;
        this.waitT = this.react(); this.targetId = null; this.path = null;
        return;
      }
      if (!slot && this.difficulty !== 'easy') { // nowhere for it yet: set it aside by the truck
        this.p.pending.dashN = 1;
        this.setAside = item.id;
        return;
      }
    }
    if (plan && this.p.saboteur && this.rng() < 0.4) { // blend in: sometimes place it right
      const slot = this.openSlot(item.type);
      if (slot) { this.p.cursor = { gx: slot.gx, gz: slot.gz, rot: slot.rot }; this.p.pending.tapN = 1; this.waitT = this.react(); return; }
    }
    const spot = choosePlacement(this.room.grid, { id: item.id, type: item.type, wrapped: item.wrapped }, this.difficulty, this.rng, !!this.p.saboteur);
    if (!spot) { this.p.pending.dashN = 1; this.giveUp(item); return; } // truck full: back out
    this.p.cursor = { gx: spot.gx, gz: spot.gz, rot: spot.rot };
    this.p.pending.tapN = 1;
    this.waitT = this.react();
    this.targetId = null; this.path = null;
  }

  giveUp(item) { this.room.releaseCarry(this.p); this.skipUntil.set(item.id, this.t + 12); this.waitT = this.react(); }

  carry(item, dt) {
    const t = ITEM_TYPES[item.type];
    if (this.setAside === item.id && !inRamp(this.p.x, this.p.z)) { // staged next to the truck for later
      this.setAside = null; this.idle();
      this.p.pending.tapN = 1;
      this.skipUntil.set(item.id, this.t + 8);
      this.targetId = null; this.path = null;
      this.waitT = this.react();
      return;
    }
    if (t.teamCarry && item.carriers.length === 1 && this.room.activePlayers().length > 1) {
      // waiting for a buddy; don't deadlock forever
      this.idle();
      if (this.waitAlone === 0 || this.waitAlone > 5) this.room.helpPing?.(this.p); // call for a buddy
      this.waitAlone += dt;
      if (this.waitAlone > 10) { this.waitAlone = 0; this.giveUp(item); }
      return;
    }
    this.waitAlone = 0;
    // in a team lift, steer the furniture itself, not our own body, so it threads doorways
    this.goTo(RAMP_TARGET, dt, t.heavy && !t.furniture, item.carriers.length > 1 ? item : null);
  }

  fetch(dt) {
    const room = this.room, p = this.p;
    let target = this.targetId ? room.items.get(this.targetId) : null;
    if (!target || !this.stillValid(target) || this.skipping(target.id) || (this.plan() && !p.saboteur && target.state === 'floor' && !this.openSlot(target.type))) { this.wantsWrap = false; target = this.chooseTarget(); this.targetId = target?.id || null; this.path = null; }
    if (!target) { this.idle(); this.wander(dt); return; }
    const t = ITEM_TYPES[target.type];
    const d = Math.hypot(target.x - p.x, target.z - p.z);
    if (d > 1.15) { this.goTo(target, dt, false); return; }
    this.idle();
    // at the item
    if (target.assembled || (this.wantsWrap && t.needsWrap && !target.wrapped)) {
      if (room.nearestItem(p)?.id !== target.id) { this.goTo(target, dt, false); return; } // get closer
      p.in.hold = true;
      if (p.saboteur && target.assembled && (this.holdT += dt) > 3 + this.rng() * 2) { // jammed it; slip away
        this.holdT = 0; this.skipUntil.set(target.id, this.t + 30); this.targetId = null; p.in.hold = false;
      }
      return;
    }
    p.pending.tapN = 1;
    this.waitT = this.react() * 0.5;
  }

  stillValid(it) {
    if (it.state === 'floor') return true;
    return it.state === 'carried' && ITEM_TYPES[it.type].teamCarry && it.carriers.length === 1 && !it.carriers.includes(this.p.id);
  }

  claimed(it) {
    // another bot is already walking over for it (its carrier doesn't count: they need a helper)
    for (const b of this.room.bots.values()) if (b !== this && b.targetId === it.id && b.p.carry !== it.id) return true;
    return false;
  }

  chooseTarget() {
    const room = this.room, p = this.p, cfg = this.cfg;
    const alone = room.activePlayers().length === 1;
    // 1) someone is holding one end of a two-mover lift: help them
    for (const it of room.items.values()) {
      if (it.state === 'carried' && ITEM_TYPES[it.type].teamCarry && it.carriers.length === 1 && !it.carriers.includes(p.id) && !room.players.get(it.carriers[0])?.loadMode && !this.claimed(it) && this.rng() < cfg.help) return it;
    }
    const someoneWaiting = [...room.items.values()].some(it => it.state === 'carried' && ITEM_TYPES[it.type].teamCarry && it.carriers.length === 1);
    const loaded = [...room.items.values()].filter(i => i.state === 'loaded').length;
    let best = null, bestScore = -Infinity;
    for (const it of room.items.values()) {
      if (it.state !== 'floor' || this.skipping(it.id) || this.claimed(it)) continue;
      const t = ITEM_TYPES[it.type];
      if (t.teamCarry && !alone && someoneWaiting) continue;
      let score = -Math.hypot(it.x - p.x, it.z - p.z) - Math.hypot(it.x - RAMP_TARGET.x, it.z - RAMP_TARGET.z) * 0.4;
      if (this.difficulty === 'hard') {
        if (t.heavy || t.furniture) score += loaded < 12 ? 14 : 4; // build the floor first
        if (t.fragile) score -= loaded < 10 ? 12 : 0;              // fragile goes on top, later
        score += t.pts * 0.15;
      } else if (this.difficulty === 'easy') score += this.rng() * 20;
      else score += this.rng() * 6;
      if (t.teamCarry && !alone) score -= 6;
      if (this.plan() && !p.saboteur && !this.openSlot(it.type)) continue; // Full load: only fetch what can go in now
      if (p.saboteur && it.assembled) score += 25;
      if (score > bestScore) { bestScore = score; best = it; }
    }
    if (best) {
      const t = ITEM_TYPES[best.type];
      this.wantsWrap = t.needsWrap && this.rng() < cfg.wrap;
    }
    return best;
  }

  wander(dt) { this.goTo({ x: 6, z: (this.p.id.charCodeAt(0) % 5) - 2 }, dt, false); }

  goTo(target, dt, heavy, mover = null) {
    const p = this.p;
    const src = mover || p;
    this.repathT -= dt;
    const tgtMoved = this.path && Math.hypot(this.path[this.path.length - 1].x - target.x, this.path[this.path.length - 1].z - target.z) > 1;
    if (!this.path || this.repathT <= 0 || tgtMoved) {
      this.path = this.room.nav.findPath({ x: src.x, z: src.z }, { x: target.x, z: target.z });
      this.pathI = 1; this.repathT = 1.5;
      if (!this.path) { this.idle(); this.targetId = null; return; }
    }
    let wp = this.path[this.pathI];
    while (wp && Math.hypot(wp.x - src.x, wp.z - src.z) < 0.35 && this.pathI < this.path.length - 1) wp = this.path[++this.pathI];
    if (!wp) { this.idle(); return; }
    const dx = wp.x - src.x, dz = wp.z - src.z, d = Math.hypot(dx, dz) || 1;
    p.in.mx = dx / d * this.cfg.speed; p.in.mz = dz / d * this.cfg.speed; p.in.hold = false;

    // stuck detection: nudge sideways and repath
    if (this.last && Math.hypot(this.last.x - src.x, this.last.z - src.z) < 0.02 && !p.task) this.stuckT += dt; else this.stuckT = 0;
    this.last = { x: src.x, z: src.z };
    if (this.stuckT > 0.8) { p.in.mx = -dz / d; p.in.mz = dx / d; this.repathT = 0; this.stuckT = 0; }

    // dash on long open runs
    const remaining = this.path.slice(this.pathI).reduce((s, q, i, a) => s + (i ? Math.hypot(q.x - a[i - 1].x, q.z - a[i - 1].z) : Math.hypot(q.x - p.x, q.z - p.z)), 0);
    if (this.cfg.dash && !heavy && !p.carry && remaining > 9 && p.dashCd <= 0 && !inRamp(p.x, p.z)) p.pending.dashN = 1;
  }

  // ---------- social ----------
  onCrunch(culpritIds) {
    if (culpritIds.includes(this.p.id) || !this.room.isActive(this.p)) return;
    if (this.room.game === 'sabotage' && !this.p.saboteur) {
      for (const c of culpritIds) {
        if (this.rng() < this.cfg.accuracy) this.sus[c] = (this.sus[c] || 0) + 1;
        else { const o = this.room.activePlayers().filter(q => q.id !== this.p.id); if (o.length) { const r = o[Math.floor(this.rng() * o.length)].id; this.sus[r] = (this.sus[r] || 0) + 0.5; } }
      }
      if (Math.max(0, ...Object.values(this.sus)) >= 1.5 && this.rng() < this.cfg.callout) this.calloutAt = 2 + this.rng() * 4;
      return;
    }
    if (this.rng() < this.cfg.callout) this.calloutAt = 2 + this.rng() * 5;
  }

  meetingVote() {
    const room = this.room, p = this.p;
    const others = room.activePlayers().filter(o => o.id !== p.id);
    if (!others.length) return 'skip';
    if (room.game === 'sabotage') {
      if (p.saboteur) return pick(others, this.rng).id;
      const ranked = Object.entries(this.sus).filter(([id]) => others.some(o => o.id === id)).sort((a, b) => b[1] - a[1]);
      if (ranked.length && this.rng() < this.cfg.accuracy) return ranked[0][0];
      return this.rng() < 0.5 ? 'skip' : pick(others, this.rng).id;
    }
    const open = room.breaks.filter(b => !b.resolved);
    const culprits = [...new Set(open.flatMap(b => b.culpritIds))].filter(id => id !== p.id && room.players.get(id) && room.isActive(room.players.get(id)));
    const guilty = open.some(b => b.culpritIds.includes(p.id));
    if (guilty) return pick(others, this.rng).id;                         // bluff
    if (culprits.length && this.rng() < this.cfg.accuracy) return pick(culprits, this.rng);
    return this.rng() < 0.25 ? 'skip' : pick(others, this.rng).id;
  }

  meetingLine(target) {
    if (target && target !== 'skip') return pick(LINES.accuse(this.room.players.get(target)?.name || 'someone'), this.rng);
    return pick(LINES.defend, this.rng);
  }
}
