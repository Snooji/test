// Meeting UI e2e (server must run with DEBUG_HOOKS=1): node test/e2e-meeting.mjs [base] [outDir]
import { chromium } from 'playwright';
const base = process.argv[2] || 'http://localhost:2567', out = process.argv[3] || '.';
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const errors = []; const wait = (ms) => new Promise(r => setTimeout(r, ms));
async function player(name, email, url) {
  const page = await (await browser.newContext({ viewport: { width: 1100, height: 760 } })).newPage();
  page.on('pageerror', e => errors.push(name + ': ' + e.message));
  await page.goto(url); await page.fill('#gate-name', name); await page.fill('#gate-email', email); await page.click('#gate-form button');
  return page;
}
const a = await player('Ada', 'ada@example.com', base);
await a.click('#btn-create'); await a.waitForFunction(() => window.__sm.snap?.phase === 'lobby');
const link = await a.inputValue('#share-link');
const b = await player('Bo', 'bo@example.com', link);
const c = await player('Cy', 'cy@example.com', link);
await a.waitForFunction(() => window.__sm.snap?.players.length === 3);
await a.click('#btn-start'); await a.waitForFunction(() => window.__sm.snap?.phase === 'playing');
// Bo secretly breaks something
const bId = await b.evaluate(() => window.__sm.myId);
await b.evaluate(() => window.__sm.send('debug_break'));
await a.waitForSelector('.toast.crunch');
await a.waitForSelector('#hud-callout:not(.hidden)');
await a.screenshot({ path: `${out}/10-crunch.png` });
await c.click('#hud-callout');
await a.waitForSelector('#meeting:not(.hidden)');
await a.fill('#chat-input', 'I saw Bo near the fragile box!'); await a.press('#chat-input', 'Enter');
await wait(300);
for (const p of [a, c]) await p.click(`.vote[data-id="${bId}"]`);
await wait(300);
await a.screenshot({ path: `${out}/11-meeting.png` });
await b.click('#btn-skip');
await a.waitForSelector('#verdict:not(.hidden)');
const verdict = await a.textContent('#verdict');
console.log('verdict:', verdict);
if (!/Correct/.test(verdict)) errors.push('expected correct verdict');
const bo = (await a.evaluate(() => window.__sm.snap)).players.find(p => p.id === bId);
if (bo.strikes !== 1) errors.push('Bo should have 1 strike');
await a.screenshot({ path: `${out}/12-verdict.png` });
// end round -> results screen
console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'MEETING E2E PASS');
await browser.close(); process.exit(errors.length ? 1 : 0);
