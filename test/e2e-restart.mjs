// Server restart (a deploy) mid-game: the player is told why and lands on the menu with a plain message.
// Starts its own server: node test/e2e-restart.mjs
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
const PORT = 2599, base = `http://localhost:${PORT}`, wait = (ms) => new Promise(r => setTimeout(r, ms)), errors = [];
const srv = spawn('node', ['server/index.js'], { env: { ...process.env, PORT: String(PORT), DEBUG_HOOKS: '1' }, stdio: 'ignore' });
await wait(2500);
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const p = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
await p.goto(base); await p.fill('#gate-name', 'Restart'); await p.fill('#gate-email', `qa-rs-${Date.now()}@example.com`); await p.click('#gate-submit');
await p.waitForSelector('#home:not(.hidden)');
await p.click('#btn-solo'); await p.waitForFunction(() => window.__sm.snap?.players?.length >= 2);
await p.click('#btn-start'); await p.waitForFunction(() => window.__sm.snap?.phase === 'playing', null, { timeout: 8000 });
srv.kill('SIGTERM');
await p.waitForSelector('#netbox:not(.hidden)', { timeout: 3000 }).then(async () => console.log('banner:', (await p.textContent('#netbox-text')).trim())).catch(() => errors.push('no updating banner'));
await p.waitForSelector('#home:not(.hidden)', { timeout: 8000 }).catch(() => errors.push('did not return to the menu'));
const msg = (await p.textContent('#home-err')).trim();
console.log('menu says:', msg);
if (!/updated/.test(msg)) errors.push('menu should say the game updated');
// joining while the server is down: plain words, no MatchMakeError
await p.click('#btn-solo'); await wait(2500);
const err2 = (await p.textContent('#home-err')).trim();
console.log('while down:', err2);
if (/MatchMake|Error/.test(err2) || !err2) errors.push('raw/empty error while the server is down');
console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'RESTART E2E PASS');
await browser.close(); process.exit(errors.length ? 1 : 0);
