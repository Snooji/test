// Top-down minimap: the generated house, items, movers, the truck and help pings.
import { TRUCK } from '../../shared/world.js';
import { ITEM_TYPES } from '../../shared/logic.js';

const COLORS = { nova: '#ff8a3d', cosmo: '#2ec4b6', glorp: '#7bd84a', zibble: '#a66cff' };

export function drawMinimap(canvas, level, snap, myId, pings, objective = null) {
  if (!level || !canvas) return;
  const g = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  const x0 = level.house.x0 - 2, x1 = TRUCK.cabX1 + 1, z0 = Math.min(level.house.z0, -6) - 2, z1 = Math.max(level.house.z1, 6) + 2;
  const sc = Math.min(W / (x1 - x0), H / (z1 - z0));
  const ox = (W - (x1 - x0) * sc) / 2, oz = (H - (z1 - z0) * sc) / 2;
  const X = (x) => ox + (x - x0) * sc, Z = (z) => oz + (z - z0) * sc;
  g.clearRect(0, 0, W, H);
  // multi-floor houses: show the floor you're on (positions arrive already drawn over the ground floor, with fl)
  const me = snap.players.find(p => p.id === myId), fl = me?.fl || 0, n = level.floors || 1, dz = 40 * fl;
  const onFl = (o) => (o.fl || 0) === fl;
  for (const r of level.rooms.filter(r => (r.storey || 0) === fl).map(r => ({ ...r, z0: r.z0 - dz, z1: r.z1 - dz }))) { g.fillStyle = '#' + r.floor.toString(16).padStart(6, '0'); g.fillRect(X(r.x0), Z(r.z0), (r.x1 - r.x0) * sc, (r.z1 - r.z0) * sc); }
  g.fillStyle = '#e9e4ff';
  for (const w0 of level.houseWalls.filter(w => (level.floorOf?.((w.z0 + w.z1) / 2) || 0) === fl)) { const w = { ...w0, z0: w0.z0 - dz, z1: w0.z1 - dz }; g.fillRect(X(w.x0), Z(w.z0), Math.max(1, (w.x1 - w.x0) * sc), Math.max(1, (w.z1 - w.z0) * sc)); }
  g.fillStyle = '#ffd166'; // stairs
  for (const st of level.stairs || []) if (st.b === fl || st.b === fl - 1) g.fillRect(X(st.x0), Z(Math.min(st.zl, st.zh)), (st.x1 - st.x0) * sc, Math.abs(st.zh - st.zl) * sc);
  // truck + ramp
  g.fillStyle = 'rgba(85,255,204,.35)'; g.fillRect(X(TRUCK.ramp.x0), Z(TRUCK.ramp.z0), (TRUCK.ramp.x1 - TRUCK.ramp.x0) * sc, (TRUCK.ramp.z1 - TRUCK.ramp.z0) * sc);
  g.fillStyle = '#1b1730'; g.fillRect(X(TRUCK.bayX0), Z(-2.8), (TRUCK.bayX1 - TRUCK.bayX0) * sc, 5.6 * sc);
  g.fillStyle = '#6b4dff'; g.fillRect(X(TRUCK.bayX1), Z(-2.8), (TRUCK.cabX1 - TRUCK.bayX1) * sc, 5.6 * sc);
  // items still in the house
  for (const it of snap.items) {
    if (it.state === 'loaded' || it.state === 'gone' || it.state === 'parked' || !onFl(it)) continue;
    const t = ITEM_TYPES[it.type];
    if (it.type === 'flatdolly') { // the furniture dolly: an orange ring so it's easy to find
      g.strokeStyle = '#ff8a3d'; g.lineWidth = 2; g.beginPath(); g.arc(X(it.x), Z(it.z), 4.5, 0, Math.PI * 2); g.stroke(); continue;
    }
    g.fillStyle = it.state === 'carried' ? '#ffffff' : t.fragile ? '#ffe14d' : t.furniture ? '#5b7cfa' : t.heavy ? '#7d8aa3' : '#c98d52';
    const s = t.furniture ? 4 : 3;
    g.fillRect(X(it.x) - s / 2, Z(it.z) - s / 2, s, s);
  }
  // help pings
  const now = performance.now();
  for (let i = pings.length - 1; i >= 0; i--) {
    const age = (now - pings[i].t) / 1000;
    if (age > 7) { pings.splice(i, 1); continue; }
    if ((pings[i].fl || 0) !== fl) continue;
    g.strokeStyle = `rgba(255,68,102,${1 - age / 7})`; g.lineWidth = 2;
    g.beginPath(); g.arc(X(pings[i].x), Z(pings[i].z), 4 + (age * 8) % 10, 0, Math.PI * 2); g.stroke();
  }
  // training objective: a mint ping that keeps pulsing until it's done
  if (objective) {
    const k = (performance.now() / 900) % 1;
    g.strokeStyle = `rgba(85,255,204,${1 - k})`; g.lineWidth = 2.5;
    g.beginPath(); g.arc(X(objective.x), Z(objective.z), 4 + k * 12, 0, Math.PI * 2); g.stroke();
    g.fillStyle = '#55ffcc'; g.beginPath(); g.arc(X(objective.x), Z(objective.z), 3, 0, Math.PI * 2); g.fill();
  }
  // movers
  for (const p of snap.players) {
    if (p.spectator) continue;
    if (!onFl(p)) { // someone on another floor: a small arrow at the edge (up or down)
      g.fillStyle = COLORS[p.char] || '#fff'; g.font = 'bold 10px system-ui'; g.fillText((p.fl || 0) > fl ? '▲' : '▼', X(p.x) - 4, Z(p.z) + 4); continue;
    }
    g.fillStyle = p.out ? 'rgba(255,255,255,.3)' : COLORS[p.char] || '#fff';
    g.beginPath(); g.arc(X(p.x), Z(p.z), p.id === myId ? 4.5 : 3.2, 0, Math.PI * 2); g.fill();
    if (p.id === myId) { g.strokeStyle = '#fff'; g.lineWidth = 1.5; g.stroke(); }
  }
  if (n > 1) { // which floor this is
    g.fillStyle = 'rgba(20,16,12,.75)'; g.fillRect(4, 4, 92, 18);
    g.fillStyle = '#f4ead8'; g.font = 'bold 12px system-ui'; g.fillText(`Floor ${fl + 1} of ${n}`, 9, 17);
  }
}
