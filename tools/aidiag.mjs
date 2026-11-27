// AI diagnostics: node tools/aidiag.mjs [floors] [rounds] [difficulty] [seconds]
import { ITEM_TYPES } from '../shared/logic.js'; globalThis.__IT = ITEM_TYPES;
// Where AI movers spend their time in a classic round, and what's left behind, by floor.
import { MoveRoom } from '../server/MoveRoom.js';
const FL = Number(process.argv[2]) || 1, N = Number(process.argv[3]) || 6, DIFF = process.argv[4] || 'normal', SECS = Number(process.argv[5]) || 900; // the round's own timer ends it
const tot = { time: {}, loaded: 0, items: 0, left: {}, leftType: {}, finished: 0, loadedAt: [], firstUp: [], upTrips: 0, downTrips: 0 };
for (let r = 0; r < N; r++) {
  const room = new MoveRoom(); room.onMessage = () => {}; room.setSimulationInterval = () => {}; room.clients = []; room.broadcast = () => {};
  room.onCreate({ seed: 7000 + r * 131, difficulty: DIFF, game: 'classic', floors: FL });
  room.newLevel(); room.resetWorld();
  for (let i = 0; i < 4; i++) room.addBot();
  room.startRound();
  const L = room.level, prevFl = new Map(); let t = 0, firstUp = null;
  for (; t < SECS && room.phase !== 'results'; t += 0.05) {
    room.tick(0.05);
    if (room.phase !== 'playing') continue;
    for (const b of room.bots.values()) {
      const p = b.p, fl = L.floorOf(p.z), it = p.carry && room.items.get(p.carry);
      let k;
      if (p.loadMode) k = 'in truck';
      else if (it && ITEM(it).teamCarry && it.carriers.length === 1) k = 'waiting for lift buddy';
      else if (it && b.resting) k = 'resting (out of energy)';
      else if (it) k = (L.onStairs(p.x, p.z) ? 'stairs ' : '') + 'carrying' + (fl ? ' (upstairs)' : '');
      else if (b.waitT > 0) k = 'pausing (reaction)';
      else if (b.targetId) k = (L.onStairs(p.x, p.z) ? 'stairs ' : '') + 'walking to item' + (fl ? ' (upstairs)' : '');
      else if (b.exploreTo) k = 'exploring' + (fl ? ' (upstairs)' : '');
      else k = 'idle/other';
      tot.time[k] = (tot.time[k] || 0) + 0.05;
      const pf = prevFl.get(p.id) ?? 0;
      if (fl > pf) { tot.upTrips++; if (firstUp === null) firstUp = t; } else if (fl < pf) tot.downTrips++;
      prevFl.set(p.id, fl);
    }
  }
  const items = [...room.items.values()].filter(i => i.type !== 'dolly' && i.type !== 'flatdolly');
  tot.items += items.length; tot.loaded += items.filter(i => i.state === 'loaded').length;
  for (const i of items) if (i.state !== 'loaded') { const f = 'floor ' + L.floorOf(i.z); tot.left[f] = (tot.left[f] || 0) + 1; tot.leftType[i.type] = (tot.leftType[i.type] || 0) + 1; }
  if (room.phase === 'results' && /loaded/i.test(room.results?.reason || '')) tot.finished++; // emptied the house before time ran out
  tot.firstUp.push(firstUp === null ? '-' : firstUp.toFixed(0));
}
function ITEM(it) { return globalThis.__IT[it.type]; }
const total = Object.values(tot.time).reduce((a, b) => a + b, 0);
console.log(`floors ${FL}, ${N} rounds, ${DIFF}: ${(100 * tot.loaded / tot.items).toFixed(0)}% loaded, ${tot.finished}/${N} finished early; first trip upstairs at ${tot.firstUp.join(',')} s; trips up ${tot.upTrips} / down ${tot.downTrips}`);
console.log('  left behind by floor', JSON.stringify(tot.left), 'by type', JSON.stringify(tot.leftType));
for (const [k, v] of Object.entries(tot.time).sort((a, b) => b[1] - a[1])) console.log(`  ${(100 * v / total).toFixed(1).padStart(5)}%  ${k}`);
