// Integration smoke test: node test/smoke.mjs [baseUrl]
import { Client } from 'colyseus.js';

const base = process.argv[2] || 'http://localhost:2567';
const wait = (ms) => new Promise(r => setTimeout(r, ms));
const fail = (m) => { console.error('FAIL:', m); process.exit(1); };

async function signup(name, email) {
  const r = await fetch(base + '/api/signup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, email }) });
  return r.json();
}

const bad = await fetch(base + '/api/signup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'x', email: 'nope' }) });
if (bad.status !== 400) fail('invalid email accepted');

const a = await signup('Ada', 'ada@example.com');
const b = await signup('Bo', 'bo@example.com');
if (!a.token) fail('no token');

const client = new Client(base.replace(/^http/, 'ws'));
try { await client.create('move', { email: 'x@example.com', token: 'bad' }); fail('bad token joined'); }
catch (e) { console.log('ok: bad token rejected —', e.message); }

const r1 = await client.create('move', { ...a, char: 'glorp' });
const r2 = await new Client(base.replace(/^http/, 'ws')).joinById(r1.roomId, { ...b });
let snap = null, evts = [];
r1.onMessage('snap', s => { snap = s; });
r1.onMessage('evt', e => evts.push(e));
r1.onMessage('chat', () => {});
r2.onMessage('snap', () => {}); r2.onMessage('evt', () => {}); r2.onMessage('chat', () => {});
await wait(300);
if (snap?.phase !== 'lobby' || snap.players.length !== 2) fail('lobby snapshot wrong: ' + JSON.stringify(snap?.players?.length));
if (snap.players.find(p => p.id === r1.sessionId).char !== 'glorp') fail('char not applied');
r1.send('mode', { mode: '5min' });
r1.send('start');
await wait(300);
if (snap.phase !== 'countdown' || snap.mode !== '5min') fail('did not start the countdown');
await wait(3400);
if (snap.phase !== 'playing') fail('countdown did not finish');
// walk player 1 left for a second
r1.send('input', { mx: -1, mz: 0, hold: false, tapN: 0, dashN: 0, rotN: 0 });
const x0 = snap.players.find(p => p.id === r1.sessionId).x;
await wait(1000);
const x1 = snap.players.find(p => p.id === r1.sessionId).x;
if (!(x1 < x0 - 2)) fail(`did not move ${x0} → ${x1}`);
r1.send('callout');
await wait(200);
if (!evts.some(e => e.kind === 'toast' && /Nothing is broken/.test(e.text))) fail('callout without break should be refused');
console.log(`ok: moved ${x0} → ${x1}, items=${snap.items.length}, time=${snap.timeLeft}`);
await r1.leave(); await r2.leave();
console.log('SMOKE PASS');
process.exit(0);
