// Pure game rules shared by server (and optionally client). No I/O here.

export const GRID = { W: 4, D: 4, H: 4 };

export const ITEM_TYPES = {
  standard: { label: 'Standard Box', w: 1, d: 1, pts: 10, heavy: false, fragile: false, furniture: false, needsWrap: false, needsDisassemble: false, teamCarry: false, color: 0xc89b5f },
  heavy:    { label: 'Heavy Box',    w: 1, d: 1, pts: 20, heavy: true,  fragile: false, furniture: false, needsWrap: false, needsDisassemble: false, teamCarry: false, color: 0x7a5534 },
  fragile:  { label: 'Fragile Box',  w: 1, d: 1, pts: 15, heavy: false, fragile: true,  furniture: false, needsWrap: false, needsDisassemble: false, teamCarry: false, color: 0xf2d16b },
  lamp:     { label: 'Space Lamp',   w: 1, d: 1, pts: 25, heavy: false, fragile: false, furniture: true,  needsWrap: true,  needsDisassemble: false, teamCarry: false, color: 0xff9ad5 },
  couch:    { label: 'Couch',        w: 2, d: 1, pts: 60, heavy: true,  fragile: false, furniture: true,  needsWrap: true,  needsDisassemble: false, teamCarry: true,  color: 0x5b7cfa },
  desk:     { label: 'Desk',         w: 2, d: 1, pts: 50, heavy: true,  fragile: false, furniture: true,  needsWrap: false, needsDisassemble: true,  teamCarry: true,  color: 0x9c6b3c },
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

/** Footprint of an item type at rotation 0/1. */
export function footprint(type, rot = 0) {
  const t = ITEM_TYPES[type];
  return rot % 2 ? { w: t.d, d: t.w } : { w: t.w, d: t.d };
}

export function createGrid() {
  const cells = [];
  for (let x = 0; x < GRID.W; x++) {
    cells.push([]);
    for (let z = 0; z < GRID.D; z++) cells[x].push(new Array(GRID.H).fill(null));
  }
  return { cells, items: new Map() };
}

function colTop(grid, x, z) {
  const col = grid.cells[x][z];
  for (let y = GRID.H - 1; y >= 0; y--) if (col[y] !== null) return y + 1;
  return 0;
}

/** Resting y for a w×d footprint anchored at (x,z); -1 if out of bounds or too tall. */
export function dropHeight(grid, x, z, w, d) {
  if (x < 0 || z < 0 || x + w > GRID.W || z + d > GRID.D) return -1;
  let y = 0;
  for (let i = x; i < x + w; i++) for (let k = z; k < z + d; k++) y = Math.max(y, colTop(grid, i, k));
  return y >= GRID.H ? -1 : y;
}

function fill(grid, rec, val) {
  for (let i = rec.x; i < rec.x + rec.w; i++)
    for (let k = rec.z; k < rec.z + rec.d; k++) grid.cells[i][k][rec.y] = val;
}

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
  const { w, d } = footprint(item.type, rot);
  let y = dropHeight(grid, x, z, w, d);
  if (y < 0) return { ok: false, y: -1, broken: [], reason: x < 0 || z < 0 || x + w > GRID.W || z + d > GRID.D ? 'out' : 'full' };
  const t = ITEM_TYPES[item.type];

  // An unwrapped item that needs wrapping breaks itself (only lamps are breakable this way).
  if (item.type === 'lamp' && !item.wrapped) return { ok: true, y, broken: [item.id], selfBroken: true };

  const broken = [];
  // Heavy items & furniture crush fragile boxes directly beneath them; repeat as it settles.
  if (t.heavy || t.furniture) {
    for (let guard = 0; guard < GRID.H && y > 0; guard++) {
      const crushed = new Set();
      for (let i = x; i < x + w; i++) for (let k = z; k < z + d; k++) {
        const below = grid.cells[i][k][y - 1];
        if (below && ITEM_TYPES[grid.items.get(below).type].fragile) crushed.add(below);
      }
      if (!crushed.size) break;
      for (const id of crushed) { removeItem(grid, id); broken.push(id); }
      y = dropHeight(grid, x, z, w, d);
    }
  }
  const rec = { id: item.id, type: item.type, x, y, z, w, d, rot, wrapped: !!item.wrapped, loaderIds: item.loaderIds || [] };
  grid.items.set(item.id, rec);
  fill(grid, rec, item.id);
  return { ok: true, y, broken };
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
