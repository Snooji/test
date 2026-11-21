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
await a.click('#gate-form button');
await a.click('#btn-create');
await a.waitForFunction(() => window.__sm.snap?.phase === 'lobby');
const link = await a.inputValue('#share-link');
console.log('invite:', link);

const b = await newPlayer('B', { ...(await import('playwright')).devices['iPhone 13'] });
await b.goto(link);
await b.fill('#gate-name', 'Bo');
await b.fill('#gate-email', 'bo@example.com');
await b.click('#gate-form button');
await b.waitForFunction(() => window.__sm.snap?.players?.length === 2);
await b.click('.char[data-char="zibble"]');
await wait(400);
await a.screenshot({ path: `${out}/02-lobby.png` });
await b.screenshot({ path: `${out}/03-lobby-phone.png` });

await a.click('#modes button[data-mode="3min"]');
await a.click('#btn-start');
await a.waitForFunction(() => window.__sm.snap?.phase === 'playing');
await wait(800);
await a.screenshot({ path: `${out}/04-start.png` });

// A: walk to the yard box at (4,-10) — start around (11.2,-1.6)
const me = async () => { const id = await a.evaluate(() => window.__sm.myId); return (await snap(a)).players.find(p => p.id === id); };
async function walkTo(x, z) {
  for (let pass = 0; pass < 20; pass++) {
    const p = await me();
    const dx = x - p.x, dz = z - p.z;
    if (process.env.TRACE) console.log("pass", pass, p.x, p.z, "→", x, z);
    if (Math.hypot(dx, dz) < 0.5) break;
    if (Math.abs(dx) > 0.25) { const k = dx < 0 ? 'a' : 'd'; await a.keyboard.down(k); await wait(Math.abs(dx) / 5 * 500); await a.keyboard.up(k); }
    if (Math.abs(dz) > 0.25) { const k = dz < 0 ? 'w' : 's'; await a.keyboard.down(k); await wait(Math.abs(dz) / 5 * 500); await a.keyboard.up(k); }
    await wait(250);
  }
}
for (let t = 0; t < 4; t++) { await walkTo(4, -9.4); await wait(600); const q = await me(); if (Math.hypot(q.x - 4, q.z + 10) < 1.4) break; }
await a.keyboard.press('e');
await wait(300);
let p = await me();
console.log('carrying:', p.carry);
if (!p.carry) { const box = (await snap(a)).items.find(i => i.id === 'i27'); errors.push(`A failed to pick up box: me=(${p.x},${p.z}) box=(${box.x},${box.z},${box.state})`); }
await a.screenshot({ path: `${out}/05-carry.png` });
await walkTo(10.5, -1);
await wait(400);
p = await me();
console.log('loadMode:', p.loadMode);
if (!p.loadMode) errors.push('A did not enter load mode');
await a.screenshot({ path: `${out}/06-loadmode.png` });
await a.keyboard.press('e');
await wait(500);
p = await me();
console.log('score after load:', p.score);
if (p.score !== 10) errors.push('expected 10 pts after loading standard box, got ' + p.score);
await wait(500);
await a.screenshot({ path: `${out}/07-loaded.png` });
await b.screenshot({ path: `${out}/08-phone-hud.png` });

console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'E2E PASS');
await browser.close();
process.exit(errors.length ? 1 : 0);
