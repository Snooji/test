// Persistence: signups (with consent), funnel counters, daily leaderboard, player profiles, error log.
// PgStore when DATABASE_URL is set (survives redeploys anywhere); FileStore otherwise (a JSON file in DATA_DIR).
import fs from 'node:fs';
import path from 'node:path';

const now = () => new Date().toISOString();
const today = () => now().slice(0, 10);
const MAX_ERRORS = 200;

export class FileStore {
  constructor(dir) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.file = path.join(dir, 'store.json');
    this.d = { signups: {}, events: {}, scores: {}, profiles: {}, errors: [], conversions: [] };
    if (fs.existsSync(this.file)) {
      try { Object.assign(this.d, JSON.parse(fs.readFileSync(this.file, 'utf8'))); } catch { /* corrupt: start fresh, keep the file */ fs.copyFileSync(this.file, this.file + '.bad'); }
    } else {
      // one-time import of the original append-only signup log
      const legacy = path.join(dir, 'signups.jsonl');
      if (fs.existsSync(legacy)) {
        for (const line of fs.readFileSync(legacy, 'utf8').split('\n')) {
          try { const r = JSON.parse(line); this.d.signups[r.email] = { email: r.email, name: r.name, marketing: true, confirmed: null, unsubscribed: false, created_at: this.d.signups[r.email]?.created_at || r.ts, last_seen: r.ts }; } catch { /* skip blank lines */ }
        }
        this.save(true);
      }
    }
  }
  async init() {}
  save(now_ = false) {
    clearTimeout(this.timer);
    const write = () => { const tmp = this.file + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(this.d), { mode: 0o600 }); fs.renameSync(tmp, this.file); }; // owner-only file: emails live here
    if (now_) write(); else this.timer = setTimeout(write, 400);
  }
  async flush() { this.save(true); }

  async upsertSignup({ name, email, marketing }) {
    const r = this.d.signups[email];
    if (r) Object.assign(r, { name, last_seen: now(), marketing: r.unsubscribed ? !!marketing : (r.marketing || !!marketing), unsubscribed: r.unsubscribed && !marketing });
    else this.d.signups[email] = { email, name, marketing: !!marketing, confirmed: null, unsubscribed: false, created_at: now(), last_seen: now() };
    this.save();
    return { isNew: !r };
  }
  async listSignups() { return Object.values(this.d.signups).sort((a, b) => a.created_at.localeCompare(b.created_at)); }
  async confirm(email) { const r = this.d.signups[email]; if (r) { r.confirmed = true; this.save(); } return !!r; }
  async unsubscribe(email) { const r = this.d.signups[email]; if (r) { r.unsubscribed = true; r.marketing = false; this.save(); } return !!r; }
  async setMarketing(email, on) { const r = this.d.signups[email]; if (r) { r.marketing = !!on; r.unsubscribed = !on; this.save(); } return !!r; }
  async event(name, n = 1) { const k = today() + '|' + name; this.d.events[k] = (this.d.events[k] || 0) + n; this.save(); }
  async funnel(days) {
    const since = new Date(Date.now() - days * 864e5).toISOString().slice(0, 10);
    return Object.entries(this.d.events).map(([k, n]) => { const [day, name] = k.split('|'); return { day, name, n }; }).filter(r => r.day >= since);
  }
  async addScore({ day, email, name, score, detail }) {
    const byDay = (this.d.scores[day] ||= {});
    const cur = byDay[email];
    if (!cur || score > cur.score) byDay[email] = { email, name, score, detail, at: now() };
    this.save();
  }
  async topScores(day, limit) { return Object.values(this.d.scores[day] || {}).sort((a, b) => b.score - a.score).slice(0, limit); }
  async getProfile(email) { return { email, games: 0, wins: 0, loaded: 0, ...(this.d.profiles[email] || {}) }; }
  async recordGame(email, { won, loaded }) {
    const p = (this.d.profiles[email] ||= { games: 0, wins: 0, loaded: 0 });
    p.games++; if (won) p.wins++; p.loaded += loaded || 0;
    this.save();
  }
  async logError(e) { this.d.errors.unshift({ ...e, at: now() }); this.d.errors.length = Math.min(this.d.errors.length, MAX_ERRORS); this.save(); }
  async addConversion({ type, email, name, value, source, note }) {
    (this.d.conversions ||= []).unshift({ at: now(), type, email: (email || '').toLowerCase(), name: name || '', value: Number(value) || 0, source, note: note || '' });
    await this.event(type);
    this.save();
  }
  async listConversions(limit) {
    return (this.d.conversions || []).slice(0, limit).map(c => ({ ...c, player: !!(c.email && this.d.signups[c.email]) }));
  }
  async recentErrors(limit) { return this.d.errors.slice(0, limit); }
}

