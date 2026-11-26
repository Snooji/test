// Dolly + training-complete e2e (server with DEBUG_HOOKS=1): node test/e2e-dolly.mjs [base] [outDir]
import { chromium } from 'playwright';
const base = process.argv[2] || 'http://localhost:2567', out = process.argv[3] || '.';
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const errors = []; const wait = (ms) => new Promise(r => setTimeout(r, ms)); const log = (...a) => console.log(...a);
const p = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
p.on('pageerror', e => errors.push(e.message));
await p.goto(base); await p.fill('#gate-name', 'Dolly'); await p.fill('#gate-email', `qa-dolly-${Date.now()}@example.com`); await p.click('#gate-form button');
await p.waitForSelector('#home:not(.hidden)');
const snap = () => p.evaluate(() => window.__sm.snap);
const me = async () => { const s = await snap(); return s.players.find(x => x.id === s.__me) || s.players.find(async () => false); };
const myId = () => p.evaluate(() => window.__sm.myId);
const tap = async () => { await p.keyboard.press('e'); await wait(350); };
const tp = (x, z) => p.evaluate(([x, z]) => window.__sm.send('debug_tp', { x, z }), [x, z]);

// ---- training complete box ----
await p.click('#btn-train');
await p.waitForSelector('#coach:not(.hidden)', { timeout: 10000 });
await p.evaluate(() => window.__sm.send('debug_tutorial_done'));
await p.waitForSelector('#train-done:not(.hidden)', { timeout: 8000 }).catch(() => errors.push('training complete box did not appear'));
await wait(600);
await p.screenshot({ path: `${out}/d01-training-done.png` });
log('training box:', (await p.textContent('#train-done .td-title')).trim());
await p.click('#td-menu');
await p.waitForSelector('#home:not(.hidden)', { timeout: 5000 }).catch(() => errors.push('Back to main menu did not work'));

// ---- the dolly ----
await p.click('#btn-solo');
await p.waitForFunction(() => window.__sm.snap?.players?.length === 4);
await p.click('#btn-start');
await p.waitForFunction(() => window.__sm.snap?.phase === 'playing', null, { timeout: 8000 });
let s = await snap();
const dolly = s.items.find(i => i.type === 'dolly');
if (!dolly) errors.push('no dolly in the house');
await tp(dolly.x + 0.05, dolly.z + 0.05); await wait(300); await tap();
const id = await myId();
// wait for the state instead of a fixed pause (slow software rendering in CI can lag a frame or two)
await p.waitForFunction((id) => window.__sm.snap.players.find(x => x.id === id)?.dolly === 'dolly', id, { timeout: 4000 }).catch(() => {});
s = await snap();
if (s.players.find(x => x.id === id).dolly !== 'dolly') errors.push('could not grab the dolly');
// stack 3 boxes: always the next box still on the floor (AI movers may grab one first), and wait for each to land
for (let tries = 0; tries < 8; tries++) {
  s = await snap();
  const n = s.items.find(i => i.type === 'dolly').stack.length;
  if (n >= 3) break;
  const b = s.items.find(i => i.state === 'floor' && ['standard', 'heavy', 'fragile'].includes(i.type));
  if (!b) break;
  await tp(b.x + 0.05, b.z + 0.05); await wait(250); await tap();
  await p.waitForFunction((n) => window.__sm.snap.items.find(i => i.type === 'dolly').stack.length > n, n, { timeout: 3000 }).catch(() => {});
}
s = await snap();
const d2 = s.items.find(i => i.type === 'dolly');
log('dolly stack:', d2.stack.length, d2.stack.map(x => s.items.find(i => i.id === x).type).join(' > '));
if (d2.stack.length !== 3) errors.push('dolly did not take 3 boxes');
await tp(5, 0); await wait(600);
await p.screenshot({ path: `${out}/d02-dolly-loaded.png` });
await tp(11.2, 0); await wait(800);
s = await snap();
const meNow = s.players.find(x => x.id === id);
log('at the truck: loadMode', meNow.loadMode, 'holding', meNow.carry, 'top was', d2.stack[2]);
if (!meNow.loadMode || meNow.carry !== d2.stack[2]) errors.push('top box should come off the dolly first');
await p.screenshot({ path: `${out}/d03-dolly-unload.png` });
for (let i = 0; i < 3; i++) {
  // aim at a spot that fits (confirmed by the server), drop, and wait for THIS box to land (AI movers load things too)
  const holding = await p.evaluate(async () => {
    const w = (ms) => new Promise(r => setTimeout(r, ms)), me = () => window.__sm.snap.players.find(x => x.id === window.__sm.myId);
    for (let gz = 0; gz < 4; gz++) for (let gx = 0; gx < 4; gx++) {
      window.__sm.send('aim', { gx, gz });
      for (let k = 0; k < 20 && !(me()?.cursor?.gx === gx && me()?.cursor?.gz === gz); k++) await w(50);
      await w(150);
      if (window.__sm.scene.ghostOk) return me()?.carry;
    }
    return me()?.carry;
  });
  await tap();
  await p.waitForFunction((hid) => window.__sm.snap.items.find(it => it.id === hid)?.state === 'loaded', holding, { timeout: 5000 }).catch(() => {});
  await wait(500); // the next box comes off the dolly
}
s = await snap();
const loaded = d2.stack.filter(x => s.items.find(i => i.id === x)?.state === 'loaded').length;
log('unloaded from dolly into truck:', loaded, '| dolly uses', s.items.find(i => i.type === 'dolly').uses);
if (loaded !== 3) errors.push('not all dolly boxes went into the truck');
console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'DOLLY E2E PASS');
await browser.close(); process.exit(errors.length ? 1 : 0);
