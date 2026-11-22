// Pure game rules shared by server (and optionally client). No I/O here.

export const GRID = { W: 4, D: 4, H: 4 };

export const ITEM_TYPES = {
  standard: { label: 'Standard Box', w: 1, d: 1, pts: 10, heavy: false, fragile: false, furniture: false, needsWrap: false, needsDisassemble: false, teamCarry: false, color: 0xc89b5f },
  heavy:    { label: 'Heavy Box',    w: 1, d: 1, pts: 20, heavy: true,  fragile: false, furniture: false, needsWrap: false, needsDisassemble: false, teamCarry: false, color: 0x7a5534 },
  fragile:  { label: 'Fragile Box',  w: 1, d: 1, pts: 15, heavy: false, fragile: true,  furniture: false, needsWrap: false, needsDisassemble: false, teamCarry: false, color: 0xf2d16b },
  // floor lamp shaped like a lower-case "r": a 2-high pole with an arm off the top (cells are [x, y, z])
  lamp:     { label: 'Floor Lamp',   w: 2, d: 1, h: 2, cells: [[0, 0, 0], [0, 1, 0], [1, 1, 0]], pts: 30, heavy: false, fragile: false, furniture: true,  needsWrap: true,  needsDisassemble: false, teamCarry: false, color: 0xff9ad5 },
  couch:    { label: 'Couch',        w: 3, d: 1, h: 1, pts: 70, heavy: true,  fragile: false, furniture: true,  needsWrap: true,  needsDisassemble: false, teamCarry: true,  color: 0x5b7cfa },
  desk:     { label: 'Desk',         w: 2, d: 1, pts: 50, heavy: true,  fragile: false, furniture: true,  needsWrap: false, needsDisassemble: true,  teamCarry: true,  color: 0x9c6b3c },
  bed:      { label: 'Bed',          w: 2, d: 3, h: 1, pts: 90, heavy: true,  fragile: false, furniture: true,  needsWrap: true,  needsDisassemble: false, teamCarry: true,  color: 0xa78bfa },
  // a hand truck: not cargo. Push it around, stack up to 3 boxes, feed them into the truck one by one
  dolly:    { label: 'Dolly',        w: 1, d: 1, pts: 0,  heavy: false, fragile: false, furniture: false, needsWrap: false, needsDisassemble: false, teamCarry: false, tool: true, color: 0x8f88aa },
  table:    { label: 'Table',        w: 2, d: 1, pts: 40, heavy: true,  fragile: false, furniture: true,  needsWrap: false, needsDisassemble: true,  teamCarry: true,  color: 0xb07d4f },
};

export const RULES = {
  HELPER_BONUS: 5,
  PENALTY: 15,
  MAX_STRIKES: 2,
  MEETING_SECONDS: 25,
  WRAP_SECONDS: 2.5,
  DISASSEMBLE_SECONDS: 3,
  MODES: { '3min': 180, '5min': 300, 'load': 900 },
};

const orientCache = new Map();

/** All 24 proper rotations of 3D space as [[axis, sign] x3] (signed permutation, det +1). */
const ROTATIONS = (() => {
  const out = [];
  const perms = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
  const parity = (p) => (p[0] > p[1]) + (p[0] > p[2]) + (p[1] > p[2]);
  for (const p of perms) for (let m = 0; m < 8; m++) {
    const sg = [m & 1 ? -1 : 1, m & 2 ? -1 : 1, m & 4 ? -1 : 1];
    const det = (parity(p) % 2 ? -1 : 1) * sg[0] * sg[1] * sg[2];
    if (det === 1) out.push(p.map((a, i) => [a, sg[i]]));
  }
  // identity first so orientation 0 is the item as it was designed
  out.sort((a, b) => (a.every(([ax, sg], i) => ax === i && sg === 1) ? -1 : 0) - (b.every(([ax, sg], i) => ax === i && sg === 1) ? -1 : 0));
  return out;
})();

function baseCells(t) {
  if (t.cells) return t.cells;
  const out = [];
  for (let x = 0; x < t.w; x++) for (let y = 0; y < (t.h || 1); y++) for (let z = 0; z < t.d; z++) out.push([x, y, z]);
  return out;
}

