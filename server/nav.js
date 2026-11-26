// Grid A* pathfinding over a level's walls, for AI movers. One nav per level.
import { WORLD } from '../shared/world.js';

const STEP = 0.5;
const CLEAR_R = 0.55; // a bit wider than a mover so paths keep off walls where there's room
const TIGHT_R = 0.47; // narrow hallways: just wider than a mover (0.45); allowed, but costs more so open floor is preferred

export function createNav(level) {
const hitsWall = level.hitsWall;
const B = level.world || WORLD; // multi-floor houses: the grid covers every floor's strip
const X0 = B.x0, Z0 = B.z0, NX = Math.ceil((B.x1 - B.x0) / STEP), NZ = Math.ceil((B.z1 - B.z0) / STEP);
const floorOf = level.floorOf || (() => 0), shift = level.stairShift || (() => 0);
const DK = Math.round(40 / STEP); // one floor = this many grid rows
const N = NX * NZ;
/** stepping into the top half of a flight lands you on the next floor (same spot on screen): a portal. Precomputed per cell. */
const portalTo = new Int32Array(N).fill(-1);
const rowOn = new Int32Array(NZ); // each grid row as seen from above (all floors stacked): keeps the A* estimate honest
for (let k = 0; k < NZ; k++) rowOn[k] = k - DK * floorOf(Z0 + (k + 0.5) * STEP);
const walk = new Uint8Array(NX * NZ);
for (let i = 0; i < NX; i++) for (let k = 0; k < NZ; k++) {
  const x = X0 + (i + 0.5) * STEP, z = Z0 + (k + 0.5) * STEP;
  walk[i + k * NX] = !hitsWall(x, z, CLEAR_R) ? 1 : !hitsWall(x, z, TIGHT_R) ? 2 : 0;
}
for (let i = 0; i < NX; i++) for (let k = 0; k < NZ; k++) {
  const sh = shift(X0 + (i + 0.5) * STEP, Z0 + (k + 0.5) * STEP);
  if (sh) { const nk = k + Math.sign(sh) * DK; if (nk >= 0 && nk < NZ) portalTo[i + k * NX] = i + nk * NX; }
}
// search buffers, reused by every search (a stamp marks which cells this search has touched)
const gScore = new Float32Array(N), from = new Int32Array(N), stamp = new Int32Array(N), closedAt = new Int32Array(N);
let gen = 0, heapF = new Float32Array(1024), heapI = new Int32Array(1024);
const cellOf = (x, z) => [Math.floor((x - X0) / STEP), Math.floor((z - Z0) / STEP)];
const center = (i, k) => ({ x: X0 + (i + 0.5) * STEP, z: Z0 + (k + 0.5) * STEP });
const ok = (i, k) => i >= 0 && k >= 0 && i < NX && k < NZ && walk[i + k * NX] > 0;

function nearestWalkable(i, k) {
  if (ok(i, k)) return [i, k];
  for (let r = 1; r < 12; r++)
    for (let di = -r; di <= r; di++) for (let dk = -r; dk <= r; dk++)
      if (Math.max(Math.abs(di), Math.abs(dk)) === r && ok(i + di, k + dk)) return [i + di, k + dk];
  return null;
}

/** true if a circle of radius r can slide straight from a to b (only the walls near the line are tested) */
const walls = level.walls || [];
function clearLine(a, b, r = 0.45) {
  const lx0 = Math.min(a.x, b.x) - r, lx1 = Math.max(a.x, b.x) + r, lz0 = Math.min(a.z, b.z) - r, lz1 = Math.max(a.z, b.z) + r;
  const near = walls.filter(w => w.x1 > lx0 && w.x0 < lx1 && w.z1 > lz0 && w.z0 < lz1);
  if (!near.length) return true;
  const d = Math.hypot(b.x - a.x, b.z - a.z), n = Math.max(1, Math.ceil(d / 0.1)), r2 = r * r;
  for (let s = 0; s <= n; s++) {
    const t = s / n, x = a.x + (b.x - a.x) * t, z = a.z + (b.z - a.z) * t;
    for (const w of near) { const cx = Math.max(w.x0, Math.min(x, w.x1)), cz = Math.max(w.z0, Math.min(z, w.z1)); if ((x - cx) ** 2 + (z - cz) ** 2 < r2) return false; }
  }
  return true;
}

/** Returns [{x,z}...] from start to goal (inclusive), smoothed; null if unreachable. */
function findPath(start, goal) {
  const sameFloor = floorOf(start.z) === floorOf(goal.z);
  if (sameFloor && clearLine(start, goal, 0.5)) return [{ x: start.x, z: start.z }, { x: goal.x, z: goal.z }];
  const s = nearestWalkable(...cellOf(start.x, start.z));
  const g = nearestWalkable(...cellOf(goal.x, goal.z));
  if (!s || !g) return null;
  const goalPt = walk[cellOf(goal.x, goal.z)[0] + cellOf(goal.x, goal.z)[1] * NX] > 0 && !hitsWall(goal.x, goal.z, 0.45) ? { x: goal.x, z: goal.z } : center(...g);
  const si = s[0] + s[1] * NX, gi = g[0] + g[1] * NX, gOn = rowOn[g[1]], gI = g[0];
  gen++;
  const G = (idx) => (stamp[idx] === gen ? gScore[idx] : Infinity);
  const h = (idx) => { const dx = Math.abs(idx % NX - gI), dk = Math.abs(rowOn[(idx / NX) | 0] - gOn); return Math.max(dx, dk) + 0.414 * Math.min(dx, dk); };
  // binary heap in typed arrays (no per-node allocation)
  let hn = 0;
  const push = (f, idx) => {
    if (hn === heapF.length) { const nf = new Float32Array(hn * 2), ni = new Int32Array(hn * 2); nf.set(heapF); ni.set(heapI); heapF = nf; heapI = ni; }
    let c = hn++; while (c > 0) { const p = (c - 1) >> 1; if (heapF[p] <= f) break; heapF[c] = heapF[p]; heapI[c] = heapI[p]; c = p; }
    heapF[c] = f; heapI[c] = idx;
  };
  const pop = () => {
    const top = heapI[0], lf = heapF[--hn], li = heapI[hn];
    let c = 0; for (;;) { const l = 2 * c + 1, r = l + 1; let m = -1, mf = lf; if (l < hn && heapF[l] < mf) { m = l; mf = heapF[l]; } if (r < hn && heapF[r] < mf) { m = r; } if (m < 0) break; heapF[c] = heapF[m]; heapI[c] = heapI[m]; c = m; }
    heapF[c] = lf; heapI[c] = li; return top;
  };
  stamp[si] = gen; gScore[si] = 0; from[si] = -1; push(h(si), si);
  let found = si === gi;
  while (hn && !found) {
    const cur = pop();
    if (cur === gi) { found = true; break; }
    if (closedAt[cur] === gen) continue;
    closedAt[cur] = gen;
    const ci = cur % NX, ck = (cur / NX) | 0, gc = gScore[cur];
    for (let di = -1; di <= 1; di++) for (let dk = -1; dk <= 1; dk++) {
      if (!di && !dk) continue;
      if (!ok(ci + di, ck + dk)) continue;
      if (di && dk && (!ok(ci + di, ck) || !ok(ci, ck + dk))) continue; // no corner cutting
      let nIdx = ci + di + (ck + dk) * NX;
      if (portalTo[nIdx] >= 0) nIdx = portalTo[nIdx];
      if (!walk[nIdx]) continue;
      const cost = gc + (di && dk ? 1.414 : 1) * (walk[nIdx] === 2 ? 1.6 : 1);
      if (cost < G(nIdx)) { stamp[nIdx] = gen; gScore[nIdx] = cost; from[nIdx] = cur; push(cost + h(nIdx), nIdx); }
    }
  }
  if (!found) return null;
  const cells = [];
  for (let c = gi; ; c = from[c]) { cells.push(center(c % NX, (c / NX) | 0)); if (c === si || c < 0) break; }
  cells.reverse();
  const raw = [{ x: start.x, z: start.z }, ...cells.slice(1, -1), goalPt];
  // string-pull smoothing
  const out = [raw[0]];
  let anchor = 0;
  for (let i = 2; i < raw.length; i++) {
    if (floorOf(raw[i].z) !== floorOf(raw[anchor].z) || !clearLine(raw[anchor], raw[i], 0.52)) { out.push(raw[i - 1]); anchor = i - 1; } // a margin: a line that just grazes a door jamb snags a mover
  }
  out.push(raw[raw.length - 1]);
  return out;
}
return { findPath, clearLine };
}
