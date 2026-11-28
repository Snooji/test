// Deploy B e2e (server with DEBUG_HOOKS=1): node test/e2e-b.mjs [base] [outDir]
import { chromium, devices } from 'playwright';
const base = process.argv[2] || 'http://localhost:2567', out = process.argv[3] || '.';
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const errors = []; const wait = (ms) => new Promise(r => setTimeout(r, ms)); const log = (...a) => console.log(...a);
const stamp = Date.now();
async function player(name, email, opts = { viewport: { width: 1280, height: 800 } }) {
  const page = await (await browser.newContext(opts)).newPage();
  page.on('pageerror', e => errors.push(name + ': ' + e.message));
  page.on('console', m => { if (m.type() === 'error' && !/favicon|404/.test(m.text())) errors.push(name + ' console: ' + m.text()); });
  await page.goto(base); await page.fill('#gate-name', name); await page.fill('#gate-email', email); await page.click('#gate-submit');
  await page.waitForSelector('#home:not(.hidden)');
  return page;
}
const snap = (p) => p.evaluate(() => window.__sm.snap);

// ---- training ----
const a = await player('Newbie', `qa-new-${stamp}@example.com`);
await wait(800);
if (!(await a.isVisible('#btn-train'))) errors.push('training button not offered to a brand-new player');
await a.screenshot({ path: `${out}/b01-home.png` });
await a.click('#btn-train');
await a.waitForSelector('#coach:not(.hidden)', { timeout: 10000 });
log('coach says:', await a.textContent('#coach-text'));
await wait(600);
await a.screenshot({ path: `${out}/b02-training.png` });
const t0 = (await snap(a)).tutorial.step;
await a.evaluate(() => window.__sm.send('debug_give', { type: 'standard' }));
await wait(800);
const t1 = (await snap(a)).tutorial.step;
log('training step', t0, '→', t1);
if (!(t1 > t0)) errors.push('training did not advance');

// ---- quick play: two players land in the same game ----
const q1 = await player('Quick1', 'qa-q1@example.com');
const q2 = await player('Quick2', 'qa-q2@example.com', { ...devices['iPhone 13'] });
await q1.click('#btn-quick');
await q1.waitForFunction(() => window.__sm.snap?.quick === true);
await q2.click('#btn-quick');
await q2.waitForFunction(() => window.__sm.snap?.quick === true);
const [r1, r2] = [await q1.evaluate(() => window.__sm.snap.players.length), await q2.evaluate(() => location.search)];
const same = (await q1.evaluate(() => location.search)) === r2;
log('quick play same room:', same, '| auto-start in', (await snap(q1)).autoStart, 's');
if (!same) errors.push('quick play put the two players in different games');
await q1.screenshot({ path: `${out}/b03-quick-lobby.png` });
await q2.screenshot({ path: `${out}/b04-quick-phone.png` });

// ---- daily + suits + drive-off + podium + restart + new game + feedback ----
// done with those: close them so four software-rendered pages don't starve the daily round (its socket can time out)
for (const pg of [a, q1, q2]) await pg.context().close();
const d = await player('Daily', `qa-daily-${stamp}@example.com`);
await d.click('#btn-daily');
await d.waitForFunction(() => !!window.__sm.snap?.daily);
log('daily lobby note:', await d.textContent('#quick-note'));
if ((await d.locator('.suit.locked').count()) < 3) errors.push('locked suits not shown');
await d.$eval('#twists button[data-twist="zerog"]', b => b.click()).catch(() => {}); // disabled on daily: should be a no-op
await d.screenshot({ path: `${out}/b05-daily-lobby.png` });
await d.click('#btn-start');
await d.waitForFunction(() => window.__sm.snap?.phase === 'playing', null, { timeout: 8000 });
// a wobbly load: one box, then a couch balanced on it
await d.evaluate(() => window.__sm.send('debug_place', { type: 'standard', gx: 0, gz: 0 }));
await d.evaluate(() => window.__sm.send('debug_place', { type: 'standard', gx: 0, gz: 0 }));
await d.evaluate(() => window.__sm.send('debug_place', { type: 'couch', gx: 0, gz: 0, rot: 0 }));
await wait(500);
await d.evaluate(() => window.__sm.send('debug_end'));
await d.waitForFunction(() => window.__sm.snap?.phase === 'driveoff', null, { timeout: 5000 });
await wait(3200);
await d.screenshot({ path: `${out}/b06-driveoff.png` });
log('drive panel:', (await d.textContent('#drive-body')).slice(0, 90));
await d.waitForFunction(() => window.__sm.snap?.phase === 'results', null, { timeout: 15000 });
await wait(1500);
await d.screenshot({ path: `${out}/b07-podium.png` });
if ((await d.locator('.rank-list li').count()) !== 4) errors.push('results should list 4 movers');
if ((await d.locator('.rank-list li.win').count()) > 1) errors.push('at most one Mover of the Day');
log('drive summary:', await d.textContent('#res-drive'));
await d.click('#btn-ready');
await d.waitForFunction(() => window.__sm.snap?.phase === 'countdown', null, { timeout: 5000 }).catch(() => errors.push('restart did not start a new round'));
await d.waitForFunction(() => window.__sm.snap?.phase === 'playing', null, { timeout: 8000 });
await d.evaluate(() => window.__sm.send('debug_end'));
await d.waitForFunction(() => window.__sm.snap?.phase === 'results', null, { timeout: 20000 });
await d.click('#btn-newgame');
await d.waitForSelector('#feedback:not(.hidden)', { timeout: 5000 }).catch(() => errors.push('feedback question not shown after New game'));
await d.screenshot({ path: `${out}/b08-feedback.png` });
await d.click('#fb-up');
await wait(400);
if (await d.isVisible('#feedback')) errors.push('feedback did not close');
if (!(await d.isVisible('#home'))) errors.push('New game did not return to the main menu');
const board = await d.textContent('#daily-board');
log('home daily board:', board.slice(0, 80));

console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'DEPLOY-B E2E PASS');
await browser.close(); process.exit(errors.length ? 1 : 0);
