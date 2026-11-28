// Browser e2e: node test/e2e.mjs [baseUrl] [outDir]
import { chromium } from 'playwright';
const base = process.argv[2] || 'http://localhost:2567';
const out = process.argv[3] || '.';
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const errors = [];
const wait = (ms) => new Promise(r => setTimeout(r, ms));

async function newPlayer(name, opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, ...opts });
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push(`${name}: ${e.message}`));
  page.on('console', m => { if (m.type() === 'error' && !/favicon/.test(m.text())) errors.push(`${name} console: ${m.text()}`); });
  return page;
}
const snap = (p) => p.evaluate(() => window.__sm.snap);

const a = await newPlayer('A');
await a.goto(base);
await a.fill('#gate-name', 'Ada');
await a.fill('#gate-email', 'ada@example.com');
await a.screenshot({ path: `${out}/01-gate.png` });
await a.click('#gate-submit');
await a.click('#btn-create');
await a.waitForFunction(() => window.__sm.snap?.phase === 'lobby');
const link = await a.inputValue('#share-link');
console.log('invite:', link);

const b = await newPlayer('B', { ...(await import('playwright')).devices['iPhone 13'] });
await b.goto(link);
await b.fill('#gate-name', 'Bo');
await b.fill('#gate-email', 'bo@example.com');
await b.click('#gate-submit');
await b.waitForFunction(() => window.__sm.snap?.players?.length === 2);
await b.click('.char[data-char="zibble"]');
await wait(400);
await a.screenshot({ path: `${out}/02-lobby.png` });
await b.screenshot({ path: `${out}/03-lobby-phone.png` });

// everyone readies up before the crew chief can start
if (!(await a.isDisabled('#btn-start'))) errors.push('start should be locked until Bo is ready');
await b.click('#btn-ready-lobby');
await a.waitForFunction(() => window.__sm.snap.players.every(p => p.id === window.__sm.snap.hostId || p.ready));
await a.$eval('#modes button[data-mode="3min"]', b => b.click());
await a.click('#btn-start');
await a.screenshot({ path: `${out}/04-start.png` });
const aId = await a.evaluate(() => window.__sm.myId);

// both players must see the identical generated house, and the round must start for both
await a.waitForFunction(() => window.__sm.snap?.phase === 'playing', null, { timeout: 8000 });
await b.waitForFunction(() => window.__sm.snap?.phase === 'playing', null, { timeout: 8000 });
const [la, lb] = [await a.evaluate(() => window.__sm.snap.level), await b.evaluate(() => window.__sm.snap.level)];
console.log('house:', la.name, la.rooms, 'rooms · seed', la.seed);
if (la.seed !== lb.seed) errors.push('players see different houses');
const startX = (await snap(a)).players.find(p => p.id === aId).x;
await a.keyboard.down('a'); await wait(800); await a.keyboard.up('a'); await wait(300);
const endX = (await snap(a)).players.find(p => p.id === aId).x;
console.log('moved', startX, '→', endX);
if (!(endX < startX - 1)) errors.push('keyboard movement did not move the mover');
await a.screenshot({ path: `${out}/05-desktop-play.png` });
await b.screenshot({ path: `${out}/06-phone-play.png` });
console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'E2E PASS');
await browser.close();
process.exit(errors.length ? 1 : 0);
