// Controls, controller, guidance arrow and house codes (voxel look): node test/e2e-controls.mjs [base] [outDir]
import { chromium } from 'playwright';
const base = process.argv[2] || 'http://localhost:2567', out = process.argv[3] || '.';
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const errors = []; const wait = (ms) => new Promise(r => setTimeout(r, ms));
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
// a fake controller the test can steer: window.__pad = { axes, buttons }
await ctx.addInitScript(() => {
  window.__pad = { id: 'Test pad', index: 0, connected: true, mapping: 'standard', axes: [0, 0, 0, 0], buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0 })) };
  navigator.getGamepads = () => (window.__padOn ? [window.__pad] : []);
});
const p = await ctx.newPage();
p.on('pageerror', e => errors.push(e.message));
await p.goto(base); await p.fill('#gate-name', 'Keys'); await p.fill('#gate-email', 'qa-keys@example.com'); await p.click('#gate-submit');
await p.click('#btn-solo');
await p.waitForFunction(() => window.__sm.snap?.players?.filter(x => x.bot).length === 3);
// house code
const code = await p.textContent('#house-code');
if (!/^[0-9A-Z]{1,7}$/.test(code || '')) errors.push('no house code shown: ' + code);
await p.fill('#code-input', 'moon-42'); await p.click('#code-form button');
await p.waitForFunction(() => window.__sm.snap?.level?.code === 'MOON42', null, { timeout: 4000 }).catch(() => errors.push('typed house code not used'));
const seedA = await p.evaluate(() => window.__sm.snap.level.seed);
await p.click('#floors button[data-floors="2"]');
await p.waitForFunction(() => window.__sm.snap?.level?.floors === 2, null, { timeout: 4000 }).catch(() => errors.push('floors pick not applied'));
if (await p.evaluate(() => window.__sm.snap.level.code) !== 'MOON42') errors.push('changing floors lost the house code');
if (!/Pick floors|picks/.test(await p.textContent('#setup-note'))) errors.push('no setup note');
// guidance arrow off from the lobby
await p.click('.lobby-pref .gm-seg button[data-v="off"]');
if (await p.evaluate(() => window.__sm.scene.showArrow) !== false) errors.push('arrow toggle did not apply');
await p.screenshot({ path: `${out}/controls-lobby.png` });
await p.click('#btn-start');
await p.waitForFunction(() => window.__sm.snap?.phase === 'playing', null, { timeout: 9000 });
await wait(800);
if (await p.evaluate(() => window.__sm.scene.arrow.visible)) errors.push('arrow showing while turned off');
// rebind Rotate to F; W is refused
await p.click('#hud-menu');
await p.click('.gm-change[data-act="rotate"]');
await p.keyboard.press('w');
if (!/for moving/.test(await p.textContent('#gm-keynote'))) errors.push('W was not refused');
await p.keyboard.press('f');
if (!/Rotate \(in the truck\): F/.test(await p.textContent('#gm-keynote'))) errors.push('rebind note: ' + await p.textContent('#gm-keynote'));
await p.screenshot({ path: `${out}/controls-menu.png` });
if (await p.evaluate(() => JSON.parse(localStorage.getItem('sm_keys')).rotate) !== 'KeyF') errors.push('binding not saved');
await p.click('#gm-resume');
if (!(await p.innerHTML('#keyhelp')).includes('<kbd>F</kbd> rotate')) errors.push('key help not updated');
// keyboard still moves with D
const me = () => p.evaluate(() => window.__sm.snap.players.find(x => x.id === window.__sm.myId));
let a = await me(); await p.keyboard.down('d'); await wait(500); await p.keyboard.up('d'); let b = await me();
if (!(b.x > a.x + 0.5)) errors.push('D did not move right');
// wheel drag turns the camera; W then walks away from the camera
await p.mouse.move(640, 400); await p.mouse.down({ button: 'middle' }); await p.mouse.move(836, 400, { steps: 8 }); await p.mouse.up({ button: 'middle' });
const yaw = await p.evaluate(() => window.__sm.scene.camYaw);
if (!(yaw > 1.3 && yaw < 1.8)) errors.push('wheel drag did not turn the camera: ' + yaw);
a = await me(); await p.keyboard.down('w'); await wait(500); await p.keyboard.up('w'); b = await me();
if (!(a.x - b.x > 0.5 && Math.abs(b.z - a.z) < 0.4)) errors.push(`W did not walk away from the turned camera: ${a.x.toFixed(2)},${a.z.toFixed(2)} → ${b.x.toFixed(2)},${b.z.toFixed(2)}`);
await wait(1200);
await p.screenshot({ path: `${out}/controls-turned.png` });
await p.mouse.click(640, 400, { button: 'middle', clickCount: 1 }); await p.mouse.click(640, 400, { button: 'middle', clickCount: 2 });
if (await p.evaluate(() => window.__sm.scene.camYaw) !== 0) errors.push('double wheel click did not reset the camera');
// mouse: left click grabs the box at your feet; right click in the truck places it
let picked = false;
for (let attempt = 0; attempt < 3 && !picked; attempt++) { // an AI mover can grab the same box first: try another
  const box = await p.evaluate((n) => { const s = window.__sm.snap, m = s.players.find(x => x.id === window.__sm.myId); return s.items.filter(i => i.state === 'floor' && i.type === 'standard' && (i.fl || 0) === 0).sort((u, v) => Math.hypot(u.x - m.x, u.z - m.z) - Math.hypot(v.x - m.x, v.z - m.z))[n]; }, attempt);
  if (!box) break;
  await p.evaluate((b) => window.__sm.send('debug_tp', { x: b.x + 0.6, z: b.z }), box);
  await wait(600);
  await p.mouse.click(640, 300);
  picked = await p.waitForFunction(() => window.__sm.snap.players.find(x => x.id === window.__sm.myId).carry, null, { timeout: 3000 }).then(() => true).catch(() => false);
}
if (!picked) errors.push('left click did not pick up');
await p.evaluate(() => window.__sm.send('debug_tp', { x: 10.6, z: 0 }));
await p.waitForFunction(() => window.__sm.snap.players.find(x => x.id === window.__sm.myId).loadMode, null, { timeout: 5000 }).catch(() => errors.push('did not enter the truck'));
await wait(900);
await p.screenshot({ path: `${out}/controls-truck.png` });
// the camera turns in the truck too (wheel drag), up to ~50° so the walls don't hide the load
await p.mouse.move(640, 400); await p.mouse.down({ button: 'middle' }); await p.mouse.move(1000, 400, { steps: 8 }); await p.mouse.up({ button: 'middle' });
const ty = await p.evaluate(() => window.__sm.scene.truckYaw);
if (!(Math.abs(ty) > 0.5 && Math.abs(ty) < Math.PI * 2)) errors.push('wheel drag did not turn the truck camera: ' + ty); // all the way round now
await wait(1200);
await p.screenshot({ path: `${out}/controls-truck-turned.png` });
// with the view turned, D still moves the cursor to the right on screen
const want = await p.evaluate(() => window.__sm.scene.gridStepFor(1, 0));
const cur = async () => p.evaluate(() => ({ ...window.__sm.snap.players.find(x => x.id === window.__sm.myId).cursor }));
await p.evaluate(() => window.__sm.send('aim', { gx: 3, gz: 2 })); await wait(300); // away from the walls
const c0 = await cur();
await p.keyboard.down('KeyD'); // hold until the cursor moves (this software-rendered browser is slow), then compare direction
await p.waitForFunction((c) => { const k = window.__sm.snap.players.find(x => x.id === window.__sm.myId).cursor; return k.gx !== c.gx || k.gz !== c.gz; }, c0, { timeout: 3000 }).catch(() => {});
await p.keyboard.up('KeyD');
const c1 = await cur();
if (Math.sign(c1.gx - c0.gx) !== want.dgx || Math.sign(c1.gz - c0.gz) !== want.dgz) errors.push(`turned truck view: D moved the cursor ${c1.gx - c0.gx},${c1.gz - c0.gz}, expected ${want.dgx},${want.dgz}`);
await p.mouse.click(640, 400, { button: 'right' });
await p.waitForFunction(() => !window.__sm.snap.players.find(x => x.id === window.__sm.myId).carry, null, { timeout: 3000 }).catch(() => errors.push('right click did not place in the truck'));
if (!(await p.innerHTML('#keyhelp')).includes('Right click')) errors.push('mouse not in key help');
// controller: stick moves, Start opens the menu
await p.evaluate(() => { window.__padOn = true; window.dispatchEvent(new Event('gamepadconnected')); });
await wait(200);
if (!(await p.innerHTML('#keyhelp')).includes('Left stick')) errors.push('controller help not shown');
a = await me(); await p.evaluate(() => { window.__pad.axes[1] = 1; }); await wait(600); await p.evaluate(() => { window.__pad.axes[1] = 0; }); b = await me();
if (!(b.z > a.z + 0.5)) errors.push(`stick did not move: ${a.z} → ${b.z}`);
await p.evaluate(() => { window.__pad.buttons[9].pressed = true; }); await wait(150); await p.evaluate(() => { window.__pad.buttons[9].pressed = false; }); await wait(150);
if (!(await p.isVisible('#game-menu'))) errors.push('Start did not open the menu');
await p.click('#gm-keys-reset');
if (await p.evaluate(() => localStorage.getItem('sm_keys')) !== null) errors.push('reset did not clear keys');
await browser.close();
if (errors.length) { console.log('ERRORS:\n' + errors.join('\n')); process.exit(1); }
console.log('house code', code, '→ MOON42 seed', seedA);
console.log('CONTROLS E2E PASS');