export class PgStore {
  constructor(pool) { this.pool = pool; }
  q(sql, args = []) { return this.pool.query(sql, args); }
  async init() {
    await this.q(`create table if not exists signups (email text primary key, name text, marketing boolean, confirmed boolean, unsubscribed boolean default false, created_at text, last_seen text)`);
    await this.q(`create table if not exists events (day text, name text, n integer, primary key (day, name))`);
    await this.q(`create table if not exists scores (day text, email text, name text, score integer, detail text, at text, primary key (day, email))`);
    await this.q(`create table if not exists profiles (email text primary key, games integer, wins integer, loaded integer)`);
    await this.q(`create table if not exists errors (id serial primary key, at text, where_ text, message text, stack text, ua text)`);
    await this.q(`create table if not exists conversions (id serial primary key, at text, type text, email text, name text, value integer, source text, note text)`);
  }
  async flush() {}
  async upsertSignup({ name, email, marketing }) {
    const { rows } = await this.q('select marketing, unsubscribed from signups where email = $1', [email]);
    if (rows.length) {
      const r = rows[0];
      const m = r.unsubscribed ? !!marketing : (r.marketing || !!marketing);
      await this.q('update signups set name = $2, last_seen = $3, marketing = $4, unsubscribed = $5 where email = $1', [email, name, now(), m, r.unsubscribed && !marketing]);
      return { isNew: false };
    }
    await this.q('insert into signups (email, name, marketing, confirmed, unsubscribed, created_at, last_seen) values ($1, $2, $3, null, false, $4, $4)', [email, name, !!marketing, now()]);
    return { isNew: true };
  }
  async listSignups() { return (await this.q('select * from signups order by created_at')).rows; }
  async confirm(email) { return (await this.q('update signups set confirmed = true where email = $1', [email])).rowCount > 0; }
  async unsubscribe(email) { return (await this.q('update signups set unsubscribed = true, marketing = false where email = $1', [email])).rowCount > 0; }
  async setMarketing(email, on) { return (await this.q('update signups set marketing = $2, unsubscribed = $3 where email = $1', [email, !!on, !on])).rowCount > 0; }
  async event(name, n = 1) {
    const day = today();
    const { rowCount } = await this.q('update events set n = n + $3 where day = $1 and name = $2', [day, name, n]);
    if (!rowCount) await this.q('insert into events (day, name, n) values ($1, $2, $3)', [day, name, n]).catch(() => this.q('update events set n = n + $3 where day = $1 and name = $2', [day, name, n]));
  }
  async funnel(days) {
    const since = new Date(Date.now() - days * 864e5).toISOString().slice(0, 10);
    return (await this.q('select day, name, n from events where day >= $1', [since])).rows;
  }
  async addScore({ day, email, name, score, detail }) {
    const { rows } = await this.q('select score from scores where day = $1 and email = $2', [day, email]);
    if (!rows.length) await this.q('insert into scores (day, email, name, score, detail, at) values ($1, $2, $3, $4, $5, $6)', [day, email, name, score, detail, now()]);
    else if (score > rows[0].score) await this.q('update scores set score = $3, name = $4, detail = $5, at = $6 where day = $1 and email = $2', [day, email, score, name, detail, now()]);
  }
  async topScores(day, limit) { return (await this.q('select name, score, detail, email from scores where day = $1 order by score desc limit $2', [day, limit])).rows; }
  async getProfile(email) {
    const { rows } = await this.q('select games, wins, loaded from profiles where email = $1', [email]);
    return { email, games: 0, wins: 0, loaded: 0, ...(rows[0] || {}) };
  }
  async recordGame(email, { won, loaded }) {
    const { rowCount } = await this.q('update profiles set games = games + 1, wins = wins + $2, loaded = loaded + $3 where email = $1', [email, won ? 1 : 0, loaded || 0]);
    if (!rowCount) await this.q('insert into profiles (email, games, wins, loaded) values ($1, 1, $2, $3)', [email, won ? 1 : 0, loaded || 0]);
  }
  async logError({ where, message, stack, ua }) {
    await this.q('insert into errors (at, where_, message, stack, ua) values ($1, $2, $3, $4, $5)', [now(), where, String(message).slice(0, 500), String(stack || '').slice(0, 2000), String(ua || '').slice(0, 300)]);
  }
  async recentErrors(limit) { return (await this.q('select at, where_ as "where", message, stack, ua from errors order by id desc limit $1', [limit])).rows; }
  async addConversion({ type, email, name, value, source, note }) {
    await this.q('insert into conversions (at, type, email, name, value, source, note) values ($1, $2, $3, $4, $5, $6, $7)', [now(), type, (email || '').toLowerCase(), name || '', Number(value) || 0, source, note || '']);
    await this.event(type);
  }
  async listConversions(limit) {
    const { rows } = await this.q('select id, at, type, email, name, value, source, note from conversions order by id desc limit $1', [limit]);
    const known = new Set();
    for (const r of rows) if (r.email) { const x = await this.q('select 1 from signups where email = $1', [r.email]); if (x.rows.length) known.add(r.email); }
    return rows.map(r => ({ ...r, player: known.has(r.email) }));
  }
}

/** Pick the store for this deployment. */
export async function openStore() {
  if (process.env.DATABASE_URL) {
    const { default: pg } = await import('pg');
    // SSL: local → off; a private network host with no dots (Render's internal URL) → encrypted, its certificate names the
    // public host so it isn't checked; any public host → encrypted AND the certificate verified (stops a man in the middle).
    let host = ''; try { host = new URL(process.env.DATABASE_URL).hostname; } catch {}
    const ssl = /^(localhost|127\.0\.0\.1|::1)$/.test(host) ? false
      : !host.includes('.') || process.env.DB_SSL_NO_VERIFY === '1' ? { rejectUnauthorized: false } : { rejectUnauthorized: true };
    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl, max: 10, idleTimeoutMillis: 30_000 });
    const s = new PgStore(pool);
    await s.init();
    console.log('📦 store: Postgres');
    return s;
  }
  const dir = process.env.DATA_DIR || path.resolve('data');
  console.log('📦 store: file', dir);
  return new FileStore(dir);
}