/** Every distinct way to set an item in the truck: all rotations and flips of its shape. */
export function orientations(type) {
  if (orientCache.has(type)) return orientCache.get(type);
  const t = ITEM_TYPES[type];
  const base = baseCells(t);
  const seen = new Set(), out = [];
  for (const rot of ROTATIONS) {
    let cells = base.map(c => rot.map(([ax, sg]) => sg * c[ax]));
    const mn = [0, 1, 2].map(i => Math.min(...cells.map(c => c[i])));
    cells = cells.map(c => c.map((v, i) => v - mn[i])).sort((a, b) => a[1] - b[1] || a[0] - b[0] || a[2] - b[2]);
    const key = cells.map(c => c.join(',')).join(';');
    if (seen.has(key)) continue;
    seen.add(key);
    const w = Math.max(...cells.map(c => c[0])) + 1, h = Math.max(...cells.map(c => c[1])) + 1, d = Math.max(...cells.map(c => c[2])) + 1;
    out.push({ w, d, h, cells });
  }
  orientCache.set(type, out);
  return out;
}

const pickOrient = (type, rot) => { const o = orientations(type); return o[((rot % o.length) + o.length) % o.length]; };

/** Bounding size of an item at orientation index `rot` (wraps around). */
export function footprint(type, rot = 0) {
  const { w, d, h } = pickOrient(type, rot);
  return { w, d, h };
}

/** Cells [x, y, z] an item occupies at orientation `rot`, relative to its anchor. */
export function shapeCells(type, rot = 0) { return pickOrient(type, rot).cells; }

export const ORIENT_LABEL = (f) => f.h >= 3 ? 'standing up' : f.h === 2 ? 'on its side' : 'lying flat';

export function createGrid() {
  const cells = [];
  for (let x = 0; x < GRID.W; x++) {
    cells.push([]);
    for (let z = 0; z < GRID.D; z++) cells[x].push(new Array(GRID.H).fill(null));
  }
  return { cells, items: new Map() };
}

/** Deep copy, so AI can try placements without touching the real truck. */
export function cloneGrid(grid) {
  return {
    cells: grid.cells.map(col => col.map(stack => stack.slice())),
    items: new Map([...grid.items].map(([k, v]) => [k, { ...v }])),
  };
}

function colTop(grid, x, z) {
  const col = grid.cells[x][z];
  for (let y = GRID.H - 1; y >= 0; y--) if (col[y] !== null) return y + 1;
  return 0;
}

/** Resting y for a w×d×h block anchored at (x,z); -1 if out of bounds or it would poke out the top. */
export function dropHeight(grid, x, z, w, d, h = 1) {
  if (x < 0 || z < 0 || x + w > GRID.W || z + d > GRID.D) return -1;
  let y = 0;
  for (let i = x; i < x + w; i++) for (let k = z; k < z + d; k++) y = Math.max(y, colTop(grid, i, k));
  return y + h > GRID.H ? -1 : y;
}

function fill(grid, rec, val) {
  for (const [cx, cy, cz] of rec.cells) grid.cells[rec.x + cx][rec.z + cz][rec.y + cy] = val;
}

/** Lowest cell of the shape in each (x, z) column it covers. */
function columnsOf(cells) {
  const m = new Map();
  for (const [x, y, z] of cells) { const k = x + ',' + z; if (!m.has(k) || m.get(k)[2] > y) m.set(k, [x, z, y]); }
  return [...m.values()];
}

/** Resting anchor y for a shape dropped at (x, z); -1 if out of bounds or it would poke out the top. */
export function shapeDrop(grid, cells, x, z) {
  let y = 0, top = 0;
  for (const [cx, cy, cz] of cells) {
    if (x + cx < 0 || z + cz < 0 || x + cx >= GRID.W || z + cz >= GRID.D) return -1;
    top = Math.max(top, cy);
  }
  for (const [cx, cz, low] of columnsOf(cells)) y = Math.max(y, colTop(grid, x + cx, z + cz) - low);
  return y + top >= GRID.H ? -1 : y;
}

export function removeFromGrid(grid, id) { removeItem(grid, id); }

function removeItem(grid, id) {
  const rec = grid.items.get(id);
  if (!rec) return;
  fill(grid, rec, null);
  grid.items.delete(id);
}

/**
 * Drop an item into the grid.
 * item: {id, type, wrapped, loaderIds?}
 * returns {ok, y, broken: string[], reason?}
 */
