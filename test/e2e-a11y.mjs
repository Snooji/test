// Accessibility scan (WCAG 2 A/AA) of every main screen at desktop + phone: node test/e2e-a11y.mjs <path to axe.min.js>
// (axe-core is not a game dependency: npm i axe-core in a scratch folder and pass its axe.min.js)
import { chromium, devices } from 'playwright';
const AXE = process.argv[2];
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const wait = (ms) => new Promise(r => setTimeout(r, ms));
const found = new Map();
async function scan(p, label, include) {
  await p.addScriptTag({ path: AXE });
  const r = await p.evaluate(async (inc) => (await window.axe.run(inc ? { include: [[inc]] } : document, { runOnly: ['wcag2a', 'wcag2aa'], resultTypes: ['violations'] })).violations.map(v => ({ id: v.id, impact: v.impact, n: v.nodes.length, ex: v.nodes.slice(0, 3).map(x => x.target.join(' ') + ' :: ' + (x.any[0]?.message || x.failureSummary || '').slice(0, 140)) })), include);
  for (const v of r) { const k = label + ' ' + v.id; found.set(k, v); }
  console.log(label, r.length ? r.map(v => `${v.id}(${v.n})`).join(', ') : 'clean');
}
for (const [dev, ctx] of [['desk', { viewport: { width: 1280, height: 800 } }], ['phone', { ...devices['iPhone 13'] }]]) {
  const p = await (await browser.newContext(ctx)).newPage();
  await p.goto('http://localhost:2567/voxel'); await wait(1200);
  await scan(p, dev + ' gate', '#gate');
  await p.fill('#gate-name', 'Axe'); await p.fill('#gate-email', `qa-axe-${dev}-${Date.now()}@example.com`); await p.click('#gate-form button'); await wait(1200);
  await scan(p, dev + ' home', '#home');
  await p.click('#btn-solo'); await p.waitForFunction(() => window.__sm.snap?.players?.filter(x => x.bot).length === 3); await wait(800);
  await scan(p, dev + ' lobby', '#lobby');
  await p.click('#btn-start'); await p.waitForFunction(() => window.__sm.snap?.phase === 'playing', null, { timeout: 9000 }); await wait(1200);
  await scan(p, dev + ' hud', '#hud');
  await p.click('#hud-menu'); await wait(300); await scan(p, dev + ' menu', '#game-menu'); await p.click('#gm-resume');
  await p.evaluate(() => window.__sm.send('debug_end'));
  await p.waitForFunction(() => window.__sm.snap?.phase === 'results', null, { timeout: 20000 }); await wait(1500);
  await scan(p, dev + ' results', '#results');
}
for (const [k, v] of found) console.log('\n' + k, v.impact, '\n  ' + v.ex.join('\n  '));
await browser.close();
