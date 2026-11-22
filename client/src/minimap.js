// Top-down minimap: the generated house, items, movers, the truck and help pings.
import { TRUCK } from '../../shared/world.js';
import { ITEM_TYPES } from '../../shared/logic.js';

const COLORS = { nova: '#ff8a3d', cosmo: '#2ec4b6', glorp: '#7bd84a', zibble: '#a66cff' };

export function drawMinimap(canvas, level, snap, myId, pings) {
  if (!level || !canvas) return;
  const g = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  const x0 = level.house.x0 - 2, x1 = TRUCK.cabX1 + 1, z0 = Math.min(level.house.z0, -6) - 2, z1 = Math.max(level.house.z1, 6) + 2;
  const sc = Math.min(W / (x1 - x0), H / (z1 - z0));
  const ox = (W - (x1 - x0) * sc) / 2, oz = (H - (z1 - z0) * sc) / 2;
  const X = (x) => ox + (x - x0) * sc, Z = (z) => oz + (z - z0) * sc;
  g.clearRect(0, 0, W, H);
  for (const r of level.rooms) { g.fillStyle = '#' + r.floor.toString(16).padStart(6, '0'); g.fillRect(X(r.x0), Z(r.z0), (r.x1 - r.x0) * sc, (r.z1 - r.z0) * sc); }
  g.fillStyle = '#e9e4ff';
  for (const w of level.houseWalls) g.fillRect(X(w.x0), Z(w.z0), Math.max(1, (w.x1 - w.x0) * sc), Math.max(1, (w.z1 - w.z0) * sc));
  // truck + ramp
  g.fillStyle = 'rgba(85,255,204,.35)'; g.fillRect(X(TRUCK.ramp.x0), Z(TRUCK.ramp.z0), (TRUCK.ramp.x1 - TRUCK.ramp.x0) * sc, (TRUCK.ramp.z1 - TRUCK.ramp.z0) * sc);
  g.fillStyle = '#1b1730'; g.fillRect(X(TRUCK.bayX0), Z(-2.8), (TRUCK.bayX1 - TRUCK.bayX0) * sc, 5.6 * sc);
  g.fillStyle = '#6b4dff'; g.fillRect(X(TRUCK.bayX1), Z(-2.8), (TRUCK.cabX1 - TRUCK.bayX1) * sc, 5.6 * sc);
  // items still in the house
  for (const it of snap.items) {
    if (it.state === 'loaded') continue;
    const t = ITEM_TYPES[it.type];
    g.fillStyle = it.state === 'carried' ? '#ffffff' : t.fragile ? '#ffd166' : t.furniture ? '#5b7cfa' : t.heavy ? '#a0703f' : '#d9a066';
    const s = t.furniture ? 4 : 3;
    g.fillRect(X(it.x) - s / 2, Z(it.z) - s / 2, s, s);
  }
  // help pings
  const now = performance.now();
  for (let i = pings.length - 1; i >= 0; i--) {
    const age = (now - pings[i].t) / 1000;
    if (age > 7) { pings.splice(i, 1); continue; }
    g.strokeStyle = `rgba(255,68,102,${1 - age / 7})`; g.lineWidth = 2;
    g.beginPath(); g.arc(X(pings[i].x), Z(pings[i].z), 4 + (age * 8) % 10, 0, Math.PI * 2); g.stroke();
  }
  // movers
  for (const p of snap.players) {
    if (p.spectator) continue;
    g.fillStyle = p.out ? 'rgba(255,255,255,.3)' : COLORS[p.char] || '#fff';
    g.beginPath(); g.arc(X(p.x), Z(p.z), p.id === myId ? 4.5 : 3.2, 0, Math.PI * 2); g.fill();
    if (p.id === myId) { g.strokeStyle = '#fff'; g.lineWidth = 1.5; g.stroke(); }
  }
}