export function placeItem(grid, item, x, z, rot = 0) {
  const { w, d, h, cells } = pickOrient(item.type, rot);
  let y = shapeDrop(grid, cells, x, z);
  if (y < 0) return { ok: false, y: -1, broken: [], reason: x < 0 || z < 0 || x + w > GRID.W || z + d > GRID.D ? 'out' : 'full' };
  const t = ITEM_TYPES[item.type];

  // An unwrapped item that needs wrapping breaks itself (only lamps are breakable this way).
  if (item.type === 'lamp' && !item.wrapped) return { ok: true, y, broken: [item.id], selfBroken: true };

  const broken = [];
  // Heavy items & furniture crush fragile boxes directly beneath them; repeat as it settles.
  if (t.heavy || t.furniture) {
    for (let guard = 0; guard < GRID.H; guard++) {
      const crushed = new Set();
      for (const [cx, cz, low] of columnsOf(cells)) {
        if (y + low === 0) continue;
        const below = grid.cells[x + cx][z + cz][y + low - 1];
        if (below && ITEM_TYPES[grid.items.get(below).type].fragile) crushed.add(below);
      }
      if (!crushed.size) break;
      for (const id of crushed) { removeItem(grid, id); broken.push(id); }
      y = shapeDrop(grid, cells, x, z);
    }
  }
  const rec = { id: item.id, type: item.type, x, y, z, w, d, h, rot, cells, wrapped: !!item.wrapped, loaderIds: item.loaderIds || [] };
  grid.items.set(item.id, rec);
  fill(grid, rec, item.id);
  return { ok: true, y, broken };
}

/** Can any of these item types still fit anywhere in the truck, in any orientation? */
export function canFitAny(grid, types) {
  for (const type of new Set(types)) for (const o of orientations(type))
    for (let x = 0; x <= GRID.W - o.w; x++) for (let z = 0; z <= GRID.D - o.d; z++) if (shapeDrop(grid, o.cells, x, z) >= 0) return true;
  return false;
}

/** An item can be pulled back out only if nothing rests on top of it. */
export function isRemovable(grid, id) {
  const rec = grid.items.get(id);
  if (!rec) return false;
  for (const [cx, cy, cz] of rec.cells) {
    const above = rec.y + cy + 1 < GRID.H ? grid.cells[rec.x + cx][rec.z + cz][rec.y + cy + 1] : null;
    if (above && above !== id) return false;
  }
  return true;
}

/** Top item in a truck column, or null. */
export function topItemAt(grid, gx, gz) {
  if (gx < 0 || gz < 0 || gx >= GRID.W || gz >= GRID.D) return null;
  for (let y = GRID.H - 1; y >= 0; y--) if (grid.cells[gx][gz][y]) return grid.cells[gx][gz][y];
  return null;
}

