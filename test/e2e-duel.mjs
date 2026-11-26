// Tap battle on a phone (server with DEBUG_HOOKS=1): node test/e2e-duel.mjs [base] [outDir]
// Starts a battle against two AI movers carrying the couch, then taps both the big TAP button and the usual action
// button the way a thumb would. Every tap should count.
import { chromium, devices } from 'playwright';
const base = process.argv[2] || 'http://localhost:2567', out = process.argv[3] || '.';
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const errors = []; const wait = (ms) => new Promise(r => setTimeout(r, ms));
const page = await (await browser.newContext({ ...devices['iPhone 13'] })).newPage();
page.on('pageerror', e => errors.push(e.message));
await page.goto(base); await page.fill('#gate-name', 'Dee'); await page.fill('#gate-email', 'qa-dee@example.com'); await page.click('#gate-form button');
await page.click('#home-diff button[data-level="hard"]');
await page.click('#btn-solo');
await page.waitForFunction(() => window.__sm.snap?.players?.filter(p => p.bot).length === 3);
await page.click('#btn-start');
await page.waitForFunction(() => window.__sm.snap?.phase === 'playing', null, { timeout: 10000 });
const myScore = () => page.evaluate(() => { const d = window.__sm.snap.duels[0]; return d ? (d.a === window.__sm.myId ? d.ca : d.cb) : null; });
// tap at the spot on screen (whatever is on top there gets it, as with a real thumb), left of centre too, where the stick
// used to sit. Taps until the battle ends (this headless browser only manages ~1 tap/s) and checks each one counted.
async function battle(sel, label) {
  await page.waitForFunction(() => !window.__sm.snap.duels?.length && !window.__sm.meNow?.()?.carry, null, { timeout: 8000 }).catch(() => {});
  await page.evaluate(() => window.__sm.send('debug_duel'));
  await page.waitForSelector('#duel:not(.hidden)', { timeout: 3000 });
  let taps = 0, score = 0;
  for (let i = 0; i < 20; i++) {
    const b = await page.locator(sel).boundingBox();
    const now = await myScore();
    if (!b || now === null) break;
    score = now;
    await page.touchscreen.tap(b.x + b.width * (i % 2 ? 0.25 : 0.65), b.y + b.height / 2); taps++;
    if (i === 1 && label === 'TAP button') await page.screenshot({ path: `${out}/d01-duel.png`, scale: 'css' });
  }
  console.log(`${label}: ${taps} taps, ${score} counted before the last one`);
  if (taps < 2) errors.push(`${label}: could not tap`);
  if (score < taps - 1 - 0.5) errors.push(`${label}: ${taps - 1} taps counted as ${score}`);
}
await battle('#duel-btn', 'TAP button');
await battle('#btn-action', 'action button');
console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'DUEL E2E PASS');
await browser.close(); process.exit(errors.length ? 1 : 0);
