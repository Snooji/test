// AI movers. A Bot drives a normal player record by writing its inputs each tick,
// so it obeys exactly the same movement, carry and loading rules as a human.
import { ITEM_TYPES, GRID, footprint, cloneGrid, placeItem } from '../shared/logic.js';
import { inRamp } from '../shared/world.js';

export const DIFFICULTY = {
  easy:   { speed: 0.7,  react: [0.9, 1.6],  sloppy: 1,    wrap: 0.3, help: 0.4, callout: 0.15, accuracy: 0.35, dash: false },
  normal: { speed: 0.88, react: [0.4, 0.9],  sloppy: 0.25, wrap: 0.7, help: 0.9, callout: 0.4,  accuracy: 0.6,  dash: true },
  hard:   { speed: 1,    react: [0.15, 0.4], sloppy: 0,    wrap: 1,   help: 1,   callout: 0.7,  accuracy: 0.85, dash: true },
};

export const BOT_NAMES = ['Beep', 'Sprocket', 'Orbit', 'Nebby', 'Kip', 'Bolt', 'Pixel', 'Comet'];
const RAMP_TARGET = { x: 11.2, z: 0 };
const LINES = {
  accuse: (n) => [`I saw ${n} at the truck right before the crunch!`, `${n} was carrying something heavy… just saying.`, `It was ${n}. Trust me, I have three eyes.`],
  defend: ['Wasn’t me, I was in the kitchen.', 'I only carry standard boxes, I swear.', 'Beep boop, I am innocent.', 'Check the cat. The cat knows.'],
};
const pick = (arr, rng = Math.random) => arr[Math.floor(rng() * arr.length)];

/** Choose where to drop `item` in the truck. Returns {gx, gz, rot} or null when nothing fits. */
export function choosePlacement(grid, item, difficulty, rng = Math.random) {
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
  }
  react() { const [a, b] = this.cfg.react; return a + this.rng() * (b - a); }
  idle() { this.p.in.mx = 0; this.p.in.mz = 0; this.p.in.hold = false; }

  // ---------- per tick ----------
  think(dt) {
    const room = this.room, p = this.p;
    if (room.phase !== 'playing' || !room.isActive(p)) { this.idle(); return; }
    if (this.calloutAt !== null && (this.calloutAt -= dt) <= 0) { this.calloutAt = null; room.callMeeting(p.id); }
    if (this.waitT > 0) { this.waitT -= dt; this.idle(); return; }

    const item = p.carry ? room.items.get(p.carry) : null;
    if (p.loadMode && item) return this.load(item);
    if (item) return this.carry(item, dt);
    this.fetch(dt);
  }

  load(item) {
    this.idle();
    const spot = choosePlacement(this.room.grid, { id: item.id, type: item.type, wrapped: item.wrapped }, this.difficulty, this.rng);
    if (!spot) { this.p.pending.dashN = 1; this.giveUp(item); return; } // truck full: back out
    this.p.cursor = { gx: spot.gx, gz: spot.gz, rot: spot.rot };
    this.p.pending.tapN = 1;
    this.waitT = this.react();
    this.targetId = null; this.path = null;
  }

  giveUp(item) { this.room.releaseCarry(this.p); this.skip = item.id; this.waitT = this.react(); }

  carry(item, dt) {
    const t = ITEM_TYPES[item.type];
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
    if (!target || !this.stillValid(target)) { this.wantsWrap = false; target = this.chooseTarget(); this.targetId = target?.id || null; this.path = null; }
    if (!target) { this.idle(); this.wander(dt); return; }
    const t = ITEM_TYPES[target.type];
    const d = Math.hypot(target.x - p.x, target.z - p.z);
    if (d > 1.15) { this.goTo(target, dt, false); return; }
    this.idle();
    // at the item
    if (target.assembled || (this.wantsWrap && t.needsWrap && !target.wrapped)) {
      if (room.nearestItem(p)?.id !== target.id) { this.goTo(target, dt, false); return; } // get closer
      p.in.hold = true;
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
      if (it.state !== 'floor' || it.id === this.skip || this.claimed(it)) continue;
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
    if (this.rng() < this.cfg.callout) this.calloutAt = 2 + this.rng() * 5;
  }

  meetingVote() {
    const room = this.room, p = this.p;
    const others = room.activePlayers().filter(o => o.id !== p.id);
    if (!others.length) return 'skip';
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
