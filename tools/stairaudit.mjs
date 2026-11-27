// Stair audit: node tools/stairaudit.mjs [houses per setup]
// For every generated multi-floor house: can the AI path from the truck up every flight to every room, does a walk up each
// flight arrive on the next floor, and how is the stairwell reached (door / open, from a hall or a room, hops from the front door).
import { generateLevel } from '../shared/level.js';
import { createNav } from '../server/nav.js';
const N = Number(process.argv[2]) || 100;
const fails = [], how = {};
let houses = 0, flights = 0;
for (const opts of [{ floors: 2 }, { floors: 3 }, { floors: 4 }, { floors: 2, mansion: true }, { floors: 3, exact: true }]) for (let i = 0; i < N; i++) {
  const s = 101 + i * 7919, L = generateLevel(s, opts), nav = createNav(L); houses++;
  const tag = `seed ${s} ${JSON.stringify(opts)} ${L.variant.layout}`;
  for (const r of L.rooms) { const c = { x: (r.x0 + r.x1) / 2, z: (r.z0 + r.z1) / 2 }; if (r.role !== 'stairs' && !nav.findPath({ x: 11, z: 0 }, c)) fails.push(`${tag}: no path to ${r.name} (floor ${r.storey})`); }
  for (const st of L.stairs) {
    flights++;
    const x = (st.x0 + st.x1) / 2, base = 40 * st.b; let z = (st.dir > 0 ? st.zl - 0.9 : st.zh + 0.9) + base;
    for (let k = 0; k < 60; k++) { const nz = z + st.dir * 0.15; if (!L.hitsWall(x, nz, 0.45)) z = nz; z += L.stairShift(x, z); }
    if (L.floorOf(z) !== st.b + 1) fails.push(`${tag}: walking up flight ${st.b} ends on floor ${L.floorOf(z)}`);
  }
  const well = L.rooms.find(r => r.role === 'stairs' && !r.storey);
  const nb = L.rooms.filter(o => o !== well && L.doorsBetween(well, o)).map(o => o.role);
  const viaOpen = (L.openings || []).some(o => { const x = o.vertical ? o.at : o.c, z = o.vertical ? o.c : o.at; return x >= well.x0 - 0.1 && x <= well.x1 + 0.1 && z >= well.z0 - 0.1 && z <= well.z1 + 0.1; });
  const key = `${viaOpen ? 'open' : 'door'} to ${nb.filter(r => r !== 'stairs').join('+')} · ${L.hopsFromFront(well)} hops`;
  how[key] = (how[key] || 0) + 1;
}
console.log(`${houses} houses, ${flights} flights: ${fails.length} problems`);
console.log(fails.slice(0, 12).join('\n'));
console.log('how the ground-floor stairwell is reached:');
for (const [k, v] of Object.entries(how).sort((a, b) => b[1] - a[1])) console.log(`  ${String(v).padStart(4)}  ${k}`);
