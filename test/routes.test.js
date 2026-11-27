import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { FileStore } from '../server/store.js';
import { signupRoutes, unsubToken, confirmToken, accountToken, tokenFor, mail } from '../server/signups.js';

const KEY = 'test-admin-key-0123456789'; // admin keys under 16 characters switch the admin pages off

async function serve() {
  process.env.ADMIN_KEY = KEY;
  process.env.EMAIL_MX_CHECK = 'off'; // test addresses use made-up domains
  const store = new FileStore(fs.mkdtempSync(path.join(os.tmpdir(), 'sm-r-')));
  const app = express(); app.set('trust proxy', true);
  signupRoutes(app, express, store);
  const srv = app.listen(0);
  const base = `http://127.0.0.1:${srv.address().port}`;
  const post = (p, body) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': '10.0.0.' + Math.floor(Math.random() * 250) }, body: JSON.stringify(body) });
  /** sign in to the admin pages; returns the session cookie */
  const login = async () => {
    const r = await fetch(base + '/admin/login', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: base }, body: 'key=' + KEY, redirect: 'manual' });
    return r.headers.get('set-cookie')?.split(';')[0];
  };
  return { store, base, post, login, close: () => srv.close() };
}

test('signup: requires valid email, dedupes, records explicit marketing consent', async () => {
  const s = await serve();
  assert.equal((await s.post('/api/signup', { name: 'A', email: 'nope' })).status, 400);
  const r = await (await s.post('/api/signup', { name: 'Ada', email: 'Ada@X.io', marketing: true })).json();
  assert.ok(r.token);
  await s.post('/api/signup', { name: 'Ada', email: 'ada@x.io' });
  const rows = await s.store.listSignups();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].marketing, true);
  s.close();
});

test('unsubscribe link works only with the signed token', async () => {
  const s = await serve();
  await s.post('/api/signup', { name: 'Bo', email: 'bo@x.io', marketing: true });
  assert.equal((await fetch(`${s.base}/unsubscribe?e=bo@x.io&t=forged`)).status, 400);
  const ok = await fetch(`${s.base}/unsubscribe?e=bo@x.io&t=${unsubToken('bo@x.io')}`);
  assert.equal(ok.status, 200);
  assert.match(await ok.text(), /unsubscribed/i);
  assert.equal((await s.store.listSignups())[0].unsubscribed, true);
  const c = await fetch(`${s.base}/confirm?e=bo@x.io&t=${confirmToken('bo@x.io')}`);
  assert.equal(c.status, 200);
  s.close();
});

test('admin: sign in once (no key in the URL afterwards), a signed session cookie; CSV only for admins', async () => {
  const s = await serve();
  await s.post('/api/signup', { name: 'Cy', email: 'cy@x.io', marketing: false });
  assert.equal((await fetch(`${s.base}/api/signups.csv`)).status, 404);
  assert.equal((await fetch(`${s.base}/api/signups.csv?key=${KEY}`)).status, 404, 'a key in the URL is not accepted for data');
  const page = await fetch(`${s.base}/admin`);
  assert.equal(page.status, 200); assert.match(await page.text(), /Admin sign-in/);
  assert.equal(page.headers.get('cache-control'), 'no-store');
  assert.equal((await fetch(`${s.base}/admin?key=wrong`)).status, 401);
  // an old bookmark with ?key= signs you in and redirects to a clean URL
  const old = await fetch(`${s.base}/admin?key=${KEY}`, { redirect: 'manual' });
  assert.equal(old.status, 303); assert.equal(old.headers.get('location'), '/admin');
  assert.match(old.headers.get('set-cookie'), /HttpOnly/); assert.match(old.headers.get('set-cookie'), /SameSite=Strict/);
  const cookie = await s.login();
  const dash = await fetch(`${s.base}/admin`, { headers: { cookie } });
  assert.match(await dash.text(), /Let’s Move It admin/);
  assert.ok(!(await (await fetch(`${s.base}/admin`, { headers: { cookie } })).text()).includes(KEY), 'the key never appears in the page');
  const csv = await (await fetch(`${s.base}/api/signups.csv`, { headers: { cookie } })).text();
  assert.match(csv, /"Cy","cy@x.io","yes"/, 'playing = agreeing to the newsletter');
  assert.equal((await fetch(`${s.base}/api/signups.csv`, { headers: { 'x-admin-key': KEY } })).status, 200, 'scripts can send the key in a header');
  // a forged or expired cookie is refused
  const [n, v] = cookie.split('='), [exp] = v.split('.');
  assert.match(await (await fetch(`${s.base}/admin`, { headers: { cookie: `${n}=${Number(exp) + 99999}.${'0'.repeat(64)}` } })).text(), /Admin sign-in/);
  s.close();
});

test('admin: wrong keys are locked out after 10 tries in 15 minutes, even with the right key', async () => {
  const s = await serve();
  const tryKey = (k) => fetch(`${s.base}/admin/login`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: s.base, 'x-forwarded-for': '10.9.9.9' }, body: 'key=' + k, redirect: 'manual' });
  for (let i = 0; i < 10; i++) assert.equal((await tryKey('guess' + i)).status, 401);
  assert.equal((await tryKey(KEY)).status, 429);
  s.close();
});

