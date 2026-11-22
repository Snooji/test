// Email gate + everything that touches the signup list: consent, confirm/unsubscribe links,
// funnel events, client error reports, the admin dashboard and the daily leaderboard API.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import { sendMail, confirmEmail, mailerEnabled } from './mailer.js';

const DATA_DIR = process.env.DATA_DIR || path.resolve('data');
fs.mkdirSync(DATA_DIR, { recursive: true });

function loadSecret() {
  if (process.env.GATE_SECRET) return process.env.GATE_SECRET;
  const f = path.join(DATA_DIR, 'secret');
  if (fs.existsSync(f)) return fs.readFileSync(f, 'utf8').trim();
  const s = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(f, s);
  return s;
}
const SECRET = loadSecret();

export const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,24}$/;

// throwaway inbox services: not real customers
const DISPOSABLE = new Set(['mailinator.com', 'guerrillamail.com', 'guerrillamail.net', '10minutemail.com', 'tempmail.com', 'temp-mail.org', 'yopmail.com', 'trashmail.com', 'getnada.com', 'sharklasers.com', 'dispostable.com', 'throwawaymail.com', 'maildrop.cc', 'fakeinbox.com', 'mintemail.com', 'mohmal.com', 'emailondeck.com', 'tempail.com', 'burnermail.io', 'spamgourmet.com']);
const mxCache = new Map();
const withTimeout = (p) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error('timeout'), { code: 'ETIMEOUT' })), 3000))]);
// safety: if this server can't even resolve gmail.com's mail servers, DNS is broken here, so never block anyone
let dnsWorks = null;
const dnsHealthy = () => (dnsWorks ??= withTimeout(dns.resolveMx('gmail.com')).then(r => r.length > 0, () => false).then(ok => {
  if (!ok) console.warn('⚠️ DNS lookups are failing on this server: the "can this email receive mail" check is switched off.');
  return ok;
}));
/** can this domain receive email? MX records, or an A record (RFC 5321 fallback). On unless EMAIL_MX_CHECK=off. Fails open. */
async function domainTakesMail(domain) {
  if (process.env.EMAIL_MX_CHECK === 'off') return true;
  if (mxCache.has(domain)) return mxCache.get(domain);
  if (!(await dnsHealthy())) return true;
  const gone = (err) => ['ENOTFOUND', 'ENODATA', 'ENOTIMP'].includes(err?.code);
  let ok = true;
  try {
    const mx = await withTimeout(dns.resolveMx(domain));
    ok = mx.some(r => r.exchange && r.exchange !== '.');
  } catch (err) {
    if (gone(err)) {
      try { ok = (await withTimeout(dns.resolve4(domain))).length > 0; } catch (e2) { ok = !gone(e2); }
    }
  }
  mxCache.set(domain, ok);
  return ok;
}
export const cleanName = (n) => String(n || '').replace(/[<>]/g, '').trim().slice(0, 16);
export const cleanEmail = (e) => String(e || '').trim().toLowerCase().slice(0, 254);

const sign = (purpose, email) => crypto.createHmac('sha256', SECRET).update(purpose + ':' + cleanEmail(email)).digest('hex').slice(0, 32);
const same = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };

export function tokenFor(email) {
  return crypto.createHmac('sha256', SECRET).update(cleanEmail(email)).digest('hex').slice(0, 32);
}
export function verifyToken(email, token) { return !!email && !!token && same(tokenFor(email), token); }
export const unsubToken = (email) => sign('unsub', email);
export const confirmToken = (email) => sign('confirm', email);

const buckets = new Map(); // `${kind}:${ip}` → timestamps
function limited(kind, ip, max, windowMs = 3600_000) {
  const k = kind + ':' + ip, t = Date.now();
  const arr = (buckets.get(k) || []).filter(x => t - x < windowMs);
  arr.push(t); buckets.set(k, arr);
  return arr.length > max;
}

const EVENTS = new Set(['visit', 'gate_view', 'home_view', 'solo_click', 'create_click', 'join_click', 'quickplay_click', 'tutorial_start', 'tutorial_done', 'share_click', 'install', 'feedback_up', 'feedback_down', 'book_click_home', 'book_click_results', 'book_click_gate']);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const baseUrl = (req) => process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`;
const page = (title, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>body{margin:0;font-family:system-ui,sans-serif;background:#0b0820;color:#f4f1ff;display:grid;place-items:center;min-height:100vh;padding:16px;box-sizing:border-box}
.c{max-width:640px;background:#1a1440;border:2px solid #3a3170;border-radius:20px;padding:24px}a{color:#55ffcc}h1{margin-top:0}
table{border-collapse:collapse;width:100%;font-size:14px}td,th{border-bottom:1px solid #3a3170;padding:6px;text-align:left}.n{text-align:right;font-variant-numeric:tabular-nums}
.btn{display:inline-block;background:#6b4dff;color:#fff;padding:10px 16px;border-radius:12px;text-decoration:none;font-weight:700}</style></head><body><div class="c">${body}</div></body></html>`;

