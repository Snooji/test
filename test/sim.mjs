// Headless playtest: node test/sim.mjs [rounds] [mode 3min|5min|load] [game classic|sabotage] [seconds] (FLOORS=n env for multi-floor houses)
import { MoveRoom } from '../server/MoveRoom.js';
const rounds = Number(process.argv[2]) || 4;
const MODE = process.argv[3] || '3min', GAME = process.argv[4] || 'classic', SECS = Number(process.argv[5]) || 180;
const rows = [];
for (const diff of ['easy', 'normal', 'hard']) for (let r = 0; r < rounds; r++) {
  const room = new MoveRoom(); room.onMessage = () => {}; room.setSimulationInterval = () => {}; room.clients = [];
  let meetings = 0; room.broadcast = (t, m) => { if (t === 'evt' && m.kind === 'meeting') meetings++; };
  room.onCreate({ seed: 7000 + r * 131, difficulty: diff, game: GAME, floors: Number(process.env.FLOORS) || 1 });
  room.mode = MODE; room.newLevel(); room.resetWorld();
  for (let i = 0; i < 4; i++) room.addBot();
  room.startRound();
  const stuck = new Map(); let maxStill = 0;
  let t = 0;
  for (; t < SECS && room.phase !== 'results'; t += 0.05) {
    room.tick(0.05);
    for (const p of room.players.values()) {
      const k = stuck.get(p.id) || { x: p.x, z: p.z, s: 0 };
      if (Math.hypot(k.x - p.x, k.z - p.z) < 0.05 && room.phase === 'playing' && !p.loadMode && !p.task) k.s += 0.05; else { k.s = 0; k.x = p.x; k.z = p.z; }
      stuck.set(p.id, k); maxStill = Math.max(maxStill, k.s);
    }
  }
  const items = [...room.items.values()];
  rows.push({ diff, house: `${room.level.name} (${room.level.rooms.length} rooms)`, loaded: `${items.filter(i => i.state === 'loaded').length}/${items.length}`,
    breaks: room.breaks.length, meetings, out: [...room.players.values()].filter(p => p.out).length, longestStill: maxStill.toFixed(1) + 's', ended: room.phase === 'results' ? `${room.results.reason} @${t.toFixed(0)}s` : `time ${t.toFixed(0)}s`, ...(GAME === 'sabotage' ? { sab: [...room.players.values()].find(p => p.saboteur)?.name, winners: room.results?.winners } : {}) });
}
console.table(rows);
