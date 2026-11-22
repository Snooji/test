// Email gate + everything that touches the signup list: consent, confirm/unsubscribe links,
// funnel events, client error reports, the admin dashboard and the daily leaderboard API.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
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

const EVENTS = new Set(['visit', 'gate_view', 'home_view', 'solo_click', 'create_click', 'join_click', 'quickplay_click', 'tutorial_start', 'tutorial_done', 'share_click', 'install', 'feedback_up', 'feedback_down']);
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
    const marketing = req.body?.marketing === true;
    if (!name) return res.status(400).json({ error: 'Please enter your mover name.' });
    if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Please enter a valid email.' });
    if (limited('signup', req.ip, 30)) return res.status(429).json({ error: 'Too many signups, try later.' });
    try {
      const { isNew } = await store.upsertSignup({ name, email, marketing });
      store.event(isNew ? 'signup' : 'signin').catch(() => {});
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
    res.send(page('Confirmed', `<h1>✅ You're confirmed!</h1><p>We'll send Starside Movers news to <b>${esc(email)}</b>.</p><p><a class="btn" href="/">Play now</a></p>`));
  });

  const unsub = async (req, res) => {
    const email = cleanEmail(req.query.e);
    if (!same(unsubToken(email), req.query.t || '')) return res.status(400).send(page('Link expired', '<h1>That link doesn’t look right</h1><p>Use the unsubscribe link from one of our emails.</p>'));
    await store.unsubscribe(email);
    store.event('unsubscribe').catch(() => {});
    res.send(page('Unsubscribed', `<h1>You're unsubscribed</h1><p><b>${esc(email)}</b> won't get any more Starside Movers emails. You can still play any time.</p><p><a class="btn" href="/">Back to the game</a></p>`));
  };
  app.get('/unsubscribe', unsub);
  app.post('/unsubscribe', unsub); // one-click unsubscribe from mail apps

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

  app.get('/admin', async (req, res) => {
    if (!admin(req)) return res.status(404).send(page('Not found', '<h1>Not found</h1>'));
    const [signups, funnel, errors] = await Promise.all([store.listSignups(), store.funnel(14), store.recentErrors(20)]);
    const marketing = signups.filter(s => s.marketing && !s.unsubscribed).length;
    const days = [...new Set(funnel.map(f => f.day))].sort().reverse();
    const cols = ['visit', 'gate_view', 'signup', 'signin', 'solo_click', 'quickplay_click', 'round_start', 'round_end', 'tutorial_done', 'share_click', 'feedback_up', 'feedback_down'];
    const n = (day, name) => funnel.find(f => f.day === day && f.name === name)?.n || 0;
    const k = encodeURIComponent(req.query.key);
    res.send(page('Starside admin', `<h1>★ Starside Movers admin</h1>
      <p><b>${signups.length}</b> sign-ups · <b>${marketing}</b> OK to email · <b>${signups.filter(s => s.confirmed).length}</b> confirmed · <b>${signups.filter(s => s.unsubscribed).length}</b> unsubscribed</p>
      <p><a class="btn" href="/api/signups.csv?key=${k}">Download sign-ups (CSV)</a> · email confirmations: ${mailerEnabled() ? 'on' : 'off (set RESEND_API_KEY + MAIL_FROM)'} · storage: ${process.env.DATABASE_URL ? 'Postgres' : 'disk file'}</p>
      <h2>Funnel, last 14 days</h2><div style="overflow-x:auto"><table><tr><th>Day</th>${cols.map(c => `<th class="n">${c.replace('_', ' ')}</th>`).join('')}</tr>
      ${days.map(d => `<tr><td>${d}</td>${cols.map(c => `<td class="n">${n(d, c)}</td>`).join('')}</tr>`).join('') || '<tr><td colspan="9">No traffic yet</td></tr>'}</table></div>
      <h2>Recent errors</h2><table><tr><th>When</th><th>Where</th><th>Message</th></tr>
      ${errors.map(e => `<tr><td>${esc(e.at).slice(0, 19)}</td><td>${esc(e.where)}</td><td>${esc(e.message)}</td></tr>`).join('') || '<tr><td colspan="3">None 🎉</td></tr>'}</table>`));
  });
}