export function mulberryFor(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Build a "Full load" inventory that fills the 64-cell truck exactly, by packing it first.
 * Returns { pieces: type[], solution: [{id, type, gx, gz, rot}] } — the solution is a drop order
 * that leaves no gaps and crushes nothing, so the puzzle is always solvable.
 */
export function buildExactLoad(rng) {
  const shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
  for (let attempt = 0; attempt < 80; attempt++) {
    const grid = createGrid();
    const solution = [];
    let n = 0;
    const big = shuffle(['bed', 'couch', 'lamp', ...(rng() < 0.7 ? ['desk'] : []), ...(rng() < 0.6 ? ['table'] : []), ...(rng() < 0.5 ? ['lamp'] : [])]);
    const required = new Set(['bed', 'couch', 'lamp']);
    const flatFit = (cells, x, z) => {
      const y = shapeDrop(grid, cells, x, z);
      if (y < 0) return -1;
      for (const [cx, cz, low] of columnsOf(cells)) if (colTop(grid, x + cx, z + cz) !== y + low) return -1; // no gaps underneath
      return y;
    };
    let failed = false;
    for (const type of big) {
      // sprinkle a few boxes first so furniture doesn't always sit on the floor
      for (let k = Math.floor(rng() * 4); k--;) {
        const x = Math.floor(rng() * GRID.W), z = Math.floor(rng() * GRID.D);
        if (colTop(grid, x, z) < GRID.H - 1) { const id = 'p' + n++; placeItem(grid, { id, type: 'standard' }, x, z, 0); solution.push({ id, type: 'standard', gx: x, gz: z, rot: 0 }); }
      }
      const tries = [];
      orientations(type).forEach((o, rot) => { for (let x = 0; x <= GRID.W - o.w; x++) for (let z = 0; z <= GRID.D - o.d; z++) tries.push([rot, x, z]); });
      shuffle(tries);
      let placed = false;
      for (const [rot, x, z] of tries) {
        if (flatFit(orientations(type)[rot].cells, x, z) < 0) continue;
        const id = 'p' + n++;
        placeItem(grid, { id, type, wrapped: true }, x, z, rot);
        solution.push({ id, type, gx: x, gz: z, rot });
        placed = true; break;
      }
      if (!placed && required.has(type)) { failed = true; break; }
    }
    if (failed) continue;
    // fill every remaining cell with a box
    for (let x = 0; x < GRID.W; x++) for (let z = 0; z < GRID.D; z++) while (colTop(grid, x, z) < GRID.H) {
      const id = 'p' + n++;
      placeItem(grid, { id, type: 'standard' }, x, z, 0);
      solution.push({ id, type: 'standard', gx: x, gz: z, rot: 0 });
    }
    // give boxes their labels; a fragile box never ends up under something heavy
    const typeOf = new Map(solution.map(s => [s.id, s.type]));
    for (const s of solution) if (s.type === 'standard') { const r = rng(); typeOf.set(s.id, r < 0.3 ? 'heavy' : r < 0.6 ? 'fragile' : 'standard'); }
    for (const s of solution) {
      if (typeOf.get(s.id) !== 'fragile') continue;
      const rec = grid.items.get(s.id);
      const above = rec.y + 1 < GRID.H ? grid.cells[rec.x][rec.z][rec.y + 1] : null;
      if (above) { const t = ITEM_TYPES[typeOf.get(above)]; if (t.heavy || t.furniture) typeOf.set(s.id, 'standard'); }
    }
    for (const s of solution) s.type = typeOf.get(s.id);
    if (!solution.some(s => s.type === 'fragile') || !solution.some(s => s.type === 'heavy')) continue;
    return { pieces: solution.map(s => s.type), solution };
  }
  throw new Error('could not build an exact load');
}

/**
 * The truck drives off: how well does the load ride? Returns { damaged: [{id, type, reason, culpritIds}], safety: 0–100 }.
 * - A piece resting on less than half of its underside slides off and smashes, and smashes any fragile box it lands on.
 * - A fragile box or lamp that's only partly supported rattles loose and breaks.
 * - A lone tower (4 high, no neighbour taller than 1, not against a truck wall) tips its fragile top.
 * culpritIds = whoever loaded the piece that slid or toppled.
 */
export function driveOffCheck(grid) {
  const damaged = new Map();
  const add = (id, reason, culpritIds) => { if (!damaged.has(id)) damaged.set(id, { id, type: grid.items.get(id).type, reason, culpritIds: [...(culpritIds || [])] }); };
  const breaksEasily = (type) => ITEM_TYPES[type].fragile || type === 'lamp';
  for (const rec of grid.items.values()) {
    const cols = columnsOf(rec.cells);
    let supported = 0;
    for (const [cx, cz, low] of cols) { const y = rec.y + low; if (y === 0 || grid.cells[rec.x + cx][rec.z + cz][y - 1]) supported++; }
    const ratio = supported / cols.length;
    const label = ITEM_TYPES[rec.type].label.toLowerCase();
    if (ratio < 0.5) {
      add(rec.id, 'slid off its stack and smashed', rec.loaderIds);
      for (const [cx, cz, low] of cols) { // it falls into the gaps below
        const x = rec.x + cx, z = rec.z + cz;
        let y = rec.y + low - 1;
        if (y < 0 || grid.cells[x][z][y]) continue;
        while (y >= 0 && !grid.cells[x][z][y]) y--;
        if (y >= 0) { const vid = grid.cells[x][z][y]; if (ITEM_TYPES[grid.items.get(vid).type].fragile) add(vid, `got smashed by a sliding ${label}`, rec.loaderIds); }
      }
    } else if (ratio < 1 && breaksEasily(rec.type)) add(rec.id, 'rattled loose over a gap and broke', rec.loaderIds);
  }
  for (let x = 0; x < GRID.W; x++) for (let z = 0; z < GRID.D; z++) {
    if (colTop(grid, x, z) !== GRID.H) continue;
    const nbrs = [[x - 1, z], [x + 1, z], [x, z - 1], [x, z + 1]];
    const braced = nbrs.some(([nx, nz]) => nx < 0 || nz < 0 || nx >= GRID.W || nz >= GRID.D || colTop(grid, nx, nz) >= 2);
    if (braced) continue;
    const id = grid.cells[x][z][GRID.H - 1];
    const rec = grid.items.get(id);
    if (rec && breaksEasily(rec.type)) add(id, 'toppled off a wobbly tower', rec.loaderIds);
  }
  const total = grid.items.size;
  return { damaged: [...damaged.values()], safety: total ? Math.round((100 * (total - damaged.size)) / total) : 100 };
}

/**
 * How well a piece is packed, for the end-of-round tally: 1 = perfect.
 * Partly resting on air ×0.75 · heavy sitting on a lighter box ×0.85 · fragile box with something on top ×0.8
 */
export function placementQuality(grid, id) {
  const rec = grid.items.get(id);
  if (!rec) return { q: 1, notes: [] };
  const t = ITEM_TYPES[rec.type];
  const notes = [];
  let q = 1, sup = 0;
  const below = new Set(), cols = columnsOf(rec.cells);
  for (const [cx, cz, low] of cols) {
    const y = rec.y + low;
    if (y === 0) { sup++; continue; }
    const b = grid.cells[rec.x + cx][rec.z + cz][y - 1];
    if (b) { sup++; below.add(b); }
  }
  if (sup < cols.length) { q *= 0.75; notes.push('partly resting on air'); }
  if (t.heavy && [...below].some(b => !ITEM_TYPES[grid.items.get(b).type].heavy)) { q *= 0.85; notes.push('heavy on a lighter box'); }
  if (t.fragile && rec.cells.some(([cx, cy, cz]) => { const y = rec.y + cy + 1; const a = y < GRID.H ? grid.cells[rec.x + cx][rec.z + cz][y] : null; return a && a !== id; })) { q *= 0.8; notes.push('fragile box buried under something'); }
  return { q: +q.toFixed(2), notes };
}

/** Plurality vote; ties broken by caller's own vote; no votes → 'skip'. */
export function tallyVotes(votes, callerId) {
  const counts = {};
  for (const v of Object.values(votes)) counts[v] = (counts[v] || 0) + 1;
  const entries = Object.entries(counts);
  if (!entries.length) return 'skip';
  const max = Math.max(...entries.map(e => e[1]));
  const top = entries.filter(e => e[1] === max).map(e => e[0]);
  if (top.length === 1) return top[0];
  const cv = votes[callerId];
  return cv && top.includes(cv) ? cv : 'skip';
}

// Suit colours you unlock by playing (profile = { games, wins }).
export const SUITS = [
  { id: 'classic', label: 'Classic', color: null, games: 0, wins: 0 },
  { id: 'gold', label: 'Gold', color: 0xffc43d, games: 3, wins: 0 },
  { id: 'chrome', label: 'Chrome', color: 0xc9d2e3, games: 10, wins: 0 },
  { id: 'galaxy', label: 'Galaxy', color: 0x4b2fd1, games: 0, wins: 3 },
  { id: 'neon', label: 'Neon', color: 0x39ff88, games: 0, wins: 10 },
];
export const suitUnlocked = (id, profile) => { const s = SUITS.find(x => x.id === id); return !!s && (profile?.games || 0) >= s.games && (profile?.wins || 0) >= s.wins; };

/** Everyone gets the same house on the same UTC day. */
export function dailySeed(day) {
  let h = 2166136261;
  for (const ch of 'starside-daily-' + day) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

export const TIPS = [
  'Pro mover tip: heavy boxes go on the bottom. Always.',
  'Fragile on top! Nothing heavy should ride on glassware.',
  'Pad-wrap furniture before it hits the truck. Scuffs cost money.',
  'Big pieces? Disassemble desks and tables first, then they fit flat.',
  'Lift with a buddy. Couches are a two-mover job.',
  'Build a solid floor tier first, like stacking bricks.',
  'Label your boxes by room so unloading is a breeze.',
  'Load the heaviest items toward the cab for a balanced truck.',
];
