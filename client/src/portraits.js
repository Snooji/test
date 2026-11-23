// SVG portraits for the four movers — used in the lobby, HUD, meetings and concept art.
export const CHARACTERS = {
  nova:   { name: 'Nova',   kind: 'Astronaut', color: '#ff8a3d', blurb: 'Crew chief. Never drops a fragile box. Allegedly.' },
  cosmo:  { name: 'Cosmo',  kind: 'Astronaut', color: '#2ec4b6', blurb: 'Rookie with a gold visor and a lot of confidence.' },
  glorp:  { name: 'Glorp',  kind: 'Alien',     color: '#7bd84a', blurb: 'One eye, four arms, zero fear of heavy boxes.' },
  zibble: { name: 'Zibble', kind: 'Alien',     color: '#a66cff', blurb: 'Three eyes = spots every crunch. Great at call-outs.' },
};

const astronaut = (suit, visor, visorHi) => `
<svg viewBox="0 0 120 120" xmlns="http://www.w3.org/2000/svg">
  <ellipse cx="60" cy="112" rx="30" ry="5" fill="#000" opacity=".25"/>
  <rect x="26" y="52" width="16" height="34" rx="7" fill="#d9dde8"/>
  <rect x="34" y="56" width="52" height="48" rx="18" fill="${suit}"/>
  <rect x="44" y="70" width="32" height="18" rx="5" fill="#fff" opacity=".85"/>
  <path d="M60 73l2.6 5.3 5.8.8-4.2 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.2-4.1 5.8-.8z" fill="${suit}"/>
  <rect x="38" y="98" width="16" height="12" rx="5" fill="#d9dde8"/><rect x="66" y="98" width="16" height="12" rx="5" fill="#d9dde8"/>
  <circle cx="60" cy="40" r="30" fill="#f4f6fb"/>
  <circle cx="60" cy="40" r="30" fill="none" stroke="#c7ccd9" stroke-width="3"/>
  <rect x="38" y="24" width="44" height="30" rx="15" fill="${visor}"/>
  <path d="M45 32c4-5 12-6 18-5" stroke="${visorHi}" stroke-width="4" stroke-linecap="round" fill="none" opacity=".8"/>
  <line x1="60" y1="10" x2="60" y2="2" stroke="#c7ccd9" stroke-width="3"/><circle cx="60" cy="2" r="3.5" fill="${suit}"/>
</svg>`;

export const PORTRAITS = {
  nova: astronaut('#ff8a3d', '#1d2b6b', '#7fb2ff'),
  cosmo: astronaut('#2ec4b6', '#e0a526', '#fff3b0'),
  glorp: `
<svg viewBox="0 0 120 120" xmlns="http://www.w3.org/2000/svg">
  <ellipse cx="60" cy="112" rx="32" ry="5" fill="#000" opacity=".25"/>
  <path d="M40 22q-6-14 2-16M80 22q6-14-2-16" stroke="#5aa832" stroke-width="5" stroke-linecap="round" fill="none"/>
  <circle cx="42" cy="6" r="5" fill="#c6ff8f"/><circle cx="78" cy="6" r="5" fill="#c6ff8f"/>
  <path d="M60 18c28 0 40 30 40 56 0 24-16 34-40 34S20 98 20 74c0-26 12-56 40-56z" fill="#7bd84a"/>
  <ellipse cx="18" cy="72" rx="7" ry="12" fill="#6cc43d"/><ellipse cx="102" cy="72" rx="7" ry="12" fill="#6cc43d"/>
  <circle cx="60" cy="54" r="20" fill="#fff"/><circle cx="62" cy="56" r="11" fill="#1b1b3a"/><circle cx="66" cy="51" r="4" fill="#fff"/>
  <path d="M46 84q14 12 28 0" stroke="#2b5a14" stroke-width="4" stroke-linecap="round" fill="none"/>
  <rect x="38" y="92" width="44" height="10" rx="5" fill="#ff8a3d" opacity=".9"/>
</svg>`,
  zibble: `
<svg viewBox="0 0 120 120" xmlns="http://www.w3.org/2000/svg">
  <ellipse cx="60" cy="112" rx="28" ry="5" fill="#000" opacity=".25"/>
  <path d="M46 20L36 4M74 20L84 4" stroke="#7d45d9" stroke-width="4" stroke-linecap="round"/>
  <circle cx="36" cy="4" r="5" fill="#ffd166"/><circle cx="84" cy="4" r="5" fill="#ffd166"/>
  <rect x="40" y="70" width="40" height="38" rx="14" fill="#7d45d9"/>
  <rect x="46" y="78" width="28" height="14" rx="4" fill="#ffd166"/>
  <ellipse cx="60" cy="44" rx="34" ry="30" fill="#a66cff"/>
  <circle cx="44" cy="44" r="8" fill="#fff"/><circle cx="60" cy="36" r="8" fill="#fff"/><circle cx="76" cy="44" r="8" fill="#fff"/>
  <circle cx="45" cy="45" r="4" fill="#1b1b3a"/><circle cx="61" cy="37" r="4" fill="#1b1b3a"/><circle cx="77" cy="45" r="4" fill="#1b1b3a"/>
  <path d="M50 60q10 7 20 0" stroke="#3e1f73" stroke-width="3.5" stroke-linecap="round" fill="none"/>
</svg>`,
};

// ---- the voxel crew (rendered portraits in /chars) ----
import { ROSTER, rosterEntry } from '../../shared/roster.js';
/** Portrait for any mover id: classic SVG, or the voxel crew's rendered picture wrapped in an SVG so it sizes the same. */
const overrides = {}; // voxel look: rendered pictures of the four classic movers
export function setPortrait(id, url) { overrides[id] = url; }
const img = (src) => `<svg viewBox="0 0 120 120" xmlns="http://www.w3.org/2000/svg"><image href="${src}" x="0" y="0" width="120" height="120"/></svg>`;
export function portrait(id) {
  if (overrides[id]) return img(overrides[id]);
  if (PORTRAITS[id]) return PORTRAITS[id];
  if (rosterEntry(id)) return img(`/chars/${id}.png`);
  return PORTRAITS.nova;
}
export const charInfo = (id) => CHARACTERS[id] || rosterEntry(id) || CHARACTERS.nova;
export const CREW_ORDER = [...Object.keys(CHARACTERS), ...ROSTER.map(r => r.id)];
