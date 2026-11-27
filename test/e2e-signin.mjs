// Verified sign-in (starts its own server with a fake outbox): node test/e2e-signin.mjs
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
const PORT = 2598, base = `http://localhost:${PORT}`, wait = (ms) => new Promise(r => setTimeout(r, ms)), errors = [], log = (...a) => console.log(...a);
const srv = spawn('node', ['server/index.js'], { env: { ...process.env, PORT: String(PORT), DEBUG_HOOKS: '1', FAKE_MAIL: '1', EMAIL_MX_CHECK: 'off' }, stdio: 'ignore' });
await wait(2500);
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } }), p = await ctx.newPage();
await p.goto(base); await p.waitForFunction(() => window.__sm);
await p.click('#gate-submit'); await wait(200);
log('empty form:', await p.textContent('#gate-err'));
if (!/mover name/.test(await p.textContent('#gate-err'))) errors.push('empty form gives no message');
await p.fill('#gate-name', 'Coder'); await p.click('#gate-submit'); await wait(200);
log('no email:', await p.textContent('#gate-err'));
const email = `qa-code-${Date.now()}@example.com`;
await p.fill('#gate-email', email); await p.click('#gate-submit');
await p.waitForSelector('#gate-code-row:not(.hidden)', { timeout: 5000 }).catch(() => errors.push('no code step'));
log('note:', (await p.textContent('#gate-code-note')).trim());
await p.screenshot({ path: process.argv[2] ? `${process.argv[2]}/si01-code.png` : '/dev/null' }).catch(() => {});
const box = await (await fetch(base + '/debug/outbox')).json();
const code = box.find(m => m.to === email)?.subject.match(/\d{6}/)?.[0];
await p.fill('#gate-code', code === '000000' ? '111111' : '000000'); await p.click('#gate-submit'); await wait(400);
log('wrong code:', await p.textContent('#gate-err'));
if (!/isn’t right/.test(await p.textContent('#gate-err'))) errors.push('wrong code not explained');
await p.fill('#gate-code', code); await p.click('#gate-submit');
await p.waitForSelector('#home:not(.hidden)', { timeout: 5000 }).catch(() => errors.push('right code did not sign in'));
// sign out and back in on this device: no new code
await p.evaluate(() => { localStorage.removeItem('sm_gate'); }); await p.goto(base);
await p.fill('#gate-name', 'Coder'); await p.fill('#gate-email', email); await p.click('#gate-submit');
await p.waitForSelector('#home:not(.hidden)', { timeout: 5000 }).catch(() => errors.push('this device should skip the code'));
const n = (await (await fetch(base + '/debug/outbox')).json()).filter(m => m.to === email).length;
log('codes sent:', n);
if (n !== 1) errors.push('expected one code email, got ' + n);
// another device typing the same email: stuck at the code step
const p2 = await (await browser.newContext()).newPage();
await p2.goto(base); await p2.waitForFunction(() => window.__sm); await p2.fill('#gate-name', 'Eve'); await p2.fill('#gate-email', email); await p2.click('#gate-submit');
await p2.waitForSelector('#gate-code-row:not(.hidden)', { timeout: 15000 }).catch(async () => errors.push('another device: no code step; says ' + await p2.textContent('#gate-err') + ' home ' + await p2.isVisible('#home')));
console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'SIGNIN E2E PASS');
srv.kill(); await browser.close(); process.exit(errors.length ? 1 : 0);
