// Full load + Sabotage e2e (server with DEBUG_HOOKS=1): node test/e2e-wave2.mjs [base] [outDir]
import { chromium } from 'playwright';
const base = process.argv[2] || 'http://localhost:2567', out = process.argv[3] || '.';
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const errors = []; const wait = (ms) => new Promise(r => setTimeout(r, ms)); const log = (...a) => console.log(...a);
async function player(name, email) {
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
  page.on('pageerror', e => errors.push(name + ': ' + e.message));
  page.on('console', m => { if (m.type() === 'error' && !/favicon/.test(m.text())) errors.push(name + ' console: ' + m.text()); });
  await page.goto(base); await page.fill('#gate-name', name); await page.fill('#gate-email', email); await page.click('#gate-submit');
  return page;
}
const snap = (p) => p.evaluate(() => window.__sm.snap);
const me = async (p) => { const s = await snap(p); const id = await p.evaluate(() => window.__sm.myId); return s.players.find(x => x.id === id); };

// ---- Full load ----
const a = await player('Ada', 'qa-ada@example.com');
await a.click('#home-diff button[data-level="hard"]');
await a.click('#btn-solo');
await a.waitForFunction(() => window.__sm.snap?.players?.filter(p => p.bot).length === 3);
await a.$eval('#modes button[data-mode="load"]', b => b.click());
await a.waitForFunction(() => window.__sm.snap?.level?.exact === true);
log('full load house:', (await snap(a)).level.name, '| desc:', await a.textContent('#game-desc'));
await a.screenshot({ path: `${out}/w01-fullload-lobby.png` });
await a.click('#btn-start');
await a.waitForFunction(() => window.__sm.snap?.phase === 'playing', null, { timeout: 8000 });
await a.evaluate(() => window.__sm.send('debug_give', { type: 'lamp' }));
await a.waitForFunction(() => window.__sm.snap.players.find(p => p.id === window.__sm.myId)?.loadMode, null, { timeout: 5000 });
await wait(800);
await a.screenshot({ path: `${out}/w02-lamp-ghost.png` });
// the aim may start on any orientation (the starting aim picks one that follows the packing rules): each R must turn it
const rots = [(await me(a)).cursor.rot];
for (let i = 0; i < 3; i++) { await a.keyboard.press('r'); await wait(250); rots.push((await me(a)).cursor.rot); }
await a.screenshot({ path: `${out}/w03-lamp-rotated.png` });
log('lamp rotation indexes:', rots.join(' → '));
if (rots.some((r, i) => i && r === rots[i - 1])) errors.push('R did not cycle lamp orientations');
await a.keyboard.press('e'); await wait(800);
let m = await me(a);
log('after drop: carry', m.carry, 'score', m.score);
if (m.carry) errors.push('lamp did not drop');
const lamp = (await snap(a)).items.find(i => i.type === 'lamp' && i.state === 'loaded');
if (!lamp?.g?.cells) errors.push('loaded lamp has no cell shape');
await wait(500);
await a.screenshot({ path: `${out}/w04-lamp-loaded.png` });
// unload it again: hold E on the ramp
await a.evaluate(() => window.__sm.send('input', { mx: 0, mz: 0, hold: false, tapN: 0, dashN: 0, rotN: 0 }));
await a.keyboard.down('e'); await wait(1400); await a.keyboard.up('e'); await wait(300);
m = await me(a);
log('unloading mode:', m.unloading, 'loadMode', m.loadMode);
if (!m.unloading) errors.push('holding E on the ramp did not start unloading');
// aim at the lamp's top cell column
const lt = lamp.g.cells.reduce((b, c) => (c[1] > b[1] ? c : b));
await a.evaluate(([gx, gz]) => window.__sm.send('aim', { gx, gz }), [lamp.g.x + lt[0], lamp.g.z + lt[2]]);
await wait(400);
await a.screenshot({ path: `${out}/w05-unload-aim.png` });
await a.keyboard.press('e'); await wait(600);
m = await me(a);
// AI movers keep loading meanwhile; if that stack is buried, try the others
for (let k = 0; k < 16 && !m.carry; k++) {
  await a.evaluate((c) => window.__sm.send('aim', { gx: c % 4, gz: Math.floor(c / 4) }), k);
  await wait(250); await a.keyboard.press('e'); await wait(400);
  m = await me(a);
}
const pulled = (await snap(a)).items.find(i => i.id === m.carry);
log('pulled out:', pulled?.type, 'score now', m.score);
if (!pulled) errors.push('could not pull a piece back out');
await a.close?.();

// ---- Sabotage ----
const b = await player('Bo', 'qa-bo@example.com');
await b.click('#btn-solo');
await b.waitForFunction(() => window.__sm.snap?.players?.filter(p => p.bot).length === 3);
await b.$eval('#games button[data-game="sabotage"]', b => b.click());
await b.waitForFunction(() => window.__sm.snap?.game === 'sabotage');
await b.screenshot({ path: `${out}/w06-sabotage-lobby.png` });
await b.click('#btn-start');
await b.waitForSelector('#role:not(.hidden)', { timeout: 8000 });
const roleText = await b.textContent('#role');
log('role card:', roleText.slice(0, 40));
await b.screenshot({ path: `${out}/w07-role-card.png` });
await b.waitForFunction(() => window.__sm.snap?.phase === 'playing', null, { timeout: 8000 });
await wait(4500);
if (!(await b.isVisible('#hud-crew'))) errors.push('crew score not shown in sabotage');
if (!(await b.isVisible('#hud-callout'))) errors.push('CALL OUT not available in sabotage');
await b.screenshot({ path: `${out}/w08-sabotage-hud.png` });
await b.click('#hud-callout');
await b.waitForSelector('#meeting:not(.hidden)', { timeout: 5000 });
await wait(2500);
await b.screenshot({ path: `${out}/w09-sabotage-meeting.png` });
log('meeting text:', (await b.textContent('#meeting-sub')).slice(0, 60));

console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'WAVE2 E2E PASS');
await browser.close(); process.exit(errors.length ? 1 : 0);
