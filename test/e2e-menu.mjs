// In-game menu e2e (voxel look): open from the top-right button, settings stick, Escape toggles, quit goes back to the main menu.
// node test/e2e-menu.mjs [base] [outDir]
import { chromium, devices } from 'playwright';
const base = process.argv[2] || 'http://localhost:2567', out = process.argv[3] || '.';
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const errors = []; const wait = (ms) => new Promise(r => setTimeout(r, ms));
async function play(name, email, ctx) {
  const page = await (await browser.newContext(ctx)).newPage();
  page.on('pageerror', e => errors.push(name + ': ' + e.message));
  await page.goto(base); await page.fill('#gate-name', name); await page.fill('#gate-email', email); await page.click('#gate-form button');
  await page.click('#btn-solo');
  await page.waitForFunction(() => window.__sm.snap?.players?.filter(p => p.bot).length === 3);
  await page.click('#btn-start');
  await page.waitForFunction(() => window.__sm.snap?.phase === 'playing', null, { timeout: 9000 });
  return page;
}
const visible = (p, sel) => p.isVisible(sel);
for (const [label, ctx] of [['desktop', { viewport: { width: 1280, height: 800 } }], ['phone', { ...devices['iPhone 13'] }]]) {
  const p = await play('Menu' + label, `qa-menu-${label}@example.com`, ctx);
  if (!(await visible(p, '#hud-menu'))) errors.push(label + ': no menu button');
  const box = await p.locator('#hud-menu').boundingBox();
  const vw = p.viewportSize().width;
  if (!box || box.x + box.width < vw - 20 || box.y > 20 || box.height < 40) errors.push(`${label}: menu button not top-right / too small ${JSON.stringify(box)}`);
  await p.click('#hud-menu');
  if (!(await visible(p, '#game-menu'))) errors.push(label + ': menu did not open');
  await p.screenshot({ path: `${out}/menu-${label}.png` });
  // mover stands still while the menu is open
  await p.keyboard.down('d'); await wait(600); await p.keyboard.up('d');
  const me = () => p.evaluate(() => window.__sm.snap.players.find(x => x.id === window.__sm.myId));
  const a = await me(); await wait(400); const b = await me();
  if (Math.hypot(a.x - b.x, a.z - b.z) > 0.05) errors.push(label + ': mover moved with the menu open');
  await p.click('.gm-seg[data-set="cam"] button[data-v="far"]');
  if (await p.getAttribute('.gm-seg[data-set="cam"] button[data-v="far"]', 'aria-pressed') !== 'true') errors.push(label + ': camera setting not shown as picked');
  const zoom = await p.evaluate(() => window.__sm.scene.camZoom);
  if (!(zoom > 1)) errors.push(label + ': camera setting not applied');
  await p.click('#gm-resume');
  if (await visible(p, '#game-menu')) errors.push(label + ': resume did not close');
  if (label === 'desktop') {
    await p.keyboard.press('Escape'); if (!(await visible(p, '#game-menu'))) errors.push('Escape did not open');
    await p.keyboard.press('Escape'); if (await visible(p, '#game-menu')) errors.push('Escape did not close');
  }
  await p.click('#hud-menu'); await p.click('#gm-quit');
  if (!(await visible(p, '#gm-confirm'))) errors.push(label + ': no confirm before quitting');
  await p.click('#gm-quit-yes');
  await p.waitForSelector('#home:not(.hidden)', { timeout: 5000 }).catch(() => errors.push(label + ': did not land on the main menu'));
  if (await visible(p, '#hud')) errors.push(label + ': HUD still showing');
  await p.screenshot({ path: `${out}/menu-${label}-home.png` });
  console.log(label, 'ok');
}
await browser.close();
if (errors.length) { console.log('ERRORS:\n' + errors.join('\n')); process.exit(1); }
console.log('MENU E2E PASS');