test('admin: a login form posted from another site is refused', async () => {
  const s = await serve();
  const r = await fetch(`${s.base}/admin/login`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'https://evil.example', 'x-forwarded-for': '10.8.8.8' }, body: 'key=' + KEY, redirect: 'manual' });
  assert.equal(r.status, 401);
  s.close();
});

test('events: only known names are counted', async () => {
  const s = await serve();
  await s.post('/api/event', { name: 'visit' });
  await s.post('/api/event', { name: 'drop table' });
  const f = await s.store.funnel(1);
  assert.deepEqual(f.map(r => r.name), ['visit']);
  s.close();
});

test('leaderboard never exposes emails', async () => {
  const s = await serve();
  await s.store.addScore({ day: '2026-11-22', email: 'a@x.io', name: 'Ada', score: 90, detail: 'x' });
  const j = await (await fetch(`${s.base}/api/leaderboard?day=2026-11-22`)).json();
  assert.equal(j.rows[0].name, 'Ada');
  assert.ok(!JSON.stringify(j).includes('@'));
  s.close();
});

test('conversion webhook needs the key, records quote/booking and counts it in the funnel', async () => {
  process.env.CONVERSION_KEY = 'conv-key-0123456789abc';
  const s = await serve();
  const hook = (body, key) => fetch(`${s.base}/api/conversion`, { method: 'POST', headers: { 'content-type': 'application/json', ...(key ? { 'x-conversion-key': key } : {}) }, body: JSON.stringify(body) });
  assert.equal((await hook({ type: 'booking', email: 'a@x.io' })).status, 401);
  assert.equal((await hook({ type: 'nonsense' }, 'conv-key-0123456789abc')).status, 400);
  assert.equal((await hook({ type: 'booking', email: 'a@x.io', value: 950 }, 'conv-key-0123456789abc')).status, 200);
  const px = await fetch(`${s.base}/api/px?t=quote&k=conv-key-0123456789abc`);
  assert.equal(px.headers.get('content-type'), 'image/gif');
  const rows = await s.store.listConversions(10);
  assert.deepEqual(rows.map(r => r.type).sort(), ['booking', 'quote']);
  const f = await s.store.funnel(1);
  assert.ok(f.some(r => r.name === 'booking') && f.some(r => r.name === 'quote'));
  delete process.env.CONVERSION_KEY;
  s.close();
});

test('opting in to emails is counted as an opt-in event', async () => {
  const s = await serve();
  await s.post('/api/signup', { name: 'Oo', email: 'oo@x.io', marketing: true });
  await s.post('/api/signup', { name: 'Pp', email: 'pp@x.io', marketing: false });
  const f = await s.store.funnel(1);
  assert.equal(f.find(r => r.name === 'optin')?.n, 2, 'everyone who plays is opted in');
  s.close();
});

