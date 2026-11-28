// Sabotage evidence: who can see what (the same rule for witnesses and AI movers), inspection, and the meeting payload.
import { SAB } from '../../shared/sabotage.js';

/** can a mover at `from` see the point `to`? 9 m, not through walls; in a dark room (either end) only 2 m */
export function canSee(level, from, to, sab = null) {
  const d = Math.hypot(to.x - from.x, to.z - from.z);
  const dark = sab && (sab.dark.get(sab.roomAt(from.x, from.z)) > 0 || sab.dark.get(sab.roomAt(to.x, to.z)) > 0);
  if (d > (dark ? SAB.DARK_SIGHT_M : SAB.SIGHT_M)) return false;
  return !level.lineBlocked(from.x, from.z, to.x, to.z);
}

/** a sabotage just finished: every crew mover who could see it happen gets proof */
export function witness(sab, saboteur, job) {
  for (const w of sab.room.movers()) {
    if (w === saboteur || w.saboteur || w.ghost || !sab.room.isActive(w)) continue;
    if (!canSee(sab.level, w, saboteur, sab)) continue;
    sab.proof.set(w.id, { saboteurId: saboteur.id, action: job.action, at: Math.round(sab.room.elapsed || 0) });
    const what = { weaken: 'weaken the flat boxes', cutTape: 'cut the tape on a box', mislabel: 'switch a box\'s label', loosen: 'loosen a dolly wheel', snag: 'snag the pads on a piece', stashPads: 'stash the moving pads', lightsOut: 'turn the lights out', pullTruck: 'pull a piece out of the truck' }[job.action];
    sab.room.clients.find(c => c.sessionId === w.id)?.send('evt', { kind: 'proof', saboteur: saboteur.name, action: what, text: `📸 You saw ${saboteur.name} ${what}! Call a meeting any time.` });
  }
}

/** the Inspector checks an item: tampered or not, and who handled it last (a mislabel is put right) */
export function inspect(sab, p, it) {
  const tampered = !!(it.tampered || it.loose || it.snag || it.weak);
  const what = it.tampered || (it.loose ? 'loose' : it.snag ? 'snag' : it.weak ? 'weak' : null);
  if (it.tampered === 'mislabel') { it.shownType = it.type; it.tampered = null; }
  const names = (it.lastHandlers || []).map(id => sab.room.players.get(id)?.name || 'someone who left');
  const result = { item: it.id, label: it.type, tampered, what, lastHandlers: names, by: p.name, at: Math.round(sab.room.elapsed || 0) };
  sab.inspected.push(result); if (sab.inspected.length > 6) sab.inspected.shift();
  sab.room.clients.find(c => c.sessionId === p.id)?.send('evt', { kind: 'inspect', ...result });
  return result;
}
