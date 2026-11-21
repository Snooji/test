// Email gate: store name + email, hand back an HMAC token the game room verifies.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const DATA_DIR = process.env.DATA_DIR || path.resolve('data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const FILE = path.join(DATA_DIR, 'signups.jsonl');

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

export function tokenFor(email) {
  return crypto.createHmac('sha256', SECRET).update(cleanEmail(email)).digest('hex').slice(0, 32);
}

export function verifyToken(email, token) {
  if (!email || !token) return false;
  const a = Buffer.from(tokenFor(email));
  const b = Buffer.from(String(token));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const hits = new Map(); // ip → [timestamps]
function rateLimited(ip) {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter(t => now - t < 3600_000);
  arr.push(now);
  hits.set(ip, arr);
  return arr.length > 30;
}

export function signupRoutes(app, express) {
  app.post('/api/signup', express.json({ limit: '2kb' }), (req, res) => {
    const name = cleanName(req.body?.name);
    const email = cleanEmail(req.body?.email);
    if (!name) return res.status(400).json({ error: 'Please enter your mover name.' });
    if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Please enter a valid email.' });
    if (rateLimited(req.ip)) return res.status(429).json({ error: 'Too many signups, try later.' });
    fs.appendFileSync(FILE, JSON.stringify({ name, email, ts: new Date().toISOString() }) + '\n');
    res.json({ token: tokenFor(email), name, email });
  });

  // CSV export, only when ADMIN_KEY is configured.
  app.get('/api/signups.csv', (req, res) => {
    const key = process.env.ADMIN_KEY;
    if (!key || req.query.key !== key) return res.status(404).end();
    const rows = fs.existsSync(FILE) ? fs.readFileSync(FILE, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
    const esc = (s) => `"${String(s).replace(/"/g, '""')}"`;
    res.type('text/csv').send(['name,email,signed_up_at', ...rows.map(r => [r.name, r.email, r.ts].map(esc).join(','))].join('\n'));
  });
}
