// Web security: headers, rate limits, real client IPs, debug hooks off in production, the start-up config check, and the
// game room's message-flood guard and join limit.
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { securityHeaders, rateLimit, limiter, clientIp, debugHooksOn, checkEnv, isProd } from '../server/security.js';
import { MoveRoom } from '../server/MoveRoom.js';

const withEnv = (vars, fn) => {
  const old = {}; for (const k of Object.keys(vars)) { old[k] = process.env[k]; if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k]; }
  try { return fn(); } finally { for (const k of Object.keys(vars)) { if (old[k] === undefined) delete process.env[k]; else process.env[k] = old[k]; } }
};

async function serve(setup) {
  const app = express(); app.set('trust proxy', true); app.disable('x-powered-by');
  setup(app);
  const srv = app.listen(0);
  return { base: `http://127.0.0.1:${srv.address().port}`, close: () => srv.close() };
}

test('every response carries the security headers: CSP, no sniffing, no framing, referrer and permissions policies', async () => {
  const s = await serve(app => { app.use(securityHeaders); app.get('/', (_q, r) => r.send('ok')); });
  const r = await fetch(s.base + '/');
  const csp = r.headers.get('content-security-policy');
  for (const part of ["default-src 'self'", "script-src 'self'", "object-src 'none'", "frame-ancestors 'none'", "base-uri 'self'", 'https://fonts.gstatic.com']) assert.ok(csp.includes(part), `CSP has ${part}`);
  assert.ok(!/script-src[^;]*'unsafe-(inline|eval)'/.test(csp), 'no inline scripts or JavaScript eval (WebAssembly only)');
  assert.match(csp, /connect-src 'self' blob: data: wss:\/\/127\.0\.0\.1:\d+/, 'the game socket on the same host');
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(r.headers.get('x-frame-options'), 'DENY');
  assert.equal(r.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
  assert.match(r.headers.get('permissions-policy'), /camera=\(\)/);
  assert.equal(r.headers.get('x-powered-by'), null);
  s.close();
});

test('rate limit: past the limit a visitor gets 429 with Retry-After; other visitors are unaffected', async () => {
  const s = await serve(app => { app.use('/api', rateLimit(5, 60_000)); app.get('/api/x', (_q, r) => r.json({ ok: 1 })); });
  const get = (ip) => fetch(s.base + '/api/x', { headers: { 'x-forwarded-for': ip } });
  for (let i = 0; i < 5; i++) assert.equal((await get('10.1.1.1')).status, 200);
  const blocked = await get('10.1.1.1');
  assert.equal(blocked.status, 429); assert.ok(Number(blocked.headers.get('retry-after')) > 0);
  assert.equal((await get('10.1.1.2')).status, 200);
  s.close();
});

test('limiter: a sliding window per key, and forgotten keys are swept so memory stays flat', async () => {
  const l = limiter(2, 50);
  assert.ok(l.hit('a') && l.hit('a') && !l.hit('a'));
  await new Promise(r => setTimeout(r, 60));
  assert.ok(l.hit('a'), 'window slid');
  for (let i = 0; i < 1000; i++) l.hit('ip' + i);
  assert.ok(l.size() > 1000);
  await new Promise(r => setTimeout(r, 10_100)); // the sweep runs at most every 10 s
  assert.ok(l.size() < 10, `swept: ${l.size()} keys left`);
});

test('client IP: in production the Cloudflare header (clients can\'t forge it), never the first X-Forwarded-For entry', () => {
  const req = { headers: { 'cf-connecting-ip': '203.0.113.7', 'x-forwarded-for': '6.6.6.6, 203.0.113.7' }, ip: '6.6.6.6', socket: {} };
  withEnv({ RENDER: 'true' }, () => assert.equal(clientIp(req), '203.0.113.7'));
  withEnv({ RENDER: undefined, NODE_ENV: 'test' }, () => assert.equal(clientIp(req), '6.6.6.6', 'local dev: no Cloudflare in front'));
});

test('debug hooks (test-only cheats) can never be switched on in production', () => {
  withEnv({ DEBUG_HOOKS: '1', RENDER: undefined, NODE_ENV: 'test' }, () => assert.equal(debugHooksOn(), true));
  withEnv({ DEBUG_HOOKS: '1', RENDER: 'true' }, () => { assert.equal(isProd(), true); assert.equal(debugHooksOn(), false); });
  withEnv({ DEBUG_HOOKS: '1', RENDER: undefined, NODE_ENV: 'production' }, () => assert.equal(debugHooksOn(), false));
  withEnv({ DEBUG_HOOKS: '1', RENDER: 'true' }, () => {
    const room = new MoveRoom(), handlers = {};
    room.onMessage = (t, fn) => { handlers[t] = fn; }; room.setSimulationInterval = () => {}; room.broadcast = () => {}; room.clients = [];
    room.onCreate({});
    assert.ok(!Object.keys(handlers).some(k => k.startsWith('debug_')), 'no debug messages registered');
  });
});

test('config check: flags weak or missing secrets and debug flags, without printing any values', () => {
  const lines = [];
  const warn = withEnv({ RENDER: 'true', GATE_SECRET: 'short', ADMIN_KEY: 'abc', CONVERSION_KEY: 'x', DEBUG_HOOKS: '1', PUBLIC_URL: 'http://x.io' }, () => checkEnv({ warn: (m) => lines.push(m) }));
  assert.ok(warn.some(w => /GATE_SECRET is short/.test(w)));
  assert.ok(warn.some(w => /ADMIN_KEY is under 16/.test(w)));
  assert.ok(warn.some(w => /CONVERSION_KEY is under 16/.test(w)));
  assert.ok(warn.some(w => /DEBUG_HOOKS=1 is ignored/.test(w)));
  assert.ok(warn.some(w => /https/.test(w)));
  assert.ok(!lines.join().includes('abc') && !lines.join().includes('short '), 'no secret values in the log');
  const none = withEnv({ RENDER: 'true', GATE_SECRET: 'x'.repeat(40), ADMIN_KEY: 'y'.repeat(24), CONVERSION_KEY: 'z'.repeat(24), DEBUG_HOOKS: undefined, PUBLIC_URL: 'https://a.io' }, () => checkEnv({ warn: () => {} }));
  assert.deepEqual(none, []);
});

test('game room: a client flooding messages has them dropped, and is disconnected if it keeps going', () => {
  const room = new MoveRoom(), handlers = {};
  room.onMessage = (t, fn) => { handlers[t] = fn; }; room.setSimulationInterval = () => {}; room.broadcast = () => {}; room.clients = [];
  room.onCreate({});
  let kicked = false;
  const c = { sessionId: 'A', send: () => {}, leave: () => { kicked = true; } };
  room.clients.push(c); room.onJoin(c, {}, { name: 'Ada', email: 'a@x.io' });
  let got = 0; const real = room.say.bind(room); room.say = (...a) => { got++; return real(...a); };
  for (let i = 0; i < 1000; i++) handlers.chat(c, { text: 'spam' + i });
  assert.ok(got <= 201, `${got} of 1000 instant messages got through`);
  assert.ok(kicked, 'a client hammering far past the budget is disconnected');
});

test('game room: joins are limited per visitor', () => {
  const room = new MoveRoom();
  const ctx = { ip: '198.51.100.9', headers: {} };
  let refused = 0;
  for (let i = 0; i < 45; i++) { try { room.onAuth({}, { email: 'x', token: 'y' }, ctx); } catch (e) { if (e.code === 429) refused++; } }
  assert.equal(refused, 5, 'the 41st join in a minute and after are refused');
});
