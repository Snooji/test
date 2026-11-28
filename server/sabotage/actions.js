// Sabotage actions (saboteurs only) and the repairs anyone can do. Each action: a target in reach, a short hold, an effect
// with a visible tell, and a fix. (docs/superpowers/specs/2026-11-28-sabotage-packing-design.md, "Sabotage actions")
import { ITEM_TYPES, GRID, topItemAt, removeFromGrid } from '../../shared/logic.js';
import { SAB, HOLD } from '../../shared/sabotage.js';
import { inRamp } from '../../shared/world.js';

const BOXES = new Set(['standard', 'heavy', 'fragile']);
const d2 = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);

/** what a saboteur standing here would sabotage: the closest valid target in reach (or null) */
export function pickSabotage(sab, p) {
  const room = sab.room, out = [];
  for (const it of room.items.values()) {
    const d = d2(p, it);
    if (it.type === 'flatstack' && d < 1.6) out.push({ action: 'weaken', id: it.id, d });
    else if (it.type === 'padcrate' && d < 1.6 && !(sab.padsOutT > 0)) out.push({ action: 'stashPads', id: it.id, d });
    else if ((it.type === 'dolly' || it.type === 'flatdolly') && d < 1.6 && !it.loose) out.push({ action: 'loosen', id: it.id, d });
    else if (BOXES.has(it.type) && it.state === 'floor' && d < 1.3 && !it.tampered)
      out.push({ action: it.type === 'fragile' && it.shownType === 'fragile' ? 'mislabel' : 'cutTape', id: it.id, d });
    else if (ITEM_TYPES[it.type].needsWrap && it.state === 'floor' && !it.wrapped && !it.snag && d < 1.4) out.push({ action: 'snag', id: it.id, d });
  }
  for (const [ri] of sab.total) {
    const sw = sab.switchOf(ri), d = d2(p, sw);
    if (d < 1.5 && !(sab.dark.get(ri) > 0)) out.push({ action: 'lightsOut', room: ri, d });
  }
  if (inRamp(p.x, p.z) || (p.x > 8.5 && p.x < 13 && Math.abs(p.z) < 3.2)) {
    if ([...room.items.values()].some(i => i.state === 'loaded')) out.push({ action: 'pullTruck', d: 1 });
  }
  out.sort((a, b) => a.d - b.d);
  return out[0] || null;
}

/** can this sabotage go ahead right now? (null = yes, else the reason) */
export function blocked(sab, p, job) {
  if (job.action === 'pullTruck') {
    const crewNear = sab.room.movers().some(o => o !== p && !o.saboteur && sab.room.isActive(o) && !o.ghost && Math.hypot(o.x - 11, o.z) < 3);
    if (crewNear) return 'Someone is by the truck.';
  }
  return null;
}

/** the effect of a finished sabotage */
export function applySabotage(sab, p, job) {
  const room = sab.room, it = job.id && room.items.get(job.id);
  switch (job.action) {
    case 'weaken': sab.weakLeft = SAB.WEAK_BATCH; break;
    case 'cutTape': if (it) Object.assign(it, { tampered: 'cut', tell: 'tape' }); break;
    case 'mislabel': if (it) Object.assign(it, { tampered: 'mislabel', shownType: 'standard' }); break;
    case 'loosen': if (it) Object.assign(it, { loose: true, tell: 'wheel', looseT: 0 }); break;
    case 'snag': if (it) Object.assign(it, { snag: true, tell: 'frayed' }); break;
    case 'stashPads': sab.padsOutT = SAB.PADS_OUT_S; break;
    case 'lightsOut': sab.dark.set(job.room, SAB.LIGHTS_OUT_S); break;
    case 'pullTruck': pullTop(sab); break;
  }
}

/** quietly take the top piece of a random stack out of the truck and leave it by the ramp */
function pullTop(sab) {
  const room = sab.room, tops = [];
  for (let x = 0; x < GRID.W; x++) for (let z = 0; z < GRID.D; z++) { const id = topItemAt(room.grid, x, z); if (id && !tops.includes(id)) tops.push(id); }
  const id = tops[Math.floor(Math.random() * tops.length)], it = id && room.items.get(id);
  if (!it) return;
  removeFromGrid(room.grid, id); room.gridVersion++;
  Object.assign(it, { state: 'floor', g: null, earned: {}, x: 8.6, z: (Math.random() - 0.5) * 4 });
}

/** the repair an empty-handed mover holding here would do (or null) */
export function pickRepair(sab, p) {
  const room = sab.room;
  if (p.role === 'driver' && inRamp(p.x, p.z) && sab.wobbly().length) return { kind: 'restrap', key: 'truck', secs: HOLD.restrap };
  const br = room.items.get('breaker');
  if (br && d2(p, br) < 1.4) {
    if ([...sab.dark.values()].some(t => t > 0)) return { kind: 'breaker', key: 'breaker', secs: HOLD.breaker };
    if (sab.padsOutT > 0) return { kind: 'refillPads', key: 'pads', secs: HOLD.refillPads };
  }
  for (const it of room.items.values()) {
    if ((it.type === 'dolly' || it.type === 'flatdolly') && it.loose && d2(p, it) < 1.6) return { kind: 'fixWheel', key: it.id, secs: HOLD.fixWheel, pair: it };
    if (it.tampered === 'cut' && it.state === 'floor' && d2(p, it) < 1.3) return { kind: 'retape', key: it.id, secs: HOLD.retape };
  }
  return null;
}

export function applyRepair(sab, job) {
  const room = sab.room, it = room.items.get(job.key);
  switch (job.kind) {
    case 'restrap': for (const id of sab.wobbly()) sab.strapped.add(id); room.event({ kind: 'toast', text: '🪢 The Driver strapped the load down.' }); break;
    case 'breaker': sab.dark.clear(); room.event({ kind: 'toast', text: '💡 The lights are back on.' }); break;
    case 'refillPads': sab.padsOutT = 0; room.event({ kind: 'toast', text: '🧣 The moving pads are back.' }); break;
    case 'fixWheel': if (it) Object.assign(it, { loose: false, tell: null }); break;
    case 'retape': if (it) Object.assign(it, { tampered: null, tell: null }); break;
  }
}
