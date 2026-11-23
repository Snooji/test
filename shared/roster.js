// Mover roster. The four classics are always free; the voxel crew (voxel look, /voxel) unlocks as you play.
// unlock: null = free, else every listed stat must be reached (from the player's saved profile).
export const CLASSIC_IDS = ['nova', 'cosmo', 'glorp', 'zibble'];

export const ROSTER = [
  { id: 'c04', name: 'Atlas',          kind: 'Heavy Lifter', blurb: 'Carries couches like they’re cushions.',            unlock: null },
  { id: 'c03', name: 'Vega',           kind: 'Navigator',    blurb: 'Knows every shortcut through every house.',          unlock: null },
  { id: 'c01', name: 'Kroak',          kind: 'Alien',        blurb: '“Ribbit” means “pivot!” where Kroak comes from.',     unlock: null },
  { id: 'c00', name: 'Halley',         kind: 'Courier',      blurb: 'Shades on. Boxes in. No questions asked.',           unlock: { games: 1 } },
  { id: 'c02', name: 'Rex Ryder',      kind: 'Bruiser',      blurb: 'Mohawk aerodynamics: +1 hustle.',                    unlock: { games: 2 } },
  { id: 'v08', name: 'Tycho',          kind: 'Long-Hauler',  blurb: 'Drives the Saturn run twice a week.',                unlock: { games: 3 } },
  { id: 'v20', name: 'Stella',         kind: 'Packer',       blurb: 'Wraps a lamp before you can say “fragile.”',          unlock: { games: 5 } },
  { id: 'v21', name: 'Sunny Dunes',    kind: 'Scout',        blurb: 'Brought a sun hat to the dark side of the moon.',    unlock: { games: 7 } },
  { id: 'v10', name: 'Juno',           kind: 'Rookie',       blurb: 'First week on the crew. Extremely excited.',         unlock: { games: 10 } },
  { id: 'v02', name: 'Dash',           kind: 'Sprinter',     blurb: 'Has never once walked anywhere.',                    unlock: { games: 15 } },
  { id: 'v23', name: 'Frost',          kind: 'Explorer',     blurb: 'Hood up. Ice-world moving veteran.',                 unlock: { games: 20 } },
  { id: 'c05', name: 'Captain Orion',  kind: 'Captain',      blurb: 'Has moved houses on four different moons.',          unlock: { wins: 1 } },
  { id: 'v05', name: 'Lumen',          kind: 'Pilot',        blurb: 'Visor tuned to spot a crunch from orbit.',           unlock: { wins: 3 } },
  { id: 'v16', name: 'Mime Moon',      kind: 'Performer',    blurb: 'Also carries invisible boxes.',                      unlock: { wins: 5 } },
  { id: 'v00', name: 'Gramps Gravity', kind: 'Veteran',      blurb: 'Moving boxes since before gravity was invented.',    unlock: { wins: 10 } },
  { id: 'v09', name: 'Bolt-9',         kind: 'Robot',        blurb: 'Factory-rated for nine thousand boxes.',             unlock: { loaded: 25 } },
  { id: 'v22', name: 'Gizmo',          kind: 'Engineer',     blurb: 'Can take apart a desk with a spoon.',                unlock: { loaded: 50 } },
  { id: 'v19', name: 'Noir',           kind: 'Night Shift',  blurb: 'Moves in silence. Mostly after midnight.',           unlock: { loaded: 100 } },
];

export const ALL_CHAR_IDS = [...CLASSIC_IDS, ...ROSTER.map(r => r.id)];
export const rosterEntry = (id) => ROSTER.find(r => r.id === id) || null;

/** Is this mover available to a player with this profile ({games, wins, loaded})? */
export function charUnlocked(id, profile) {
  if (CLASSIC_IDS.includes(id)) return true;
  const r = rosterEntry(id);
  if (!r) return false;
  if (!r.unlock) return true;
  return Object.entries(r.unlock).every(([k, n]) => (profile?.[k] || 0) >= n);
}

/** Human-readable unlock requirement, e.g. "Play 5 moves". */
export function unlockText(id) {
  const u = rosterEntry(id)?.unlock;
  if (!u) return '';
  const [k, n] = Object.entries(u)[0];
  return k === 'games' ? `Play ${n} move${n === 1 ? '' : 's'}` : k === 'wins' ? `Win ${n} move${n === 1 ? '' : 's'}` : `Load ${n} items`;
}
export const unlockProgress = (id, profile) => {
  const u = rosterEntry(id)?.unlock;
  if (!u) return 1;
  const [k, n] = Object.entries(u)[0];
  return Math.min(1, (profile?.[k] || 0) / n);
};
