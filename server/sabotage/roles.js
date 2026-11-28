// Sabotage roles: who's who, and the job lists everyone (saboteurs included) sees.
import { ITEM_TYPES } from '../../shared/logic.js';

/** 2 saboteurs with 6 movers, 1 with 4–5; then Foreman, Inspector, Driver (no Driver with 4) to the crew; the rest Movers */
export function dealRoles(movers, rng = Math.random) {
  const order = [...movers].map(p => [p, rng()]).sort((a, b) => a[1] - b[1]).map(([p]) => p);
  const nSab = movers.length >= 6 ? 2 : 1, roles = new Map();
  order.forEach((p, i) => roles.set(p.id, i < nSab ? 'saboteur' : 'mover'));
  const crewRoles = movers.length >= 5 ? ['foreman', 'inspector', 'driver'] : ['foreman', 'inspector'];
  order.slice(nSab).forEach((p, i) => { if (crewRoles[i]) roles.set(p.id, crewRoles[i]); });
  return roles;
}

/** Three jobs from the house as it is now. Saboteurs get the very same list: it doubles as their cover. */
export function jobsFor(sab, p) {
  const L = sab.level, jobs = [], items = [...sab.room.items.values()];
  const name = (ri) => (L.rooms[ri]?.name || 'house').toLowerCase();
  for (const it of items) if (it.type === 'pile') jobs.push({ text: `Repack the burst box in the ${name(sab.roomAt(it.x, it.z))}`, roomIndex: sab.roomAt(it.x, it.z) });
  for (const it of items) if (it.tell === 'tape') jobs.push({ text: `Re-tape the box in the ${name(sab.roomAt(it.x, it.z))}`, roomIndex: sab.roomAt(it.x, it.z) });
  for (const it of items) if (it.tell === 'wheel') jobs.push({ text: 'Fix the dolly\'s wobbly wheel (two movers)', roomIndex: sab.roomAt(it.x, it.z) });
  if (sab.padsOutT > 0) jobs.push({ text: 'Refill the moving pads from the garage shelf', roomIndex: null });
  for (const [ri, t] of sab.dark || []) if (t > 0) jobs.push({ text: `Flip the breaker: the ${name(ri)} is dark`, roomIndex: ri });
  const rooms = [...sab.quota.entries()].filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
  // spread people out: start the list at a room that depends on who's asking
  const k = rooms.length ? [...String(p.id)].reduce((a, c) => a + c.charCodeAt(0), 0) % rooms.length : 0;
  for (const [ri, n] of [...rooms.slice(k), ...rooms.slice(0, k)]) jobs.push({ text: `Pack the ${name(ri)}: ${n} box${n === 1 ? '' : 'es'} left`, roomIndex: ri });
  const loose = items.filter(i => i.state === 'floor' && !ITEM_TYPES[i.type].tool).length;
  if (loose) jobs.push({ text: `Carry ${loose} packed piece${loose === 1 ? '' : 's'} to the truck`, roomIndex: null });
  while (jobs.length < 3) jobs.push({ text: 'Help load the truck', roomIndex: null });
  return jobs.slice(0, 3);
}