test('admin can log a booking by hand (customer mentioned the game)', async () => {
  const s = await serve();
  const cookie = await s.login();
  const forged = await fetch(`${s.base}/admin/conversion`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', cookie, origin: 'https://evil.example' }, body: 'type=booking&value=1', redirect: 'manual' });
  assert.equal(forged.status, 404, 'cross-site form posts are refused');
  const r = await fetch(`${s.base}/admin/conversion`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', cookie, origin: s.base }, body: 'type=booking&name=Phone+Lead&email=&value=800&note=mentioned+game', redirect: 'manual' });
  assert.ok([302, 303].includes(r.status));
  const rows = await s.store.listConversions(5);
  assert.equal(rows[0].value, 800);
  assert.equal(rows[0].source, 'manual');
  s.close();
});

test('sign-up: everyone agrees to the newsletter by playing; throwaway inboxes are refused; settings can opt out', async () => {
  const s = await serve();
  assert.equal((await s.post('/api/signup', { name: 'T', email: 'x@mailinator.com' })).status, 400);
  const j = await (await s.post('/api/signup', { name: 'Kay', email: 'kay@x.io' })).json();
  let [row] = (await s.store.listSignups()).filter(r => r.email === 'kay@x.io');
  assert.equal(row.marketing, true, 'agreed by playing');
  const prefs = (body, h) => fetch(`${s.base}/api/prefs`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-sm-email': 'kay@x.io', ...h }, body: JSON.stringify(body) });
  assert.equal((await prefs({ marketing: false }, { 'x-sm-token': 'nope' })).status, 401);
  const ok = await prefs({ marketing: false }, { 'x-sm-token': j.token });
  assert.equal(ok.status, 200);
  [row] = (await s.store.listSignups()).filter(r => r.email === 'kay@x.io');
  assert.equal(row.marketing, false);
  assert.equal(row.unsubscribed, true);
  s.close();
});

test('accounts: only the first person to sign up with an email can turn its newsletter back on or read the setting', async () => {
  const s = await serve();
  const first = await (await s.post('/api/signup', { name: 'Lu', email: 'lu@x.io' })).json();
  assert.equal(first.account, accountToken('lu@x.io'), 'a new sign-up gets the account token');
  const again = await (await s.post('/api/signup', { name: 'Imposter', email: 'lu@x.io' })).json();
  assert.ok(again.token && !again.account, 'typing someone else\'s email lets you play, nothing more');
  const h = (t, a) => ({ 'content-type': 'application/json', 'x-sm-email': 'lu@x.io', 'x-sm-token': t, ...(a ? { 'x-sm-account': a } : {}) });
  assert.equal((await (await fetch(`${s.base}/api/prefs`, { headers: h(again.token) })).json()).marketing, null, 'their setting stays private');
  assert.equal((await fetch(`${s.base}/api/prefs`, { method: 'POST', headers: h(again.token), body: '{"marketing":true}' })).status, 403, 'no opting someone in (mail is off here; with mail on, a confirm link goes to the inbox)');
  assert.equal((await fetch(`${s.base}/api/prefs`, { method: 'POST', headers: h(first.token, first.account), body: '{"marketing":false}' })).status, 200);
  assert.equal((await fetch(`${s.base}/api/prefs`, { method: 'POST', headers: h(first.token, first.account), body: '{"marketing":true}' })).status, 200, 'the owner can opt back in');
  assert.equal((await (await fetch(`${s.base}/api/prefs`, { headers: h(first.token, first.account) })).json()).marketing, true);
  assert.equal((await fetch(`${s.base}/api/profile?email=lu@x.io&token=${first.token}`)).status, 401, 'credentials are not read from the URL');
  assert.equal((await fetch(`${s.base}/api/profile`, { headers: h(first.token) })).status, 200);
  s.close();
});

test('the booking pixel and webhook never accept the admin key (it would sit on a public page)', async () => {
  delete process.env.CONVERSION_KEY;
  const s = await serve();
  assert.equal((await fetch(`${s.base}/api/conversion`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-conversion-key': KEY }, body: '{"type":"booking"}' })).status, 401);
  await fetch(`${s.base}/api/px?t=booking&k=${KEY}`);
  assert.equal((await s.store.listConversions(5)).length, 0);
  s.close();
});


test('verified sign-in: a code is emailed first; typing someone else\'s email gets you nothing', async () => {
  const s = await serve();
  const sent = []; const real = { ...mail };
  mail.enabled = () => true; mail.send = async (m) => { sent.push(m); return true; };
  try {
    const r = await (await s.post('/api/signup', { name: 'Ada', email: 'ada@v.io' })).json();
    assert.equal(r.verify, true); assert.equal(r.token, undefined, 'no play token before the code');
    assert.equal(sent.length, 1); const code = sent[0].subject.match(/\d{6}/)[0];
    assert.ok(!(await s.store.listSignups()).some(x => x.email === 'ada@v.io'), 'not on the list until verified');
    const bad = await s.post('/api/verify', { email: 'ada@v.io', code: code === '000000' ? '111111' : '000000' });
    assert.equal(bad.status, 400); assert.match((await bad.json()).error, /4 tries left/);
    const ok = await (await s.post('/api/verify', { email: 'ada@v.io', code })).json();
    assert.equal(ok.token, tokenFor('ada@v.io')); assert.equal(ok.account, accountToken('ada@v.io'));
    assert.equal((await s.post('/api/verify', { email: 'ada@v.io', code })).status, 400, 'a code works once');
    // the same device (account token) skips the code next time
    const again = await (await s.post('/api/signup', { name: 'Ada', email: 'ada@v.io', account: ok.account })).json();
    assert.equal(again.token, ok.token); assert.equal(sent.length, 1);
    // someone else typing Ada's email: only a code goes to Ada's inbox
    const evil = await (await s.post('/api/signup', { name: 'Eve', email: 'ada@v.io' })).json();
    assert.equal(evil.verify, true); assert.equal(evil.token, undefined);
  } finally { Object.assign(mail, real); s.close(); }
});

test('verified sign-in: wrong codes run out, and an inbox can\'t be flooded with codes', async () => {
  const s = await serve();
  const sent = []; const real = { ...mail };
  mail.enabled = () => true; mail.send = async (m) => { sent.push(m); return true; };
  try {
    await s.post('/api/signup', { name: 'Bo', email: 'bo@v.io' });
    const code = sent[0].subject.match(/\d{6}/)[0], wrong = code === '123456' ? '654321' : '123456';
    for (let i = 0; i < 5; i++) await s.post('/api/verify', { email: 'bo@v.io', code: wrong });
    const r = await s.post('/api/verify', { email: 'bo@v.io', code });
    assert.equal(r.status, 400, 'after 5 wrong tries even the right code needs a new one');
    for (let i = 0; i < 6; i++) await s.post('/api/signup', { name: 'Bo', email: 'bo@v.io' });
    assert.ok(sent.length <= 5, `${sent.length} code emails to one address in an hour`);
  } finally { Object.assign(mail, real); s.close(); }
});
