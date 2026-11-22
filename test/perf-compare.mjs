// Classic vs voxel render cost (server on :2567): node test/perf-compare.mjs <screenshotDir>
import { chromium, devices } from 'playwright';
const out = process.argv[2];
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const rows = [];
for (const [dev, ctx] of [['desktop', { viewport: { width: 1280, height: 800 } }], ['phone', { ...devices['iPhone 13'] }]]) for (const [look, path] of [['classic', '/'], ['voxel', '/voxel']]) {
  const page = await (await browser.newContext(ctx)).newPage();
  const errs = []; page.on('pageerror', e => errs.push(e.message)); page.on('console', m => { if (m.type() === 'error' && !/favicon|onMessage/.test(m.text())) errs.push(m.text()); });
  await page.goto('http://localhost:2567' + path);
  await page.fill('#gate-name', 'Perf'); await page.fill('#gate-email', `qa-perf-${dev}@example.com`); await page.click('#gate-form button');
  const stats = async (label) => page.evaluate(async (label) => {
    const sc = window.__sm.scene, r = sc.renderer;
    const dts = []; let last = performance.now();
    await new Promise(res => { const f = (t) => { dts.push(t - last); last = t; if (dts.length < 90) requestAnimationFrame(f); else res(); }; requestAnimationFrame(f); });
    dts.sort((a, b) => a - b);
    const i = r.info;
    let meshes = 0; sc.scene.traverse(o => { if (o.isMesh) meshes++; });
    return { label, drawCalls: i.render.calls, triangles: i.render.triangles, meshes, geometries: i.memory.geometries, shaders: i.programs.length, medianFrameMs: +dts[45].toFixed(1) };
  }, label);
  await page.waitForTimeout(2500);
  rows.push({ dev, look, ...(await stats('menu')) });
  await page.screenshot({ path: `${out}/${dev}-${look}-menu.png` });
  await page.click('#home-diff button[data-level="hard"]'); await page.click('#btn-solo');
  await page.waitForFunction(() => window.__sm.snap?.players?.filter(p => p.bot).length === 3);
  await page.click('#btn-start');
  await page.waitForFunction(() => window.__sm.snap?.phase === 'playing', null, { timeout: 10000 });
  await page.waitForTimeout(5000);
  rows.push({ dev, look, ...(await stats('round')) });
  await page.screenshot({ path: `${out}/${dev}-${look}-round.png` });
  if (errs.length) console.log(dev, look, 'ERRORS', errs);
  await page.context().close();
}
console.table(rows);
await browser.close();
