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

// ---- phone: invisible stick, word buttons, swipe to rotate, drag to aim, drop ----
const b = await player('Bo', 'qa-bo@example.com', { ...devices['iPhone 13'] });
await b.click('#btn-solo');
await b.waitForFunction(() => window.__sm.snap?.players?.filter(p => p.bot).length === 3);
await b.screenshot({ path: `${out}/s06-phone-lobby.png` });
await b.click('#btn-start');
await b.waitForFunction(() => window.__sm.snap?.phase === 'playing', null, { timeout: 8000 });
await wait(800);
// the stick is invisible until a thumb lands in the bottom left, then appears under it and steers
const vp = b.viewportSize();
if (await b.isVisible('#joybase')) errors.push('stick visible before touching');
const zone = b.locator('#joyzone');
const sx = vp.width * 0.22, sy = vp.height * 0.8;
const m0 = await meOf(b);
await zone.dispatchEvent('pointerdown', { pointerId: 7, clientX: sx, clientY: sy, pointerType: 'touch', isPrimary: true });
if (!(await b.isVisible('#joybase'))) errors.push('stick did not appear under the thumb');
const jb = await b.locator('#joybase').boundingBox();
if (!jb || Math.abs(jb.x + jb.width / 2 - sx) > 4 || Math.abs(jb.y + jb.height / 2 - sy) > 4) errors.push('stick not centred on the thumb');
await zone.dispatchEvent('pointermove', { pointerId: 7, clientX: sx + 120, clientY: sy, pointerType: 'touch' }); // past the rim: the stick follows
const jb2 = await b.locator('#joybase').boundingBox();
if (!jb2 || jb2.x <= jb.x + 20) errors.push('stick did not follow the thumb past its rim');
await wait(500);
await zone.dispatchEvent('pointerup', { pointerId: 7, clientX: sx + 120, clientY: sy, pointerType: 'touch' });
const m1 = await meOf(b);
if (Math.hypot(m1.x - m0.x, m1.z - m0.z) < 0.5) errors.push('stick did not move the mover');
// buttons: bottom right, the big one says what it will do; help only shows while holding something
const ab = await b.locator('#btn-action').boundingBox();
if (!ab || ab.x + ab.width < vp.width - 40 || ab.y + ab.height < vp.height - 60) errors.push('action button not bottom right');
if (!/^(Grab|Lift|Wrap|Take apart|Steal|Unload|Load|Stack)$/.test((await b.textContent('#action-label')).trim())) errors.push('action label: ' + await b.textContent('#action-label'));
if (await b.isVisible('#btn-help')) errors.push('help showing with empty hands');
// a piece that turns several ways (the AI crew may already have the couch in hand: fall back to another)
for (const type of ['couch', 'bed', 'lamp', 'desk', 'table']) {
  await b.evaluate((type) => window.__sm.send('debug_give', { type }), type);
  if (await b.waitForFunction(() => window.__sm.snap.players.find(p => p.id === window.__sm.myId)?.loadMode, null, { timeout: 2500 }).then(() => true).catch(() => false)) { log('in the truck with a', type); break; }
}
await wait(1200);
const c0 = (await meOf(b)).cursor;
await b.screenshot({ path: `${out}/s07-phone-truck.png` });
if ((await b.textContent('#action-label')).trim() !== 'Place') errors.push('in the truck the button should say Place, says ' + await b.textContent('#action-label'));
if (!(await b.isVisible('#dpad'))) errors.push('D-pad not visible in the truck');
if (await b.isVisible('#joyzone')) errors.push('stick still active in the truck');
if (!(await b.isVisible('#btn-rot')) || !(await b.isVisible('#btn-flip'))) errors.push('Rotate / Flip buttons missing for the couch');
let dmoved = 0;
for (const dir of ['up', 'left', 'down', 'right']) {
  const before = JSON.stringify((await meOf(b)).cursor);
  await b.locator(`#dpad button[data-dir="${dir}"]`).dispatchEvent('pointerdown', { pointerId: 1 });
  await b.locator(`#dpad button[data-dir="${dir}"]`).dispatchEvent('pointerup', { pointerId: 1 });
  const changed = await b.waitForFunction((before) => JSON.stringify(window.__sm.snap.players.find(p => p.id === window.__sm.myId)?.cursor) !== before, before, { timeout: 2000 }).then(() => true).catch(() => false);
  if (changed) dmoved++;
}
if (dmoved < 2) errors.push('D-pad barely moves the aim');
await b.locator('#btn-rot').dispatchEvent('pointerdown'); await b.locator('#btn-rot').dispatchEvent('pointerup');
await b.waitForFunction((r) => window.__sm.snap.players.find(p => p.id === window.__sm.myId)?.cursor?.rot !== r, c0.rot, { timeout: 4000 }).catch(() => {});
const c1 = (await meOf(b)).cursor;
log('rotate:', c0.rot, '→', c1.rot);
if (c1.rot === c0.rot) errors.push('Rotate did not turn the piece');
await b.locator('#btn-flip').dispatchEvent('pointerdown'); await b.locator('#btn-flip').dispatchEvent('pointerup');
await b.waitForFunction((r) => window.__sm.snap.players.find(p => p.id === window.__sm.myId)?.cursor?.rot !== r, c1.rot, { timeout: 4000 }).catch(() => {});
const c2 = (await meOf(b)).cursor;
log('flip:', c1.rot, '→', c2.rot);
if (c2.rot === c1.rot) errors.push('Flip did not tip the piece');
// drag across the truck
const box = await b.evaluate(() => { const c = document.querySelector('#app canvas'); return { w: c.clientWidth, h: c.clientHeight }; });
let moved = false;
for (const [fx, fy] of [[0.55, 0.45], [0.7, 0.55], [0.45, 0.6]]) {
  const before = JSON.stringify((await meOf(b)).cursor);
  await b.locator('#app canvas').dispatchEvent('pointerdown', { clientX: box.w * fx, clientY: box.h * fy, pointerType: 'touch', buttons: 1, pressure: 0.5 });
  // wait for the server's update rather than a fixed pause (slow software rendering can lag a few frames)
  const changed = await b.waitForFunction((before) => JSON.stringify(window.__sm.snap.players.find(p => p.id === window.__sm.myId)?.cursor) !== before, before, { timeout: 3000 }).then(() => true).catch(() => false);
  if (changed) moved = true;
}
log('drag moved aim:', moved);
if (!moved) errors.push('dragging on the truck did not move the aim');
await b.screenshot({ path: `${out}/s08-phone-aimed.png` });
// the AI crew keeps loading, so the last drag can land where the couch no longer fits: find a spot that does before dropping
const fits = await b.evaluate(async () => {
  const w = (ms) => new Promise(r => setTimeout(r, ms));
  const press = (id) => { const b = document.getElementById(id); b.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); b.dispatchEvent(new PointerEvent('pointerup', { bubbles: true })); };
  for (let turn = 0; turn < 6; turn++) { // try every spot, then turn the piece (the real buttons: input counters are cumulative)
    for (let gx = 0; gx < 4; gx++) for (let gz = 0; gz < 4; gz++) {
      window.__sm.send('aim', { gx, gz });
      const cur = () => window.__sm.snap.players.find(p => p.id === window.__sm.myId)?.cursor;
      for (let k = 0; k < 20 && !(cur()?.gx === gx && cur()?.gz === gz); k++) await w(50); // the server has the new aim
      await w(150); // and the preview has been redrawn for it
      if (cur()?.gx === gx && cur()?.gz === gz && window.__sm.scene.ghostOk) return true;
    }
    press(turn % 2 ? 'btn-flip' : 'btn-rot'); await w(400);
  }
  return false;
});
if (!fits) log('note: no spot fits the couch any more (truck full)');
await b.locator('#btn-action').dispatchEvent('pointerdown'); await wait(60); await b.locator('#btn-action').dispatchEvent('pointerup');
await b.waitForFunction(() => !window.__sm.snap.players.find(p => p.id === window.__sm.myId)?.carry, null, { timeout: 4000 }).catch(() => {});
const me = await meOf(b);
log('after drop: carry', me.carry, 'score', me.score);
if (me.carry) errors.push('drop with ACTION failed');
await b.screenshot({ path: `${out}/s09-phone-dropped.png` });

console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'SOLO E2E PASS');
await browser.close(); process.exit(errors.length ? 1 : 0);
