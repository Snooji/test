// Dropped connection mid-round (server with DEBUG_HOOKS=1): node test/e2e-reconnect.mjs [base] [outDir]
// The socket dies the way it does when a phone switches apps; the SDK reconnects on its own into the same mover.
import { chromium } from 'playwright';
const base = process.argv[2] || 'http://localhost:2567';
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const errors = []; const wait = (ms) => new Promise(r => setTimeout(r, ms));
const page = await (await browser.newContext({ viewport: { width: 1100, height: 760 } })).newPage();
page.on('pageerror', e => errors.push(e.message));
await page.goto(base); await page.fill('#gate-name', 'Rae'); await page.fill('#gate-email', 'qa-rae@example.com'); await page.click('#gate-form button');
await page.click('#btn-solo');
await page.waitForFunction(() => window.__sm.snap?.players?.filter(p => p.bot).length === 3);
await page.click('#btn-start');
await page.waitForFunction(() => window.__sm.snap?.phase === 'playing', null, { timeout: 10000 });
const before = await page.evaluate(() => ({ id: window.__sm.myId, room: window.__sm.room.roomId }));
const chat = [];
await page.exposeFunction('__chat', (t) => chat.push(t));
await page.evaluate(() => window.__sm.room.onMessage('chat', (c) => window.__chat(c.text)));
// the server cuts the socket with no close handshake: what a phone losing signal looks like (code 1006 at both ends).
// The SDK only auto-reconnects rooms joined over 5 s ago.
await wait(5200);
await page.evaluate(() => window.__sm.send('debug_drop'));
await page.waitForFunction(() => [...document.querySelectorAll('.toast')].some(t => /Reconnected/.test(t.textContent)), null, { timeout: 20000 })
  .catch(() => errors.push('never showed "Reconnected"'));
await wait(800);
const after = await page.evaluate(() => ({ id: window.__sm.myId, room: window.__sm.room?.roomId, phase: window.__sm.snap?.phase, me: window.__sm.snap?.players.find(p => p.id === window.__sm.myId) }));
console.log('before', JSON.stringify(before), '→ after', JSON.stringify({ ...after, me: after.me && { id: after.me.id, away: after.me.away } }));
if (after.room !== before.room || after.id !== before.id) errors.push('came back as someone else / in another room');
if (after.phase !== 'playing') errors.push('round did not continue: ' + after.phase);
if (!after.me || after.me.away) errors.push('mover missing or still marked away');
if (!chat.some(t => /is back/.test(t))) errors.push('crew was not told they are back: ' + JSON.stringify(chat)); // ("lost connection" goes to the others while this one is offline)
// still playable: input reaches the server
const x0 = after.me?.x;
await page.keyboard.down('KeyA'); await wait(700); await page.keyboard.up('KeyA'); await wait(400);
const x1 = await page.evaluate(() => window.__sm.snap.players.find(p => p.id === window.__sm.myId)?.x);
if (!(x1 < x0 - 0.3)) errors.push(`can't move after reconnecting: ${x0} → ${x1}`);
console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'RECONNECT E2E PASS');
await browser.close(); process.exit(errors.length ? 1 : 0);
