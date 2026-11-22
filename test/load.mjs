// Load test: node test/load.mjs [baseUrl] [rooms] [seconds]
// Opens N rooms × 4 real WebSocket players sending input at 20 Hz and checks snapshot delivery.
import { Client } from 'colyseus.js';
const base = process.argv[2] || 'http://localhost:2567';
const ROOMS = Number(process.argv[3]) || 10, SECS = Number(process.argv[4]) || 20;
const wait = (ms) => new Promise(r => setTimeout(r, ms));
const gate = await (await fetch(base + '/api/signup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Load', email: 'loadtest@example.com' }) })).json();
const ws = base.replace(/^http/, 'ws');
const players = [];
for (let r = 0; r < ROMS(); r++) {
  const host = await new Client(ws).create('move', { ...gate, name: 'L' + r });
  const others = [];
  for (let k = 0; k < 3; k++) others.push(await new Client(ws).joinById(host.roomId, { ...gate, name: `L${r}-${k}` }));
  for (const room of [host, ...others]) {
    const p = { room, snaps: 0, gaps: [], last: 0, tapN: 0 };
    room.onMessage('snap', () => { const t = performance.now(); if (p.last) p.gaps.push(t - p.last); p.last = t; p.snaps++; });
    room.onMessage('evt', () => {}); room.onMessage('chat', () => {});
    players.push(p);
  }
  host.send('mode', { mode: '5min' }); host.send('start');
}
function ROMS() { return ROOMS; }
console.log(`opened ${ROOMS} rooms, ${players.length} players; driving inputs for ${SECS}s…`);
const t0 = performance.now();
const iv = setInterval(() => {
  for (const p of players) p.room.send('input', { mx: Math.sin(performance.now() / 700 + p.snaps) , mz: Math.cos(performance.now() / 900), hold: false, tapN: Math.random() < 0.02 ? ++p.tapN : p.tapN, dashN: 0, rotN: 0 });
}, 50);
await wait(SECS * 1000);
clearInterval(iv);
const health = await (await fetch(base + '/health')).json();
const elapsed = (performance.now() - t0) / 1000;
const rates = players.map(p => p.snaps / elapsed);
const gaps = players.flatMap(p => p.gaps).sort((a, b) => a - b);
const pct = (q) => gaps[Math.floor(gaps.length * q)]?.toFixed(0);
console.log(JSON.stringify({ rooms: ROOMS, players: players.length, snapsPerSecMin: Math.min(...rates).toFixed(1), snapsPerSecAvg: (rates.reduce((a, b) => a + b, 0) / rates.length).toFixed(1), gapMs: { p50: pct(0.5), p95: pct(0.95), p99: pct(0.99) }, server: health }));
for (const p of players) p.room.leave();
await wait(500);
process.exit(0);
