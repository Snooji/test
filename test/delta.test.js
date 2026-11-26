// Network: snapshots send only the items that changed (plus a full refresh every second, on join and on a new house).
// A client that merges them must always see exactly what a full snapshot would show.
import test from 'node:test';
import assert from 'node:assert/strict';
import { MoveRoom } from '../server/MoveRoom.js';
import { mergeItems } from '../shared/snap.js';

test('merged item updates always equal the full picture, and cost far less', () => {
  const room = new MoveRoom(); room.onMessage = () => {}; room.setSimulationInterval = () => {}; room.clients = [];
  const sent = []; room.broadcast = (t, m) => { if (t === 'snap') sent.push(JSON.parse(JSON.stringify(m))); };
  room.onCreate({ seed: 4242, dolly: true });
  for (let i = 0; i < 4; i++) room.addBot();
  room.startRound();
  const cache = { items: null };
  let fullBytes = 0, sentBytes = 0;
  for (let t = 0; t < 60; t += 0.05) {
    room.tick(0.05);
    const msg = sent[sent.length - 1];
    sentBytes += JSON.stringify(msg).length; fullBytes += JSON.stringify(room.snapshot()).length;
    mergeItems(msg, cache);
    const want = room.snapshot().items.map(i => JSON.stringify(i)).sort(), got = msg.items.map(i => JSON.stringify(i)).sort();
    assert.deepEqual(got, want, `t=${t.toFixed(2)}: merged items differ from the full snapshot`);
  }
  assert.ok(sentBytes < fullBytes * 0.6, `sent ${sentBytes} vs ${fullBytes} full`);
});

test('a new house (or a player joining) sends every item again', () => {
  const room = new MoveRoom(); room.onMessage = () => {}; room.setSimulationInterval = () => {}; room.clients = [];
  const sent = []; room.broadcast = (t, m) => { if (t === 'snap') sent.push(m); };
  room.onCreate({ seed: 7 });
  room.tick(0.05); room.tick(0.05);
  room.newLevel(); room.resetWorld(); room.tick(0.05);
  const last = sent[sent.length - 1];
  assert.ok(!last.itemsDelta && last.items.length === room.items.size, 'full item list after a new house');
});
