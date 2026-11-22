// Grid A* pathfinding over a level's walls, for AI movers. One nav per level.
import { WORLD } from '../shared/world.js';

const STEP = 0.5, X0 = WORLD.x0, Z0 = WORLD.z0;
const NX = Math.ceil((WORLD.x1 - WORLD.x0) / STEP), NZ = Math.ceil((WORLD.z1 - WORLD.z0) / STEP);
const CLEAR_R = 0.55; // a bit wider than a mover so paths keep off walls

export function createNav(level) {
const hitsWall = level.hitsWall;
const walk = new Uint8Array(NX * NZ);
for (let i = 0; i < NX; i++) for (let k = 0; k < NZ; k++) {
  walk[i + k * NX] = hitsWall(X0 + (i + 0.5) * STEP, Z0 + (k + 0.5) * STEP, CLEAR_R) ? 0 : 1;
}
const cellOf = (x, z) => [Math.floor((x - X0) / STEP), Math.floor((z - Z0) / STEP)];
const center = (i, k) => ({ x: X0 + (i + 0.5) * STEP, z: Z0 + (k + 0.5) * STEP });
const ok = (i, k) => i >= 0 && k >= 0 && i < NX && k < NZ && walk[i + k * NX] === 1;

function nearestWalkable(i, k) {
  if (ok(i, k)) return [i, k];
  for (let r = 1; r < 12; r++)
    for (let di = -r; di <= r; di++) for (let dk = -r; dk <= r; dk++)
      if (Math.max(Math.abs(di), Math.abs(dk)) === r && ok(i + di, k + dk)) return [i + di, k + dk];
  return null;
}

/** true if a circle of radius r can slide straight from a to b */
function clearLine(a, b, r = 0.45) {
  const d = Math.hypot(b.x - a.x, b.z - a.z);
  const n = Math.max(1, Math.ceil(d / 0.2));
  for (let s = 0; s <= n; s++) {
    const t = s / n;
    if (hitsWall(a.x + (b.x - a.x) * t, a.z + (b.z - a.z) * t, r)) return false;
  }
  return true;
}

/** Returns [{x,z}...] from start to goal (inclusive), smoothed; null if unreachable. */
function findPath(start, goal) {
  if (clearLine(start, goal, 0.5)) return [{ x: start.x, z: start.z }, { x: goal.x, z: goal.z }];
  const s = nearestWalkable(...cellOf(start.x, start.z));
  const g = nearestWalkable(...cellOf(goal.x, goal.z));
  if (!s || !g) return null;
  const goalPt = walk[cellOf(goal.x, goal.z)[0] + cellOf(goal.x, goal.z)[1] * NX] && !hitsWall(goal.x, goal.z, 0.45) ? { x: goal.x, z: goal.z } : center(...g);
  const N = NX * NZ, gScore = new Float32Array(N).fill(Infinity), from = new Int32Array(N).fill(-1), closed = new Uint8Array(N);
  const si = s[0] + s[1] * NX, gi = g[0] + g[1] * NX;
  const h = (i, k) => { const dx = Math.abs(i - g[0]), dk = Math.abs(k - g[1]); return Math.max(dx, dk) + 0.414 * Math.min(dx, dk); };
  // binary heap of [f, idx]
  const heap = [];
  const push = (f, idx) => { heap.push([f, idx]); let c = heap.length - 1; while (c > 0) { const p = (c - 1) >> 1; if (heap[p][0] <= heap[c][0]) break; [heap[p], heap[c]] = [heap[c], heap[p]]; c = p; } };
  const pop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; let c = 0; for (;;) { const l = 2 * c + 1, r = l + 1; let m = c; if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (r < heap.length && heap[r][0] < heap[m][0]) m = r; if (m === c) break; [heap[m], heap[c]] = [heap[c], heap[m]]; c = m; } } return top; };
  gScore[si] = 0; push(h(...s), si);
  while (heap.length) {
    const [, cur] = pop();
    if (cur === gi) break;
    if (closed[cur]) continue;
    closed[cur] = 1;
    const ci = cur % NX, ck = (cur / NX) | 0;
    for (let di = -1; di <= 1; di++) for (let dk = -1; dk <= 1; dk++) {
      if (!di && !dk) continue;
      const ni = ci + di, nk = ck + dk;
      if (!ok(ni, nk)) continue;
      if (di && dk && (!ok(ci + di, ck) || !ok(ci, ck + dk))) continue; // no corner cutting
      const nIdx = ni + nk * NX, cost = gScore[cur] + (di && dk ? 1.414 : 1);
      if (cost < gScore[nIdx]) { gScore[nIdx] = cost; from[nIdx] = cur; push(cost + h(ni, nk), nIdx); }
    }
  }
  if (from[gi] === -1 && si !== gi) return null;
  const cells = [];
  for (let c = gi; c !== -1; c = from[c]) { cells.push(center(c % NX, (c / NX) | 0)); if (c === si) break; }
  cells.reverse();
  const raw = [{ x: start.x, z: start.z }, ...cells.slice(1, -1), goalPt];
  // string-pull smoothing
  const out = [raw[0]];
  let anchor = 0;
  for (let i = 2; i < raw.length; i++) {
    if (!clearLine(raw[anchor], raw[i], 0.45)) { out.push(raw[i - 1]); anchor = i - 1; }
  }
  out.push(raw[raw.length - 1]);
  return out;
}
return { findPath, clearLine };
}
