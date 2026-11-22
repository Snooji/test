import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { FileStore } from '../server/store.js';
import { signupRoutes, unsubToken, confirmToken } from '../server/signups.js';

async function serve() {
  process.env.ADMIN_KEY = 'k3y';
  process.env.EMAIL_MX_CHECK = 'off'; // test addresses use made-up domains
  const store = new FileStore(fs.mkdtempSync(path.join(os.tmpdir(), 'sm-r-')));
  const app = express(); app.set('trust proxy', true);
  signupRoutes(app, express, store);
  const srv = app.listen(0);
  const base = `http://127.0.0.1:${srv.address().port}`;
  const post = (p, body) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': '10.0.0.' + Math.floor(Math.random() * 250) }, body: JSON.stringify(body) });
  return { store, base, post, close: () => srv.close() };
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

test('CSV + admin need the admin key; CSV shows who is OK to email', async () => {
  const s = await serve();
  await s.post('/api/signup', { name: 'Cy', email: 'cy@x.io', marketing: false });
  assert.equal((await fetch(`${s.base}/api/signups.csv`)).status, 404);
  assert.equal((await fetch(`${s.base}/admin?key=wrong`)).status, 404);
  const csv = await (await fetch(`${s.base}/api/signups.csv?key=k3y`)).text();
  assert.match(csv, /"Cy","cy@x.io","yes"/, 'playing = agreeing to the newsletter');
  assert.equal((await fetch(`${s.base}/admin?key=k3y`)).status, 200);
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
  process.env.CONVERSION_KEY = 'conv';
  const s = await serve();
  const hook = (body, key) => fetch(`${s.base}/api/conversion`, { method: 'POST', headers: { 'content-type': 'application/json', ...(key ? { 'x-conversion-key': key } : {}) }, body: JSON.stringify(body) });
  assert.equal((await hook({ type: 'booking', email: 'a@x.io' })).status, 401);
  assert.equal((await hook({ type: 'nonsense' }, 'conv')).status, 400);
  assert.equal((await hook({ type: 'booking', email: 'a@x.io', value: 950 }, 'conv')).status, 200);
  const px = await fetch(`${s.base}/api/px?t=quote&k=conv`);
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
  const r = await fetch(`${s.base}/admin/conversion?key=k3y`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'type=booking&name=Phone+Lead&email=&value=800&note=mentioned+game', redirect: 'manual' });
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
  const bad = await fetch(`${s.base}/api/prefs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'kay@x.io', token: 'nope', marketing: false }) });
  assert.equal(bad.status, 401);
  const ok = await fetch(`${s.base}/api/prefs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'kay@x.io', token: j.token, marketing: false }) });
  assert.equal(ok.status, 200);
  [row] = (await s.store.listSignups()).filter(r => r.email === 'kay@x.io');
  assert.equal(row.marketing, false);
  assert.equal(row.unsubscribed, true);
  s.close();
});
