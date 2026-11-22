// Solo-vs-AI + phone truck controls e2e (server with DEBUG_HOOKS=1): node test/e2e-solo.mjs [base] [outDir]
import { chromium, devices } from 'playwright';
const base = process.argv[2] || 'http://localhost:2567', out = process.argv[3] || '.';
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const errors = []; const wait = (ms) => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(...a);
async function player(name, email, ctxOpts) {
  const page = await (await browser.newContext(ctxOpts)).newPage();
  page.on('pageerror', e => errors.push(name + ': ' + e.message));
  page.on('console', m => { if (m.type() === 'error' && !/favicon/.test(m.text())) errors.push(name + ' console: ' + m.text()); });
  await page.goto(base); await page.fill('#gate-name', name); await page.fill('#gate-email', email); await page.click('#gate-form button');
  return page;
}
const snap = (p) => p.evaluate(() => window.__sm.snap);
const meOf = async (p) => { const s = await snap(p); const id = await p.evaluate(() => window.__sm.myId); return s.players.find(x => x.id === id); };

// ---- desktop: solo vs 3 hard AI ----
const a = await player('Ada', 'qa-ada@example.com', { viewport: { width: 1280, height: 800 } });
await a.click('#home-diff button[data-level="hard"]');
await a.screenshot({ path: `${out}/s01-home.png` });
await a.click('#btn-solo');
await a.waitForFunction(() => window.__sm.snap?.players?.filter(p => p.bot).length === 3);
let s = await snap(a);
log('solo lobby:', s.players.map(p => p.name + (p.bot ? '(AI)' : '')).join(', '), '| difficulty', s.difficulty, '| house', s.level.name);
if (s.difficulty !== 'hard') errors.push('difficulty not hard');
await a.screenshot({ path: `${out}/s02-lobby.png` });
const seed0 = s.level.seed;
await a.click('#btn-reroll'); await wait(400);
s = await snap(a);
if (s.level.seed === seed0) errors.push('reroll did not change the house');
log('rerolled house:', s.level.name, s.level.rooms, 'rooms');
await a.click('#btn-start');
await a.waitForFunction(() => window.__sm.snap?.phase === 'countdown');
await wait(300);
await a.screenshot({ path: `${out}/s03-countdown.png` });
await a.waitForFunction(() => window.__sm.snap?.phase === 'playing', null, { timeout: 8000 });
await wait(5000);
await a.screenshot({ path: `${out}/s04-playing.png` });
await a.waitForFunction(() => window.__sm.snap?.loadedCount >= 2, null, { timeout: 60000 }).catch(() => errors.push('AI movers did not load anything in 60 s'));
s = await snap(a);
log('after AI play: loaded', s.loadedCount, '/', s.totalItems);
await a.screenshot({ path: `${out}/s05-ai-loading.png` });

// ---- phone: truck D-pad, drag, rotate, drop ----
const b = await player('Bo', 'qa-bo@example.com', { ...devices['iPhone 13'] });
await b.click('#btn-solo');
await b.waitForFunction(() => window.__sm.snap?.players?.filter(p => p.bot).length === 3);
await b.screenshot({ path: `${out}/s06-phone-lobby.png` });
await b.click('#btn-start');
await b.waitForFunction(() => window.__sm.snap?.phase === 'playing', null, { timeout: 8000 });
await b.evaluate(() => window.__sm.send('debug_give', { type: 'couch' }));
await b.waitForFunction(() => { const s = window.__sm.snap; return s.players.find(p => p.id === window.__sm.myId)?.loadMode; }, null, { timeout: 5000 });
await wait(1200);
const c0 = (await meOf(b)).cursor;
await b.screenshot({ path: `${out}/s07-phone-truck.png` });
if (!(await b.isVisible('#dpad'))) errors.push('D-pad not visible in the truck');
if (await b.isVisible('#joyzone')) errors.push('joystick still visible in the truck');
let dmoved = 0;
for (const dir of ['up', 'left', 'down', 'right']) {
  const before = JSON.stringify((await meOf(b)).cursor);
  await b.locator(`#dpad button[data-dir="${dir}"]`).dispatchEvent('pointerdown', { pointerId: 1 });
  await b.locator(`#dpad button[data-dir="${dir}"]`).dispatchEvent('pointerup', { pointerId: 1 });
  await wait(400);
  const after = JSON.stringify((await meOf(b)).cursor);
  log(`dpad ${dir}:`, before, '→', after);
  if (before !== after) dmoved++;
}
if (dmoved < 2) errors.push('D-pad barely moves the aim');
await b.locator('#btn-rot').dispatchEvent('pointerdown'); await b.locator('#btn-rot').dispatchEvent('pointerup');
await wait(400);
const c1 = (await meOf(b)).cursor;
log('rotate:', c0.rot, '→', c1.rot);
if (c1.rot === c0.rot) errors.push('ROTATE did not change orientation');
// drag across the truck
const box = await b.evaluate(() => { const c = document.querySelector('#app canvas'); return { w: c.clientWidth, h: c.clientHeight }; });
let moved = false;
for (const [fx, fy] of [[0.55, 0.45], [0.7, 0.55], [0.45, 0.6]]) {
  const before = JSON.stringify((await meOf(b)).cursor);
  await b.locator('#app canvas').dispatchEvent('pointerdown', { clientX: box.w * fx, clientY: box.h * fy, pointerType: 'touch', buttons: 1, pressure: 0.5 });
  await wait(300);
  if (JSON.stringify((await meOf(b)).cursor) !== before) moved = true;
}
log('drag moved aim:', moved);
if (!moved) errors.push('dragging on the truck did not move the aim');
await b.screenshot({ path: `${out}/s08-phone-aimed.png` });
await b.locator('#btn-action').dispatchEvent('pointerdown'); await wait(60); await b.locator('#btn-action').dispatchEvent('pointerup');
await wait(800);
const me = await meOf(b);
log('after drop: carry', me.carry, 'score', me.score);
if (me.carry) errors.push('drop with ACTION failed');
await b.screenshot({ path: `${out}/s09-phone-dropped.png` });

console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'SOLO E2E PASS');
await browser.close(); process.exit(errors.length ? 1 : 0);