export function signupRoutes(app, express, store) {
  const json = express.json({ limit: '4kb' });

  app.post('/api/signup', json, async (req, res) => {
    const name = cleanName(req.body?.name);
    const email = cleanEmail(req.body?.email);
    const marketing = true; // agreeing to Starside Movers newsletters is part of playing; opt out any time
    if (!name) return res.status(400).json({ error: 'Please enter your mover name.' });
    if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Please enter a valid email.' });
    const domain = email.split('@')[1];
    if (DISPOSABLE.has(domain)) return res.status(400).json({ error: 'Please use your real email, not a throwaway inbox.' });
    if (!(await domainTakesMail(domain))) return res.status(400).json({ error: 'That email address can’t receive mail. Check for typos.' });
    if (limited('signup', req.ip, 30)) return res.status(429).json({ error: 'Too many signups, try later.' });
    try {
      const { isNew } = await store.upsertSignup({ name, email, marketing });
      store.event(isNew ? 'signup' : 'signin').catch(() => {});
      if (isNew && marketing) store.event('optin').catch(() => {});
      if (isNew && marketing && mailerEnabled()) {
        const b = baseUrl(req);
        const mail = confirmEmail({
          name, playUrl: b,
          confirmUrl: `${b}/confirm?e=${encodeURIComponent(email)}&t=${confirmToken(email)}`,
          unsubscribeUrl: `${b}/unsubscribe?e=${encodeURIComponent(email)}&t=${unsubToken(email)}`,
        });
        sendMail({ to: email, ...mail, unsubscribeUrl: `${b}/unsubscribe?e=${encodeURIComponent(email)}&t=${unsubToken(email)}` })
          .catch(err => store.logError({ where: 'mail', message: err.message, stack: '', ua: '' }));
      }
      res.json({ token: tokenFor(email), name, email });
    } catch (err) {
      store.logError({ where: 'signup', message: err.message, stack: err.stack, ua: req.get('user-agent') }).catch(() => {});
      res.status(500).json({ error: 'Could not save your sign-up. Please try again.' });
    }
  });

  app.get('/confirm', async (req, res) => {
    const email = cleanEmail(req.query.e);
    if (!same(confirmToken(email), req.query.t || '')) return res.status(400).send(page('Link expired', '<h1>That link doesn’t look right</h1><p>Try the newest email from us.</p>'));
    await store.confirm(email);
    res.send(page('Confirmed', `<h1>✅ You're confirmed!</h1><p>We'll send Let’s Move It and Starside Movers news to <b>${esc(email)}</b>.</p><p><a class="btn" href="/">Play now</a></p>`));
  });

  const unsub = async (req, res) => {
    const email = cleanEmail(req.query.e);
    if (!same(unsubToken(email), req.query.t || '')) return res.status(400).send(page('Link expired', '<h1>That link doesn’t look right</h1><p>Use the unsubscribe link from one of our emails.</p>'));
    await store.unsubscribe(email);
    store.event('unsubscribe').catch(() => {});
    res.send(page('Unsubscribed', `<h1>You're unsubscribed</h1><p><b>${esc(email)}</b> won't get any more Let’s Move It emails. You can still play any time.</p><p><a class="btn" href="/">Back to the game</a></p>`));
  };
  app.get('/unsubscribe', unsub);
  app.post('/unsubscribe', unsub); // one-click unsubscribe from mail apps

  // settings: newsletter on/off for a signed-in player
  app.post('/api/prefs', json, async (req, res) => {
    const email = cleanEmail(req.body?.email);
    if (!verifyToken(email, req.body?.token)) return res.status(401).json({ error: 'sign in first' });
    const on = req.body?.marketing === true;
    await store.setMarketing(email, on);
    store.event(on ? 'optin' : 'unsubscribe').catch(() => {});
    res.json({ ok: true, marketing: on });
  });
  app.get('/api/prefs', async (req, res) => {
    const email = cleanEmail(req.query.email);
    if (!verifyToken(email, req.query.token)) return res.status(401).json({ error: 'sign in first' });
    const row = (await store.listSignups()).find(r => r.email === email);
    res.json({ marketing: !!(row?.marketing && !row?.unsubscribed) });
  });

  app.post('/api/event', json, (req, res) => {
    const name = String(req.body?.name || '');
    if (EVENTS.has(name) && !limited('event', req.ip, 300)) store.event(name).catch(() => {});
    res.status(204).end();
  });

  app.post('/api/error', json, (req, res) => {
    if (!limited('error', req.ip, 30)) store.logError({ where: 'client', message: String(req.body?.message || '').slice(0, 500), stack: String(req.body?.stack || '').slice(0, 2000), ua: req.get('user-agent') }).catch(() => {});
    res.status(204).end();
  });

  app.get('/api/leaderboard', async (req, res) => {
    const day = /^\d{4}-\d{2}-\d{2}$/.test(req.query.day || '') ? req.query.day : new Date().toISOString().slice(0, 10);
    const rows = await store.topScores(day, 20);
    res.json({ day, rows: rows.map(r => ({ name: r.name, score: r.score, detail: r.detail })) }); // never expose emails
  });

  app.get('/api/profile', async (req, res) => {
    const email = cleanEmail(req.query.email);
    if (!verifyToken(email, req.query.token)) return res.status(401).json({ error: 'sign in first' });
    const p = await store.getProfile(email);
    res.json({ games: p.games, wins: p.wins, loaded: p.loaded });
  });

  // ---- business conversions: quote requests + confirmed bookings from the booking site ----
  const convKey = () => process.env.CONVERSION_KEY || process.env.ADMIN_KEY;
  const TYPES = new Set(['quote', 'booking']);
  app.post('/api/conversion', json, async (req, res) => {
    const key = req.get('x-conversion-key') || req.query.key;
    if (!convKey() || !same(convKey(), String(key || ''))) return res.status(401).json({ error: 'bad key' });
    const type = String(req.body?.type || '');
    if (!TYPES.has(type)) return res.status(400).json({ error: 'type must be quote or booking' });
    await store.addConversion({ type, email: cleanEmail(req.body?.email), name: cleanName(req.body?.name), value: Math.max(0, Math.round(Number(req.body?.value) || 0)), source: 'webhook', note: String(req.body?.note || '').slice(0, 200) });
    res.json({ ok: true });
  });
  const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
  app.get('/api/px', async (req, res) => { // <img src=".../api/px?t=booking&k=KEY&e=EMAIL&v=VALUE"> on a thank-you page
    if (convKey() && same(convKey(), String(req.query.k || '')) && TYPES.has(req.query.t) && !limited('px', req.ip, 60)) {
      await store.addConversion({ type: req.query.t, email: cleanEmail(req.query.e), name: '', value: Math.max(0, Math.round(Number(req.query.v) || 0)), source: 'pixel', note: '' }).catch(() => {});
    }
    res.set('Cache-Control', 'no-store').type('image/gif').send(GIF);
  });

  // ---- admin (only when ADMIN_KEY is set) ----
  const admin = (req) => !!process.env.ADMIN_KEY && same(process.env.ADMIN_KEY, String(req.query.key || ''));

  app.get('/api/signups.csv', async (req, res) => {
    if (!admin(req)) return res.status(404).end();
    const rows = await store.listSignups();
    const q = (s) => `"${String(s ?? '').replace(/"/g, '""')}"`;
    res.type('text/csv').attachment('starside-signups.csv').send([
      'name,email,marketing_ok,confirmed,unsubscribed,signed_up_at,last_seen',
      ...rows.map(r => [r.name, r.email, r.marketing && !r.unsubscribed ? 'yes' : 'no', r.confirmed === null ? 'n/a' : r.confirmed ? 'yes' : 'no', r.unsubscribed ? 'yes' : 'no', r.created_at, r.last_seen].map(q).join(',')),
    ].join('\n'));
  });

  app.post('/admin/conversion', express.urlencoded({ extended: false, limit: '4kb' }), async (req, res) => {
    if (!admin(req)) return res.status(404).end();
    const type = TYPES.has(req.body?.type) ? req.body.type : 'booking';
    await store.addConversion({ type, email: cleanEmail(req.body?.email), name: cleanName(req.body?.name) || 'Manual entry', value: Math.max(0, Math.round(Number(req.body?.value) || 0)), source: 'manual', note: String(req.body?.note || '').slice(0, 200) });
    res.redirect(303, `/admin?key=${encodeURIComponent(req.query.key)}#conversions`);
  });

  app.get('/admin', async (req, res) => {
    if (!admin(req)) return res.status(404).send(page('Not found', '<h1>Not found</h1>'));
    const [signups, funnel, errors, conversions] = await Promise.all([store.listSignups(), store.funnel(30), store.recentErrors(20), store.listConversions(50)]);
    const total = (name) => funnel.filter(f => f.name === name).reduce((a, f) => a + f.n, 0);
    const steps = [['Visits', 'visit'], ['Sign-ups', 'signup'], ['Email opt-ins', 'optin'], ['Game starts', 'round_start'], ['Completed rounds', 'round_end'], ['Book-a-move clicks', ['book_click_home', 'book_click_results', 'book_click_gate']], ['Quote requests', 'quote'], ['Confirmed bookings', 'booking']]
      .map(([label, names]) => ({ label, n: [].concat(names).reduce((a, nm) => a + total(nm), 0) }));
    const revenue = conversions.filter(c => c.type === 'booking').reduce((a, c) => a + (c.value || 0), 0);
    const pct = (a, b) => (b ? Math.round((100 * a) / b) + '%' : '–');
    const marketing = signups.filter(s => s.marketing && !s.unsubscribed).length;
    const days = [...new Set(funnel.map(f => f.day))].sort().reverse();
    const cols = ['visit', 'signup', 'optin', 'round_start', 'round_end', 'book_click_home', 'book_click_results', 'quote', 'booking', 'tutorial_done', 'quickplay_click', 'share_click', 'feedback_up', 'feedback_down'];
    const n = (day, name) => funnel.find(f => f.day === day && f.name === name)?.n || 0;
    const k = encodeURIComponent(req.query.key);
    res.send(page('Let’s Move It admin', `<h1>Let’s Move It admin</h1>
      <p><b>${signups.length}</b> sign-ups · <b>${marketing}</b> OK to email · <b>${signups.filter(s => s.confirmed).length}</b> confirmed · <b>${signups.filter(s => s.unsubscribed).length}</b> unsubscribed</p>
      <p><a class="btn" href="/api/signups.csv?key=${k}">Download sign-ups (CSV)</a> · email confirmations: ${mailerEnabled() ? 'on' : 'off (set RESEND_API_KEY + MAIL_FROM)'} · storage: ${process.env.DATABASE_URL ? 'Postgres' : 'disk file'}</p>
      <h2>Is the game bringing in business? (last 30 days)</h2>
      <table><tr><th>Step</th><th class="n">Count</th><th class="n">From previous step</th></tr>
      ${steps.map((st, i) => `<tr><td>${st.label}</td><td class="n">${st.n}</td><td class="n">${i ? pct(st.n, steps[i - 1].n) : ''}</td></tr>`).join('')}
      <tr><td><b>Booking value logged</b></td><td class="n"><b>$${revenue.toLocaleString()}</b></td><td></td></tr></table>
      <h2 id="conversions">Quote requests &amp; bookings</h2>
      <form method="post" action="/admin/conversion?key=${k}" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:6px;margin-bottom:10px">
        <select name="type"><option value="booking">Booking</option><option value="quote">Quote request</option></select>
        <input name="name" placeholder="Customer name"><input name="email" placeholder="Email (optional)"><input name="value" placeholder="$ value" inputmode="numeric">
        <input name="note" placeholder="Note (e.g. mentioned the game)"><button class="btn" type="submit">Log it</button>
      </form>
      <table><tr><th>When</th><th>Type</th><th>Customer</th><th class="n">Value</th><th>Source</th><th>Played the game?</th></tr>
      ${conversions.map(c => `<tr><td>${esc(c.at).slice(0, 16)}</td><td>${esc(c.type)}</td><td>${esc(c.name || c.email)}</td><td class="n">${c.value ? '$' + c.value : ''}</td><td>${esc(c.source)}</td><td>${c.player ? 'yes' : '–'}</td></tr>`).join('') || '<tr><td colspan="6">None yet</td></tr>'}</table>
      <p style="font-size:13px">Automate it: POST <code>/api/conversion</code> with header <code>x-conversion-key</code> and JSON <code>{"type":"booking","email":"…","value":950}</code>, or put <code>&lt;img src="/api/px?t=booking&amp;k=KEY&amp;e=EMAIL&amp;v=VALUE"&gt;</code> on the booking confirmation page.</p>
      <h2>Daily funnel</h2><div style="overflow-x:auto"><table><tr><th>Day</th>${cols.map(c => `<th class="n">${c.replace('_', ' ')}</th>`).join('')}</tr>
      ${days.map(d => `<tr><td>${d}</td>${cols.map(c => `<td class="n">${n(d, c)}</td>`).join('')}</tr>`).join('') || '<tr><td colspan="9">No traffic yet</td></tr>'}</table></div>
      <h2>Recent errors</h2><table><tr><th>When</th><th>Where</th><th>Message</th></tr>
      ${errors.map(e => `<tr><td>${esc(e.at).slice(0, 19)}</td><td>${esc(e.where)}</td><td>${esc(e.message)}</td></tr>`).join('') || '<tr><td colspan="3">None 🎉</td></tr>'}</table>`));
  });
}
