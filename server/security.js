// Web security: response headers, the client's real IP, rate limits, admin sessions and a start-up check of the
// environment. Kept free of other server modules so tests can load it on its own.
import crypto from 'node:crypto';

export const isProd = () => process.env.NODE_ENV === 'production' || !!process.env.RENDER; // Render sets RENDER=true

/**
 * The visitor's IP. On Render every request comes through Cloudflare, which sets CF-Connecting-IP itself (a value a
 * client sends is overwritten). X-Forwarded-For can't be trusted for this: its first entry is whatever the client wrote.
 */
export function clientIp(req) {
  const cf = req.headers?.['cf-connecting-ip'];
  if (isProd() && typeof cf === 'string' && cf.length < 64) return cf.trim();
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

/** Sliding-window limiter: `hit(key)` → true while under `max` per `windowMs`. Old keys are swept so memory stays flat. */
export function limiter(max, windowMs) {
  const hits = new Map();
  const sweep = setInterval(() => { const t = Date.now(); for (const [k, arr] of hits) if (!arr.length || t - arr[arr.length - 1] > windowMs) hits.delete(k); }, Math.max(10_000, windowMs)).unref?.();
  void sweep;
  return {
    hit(key) {
      const t = Date.now();
      let arr = hits.get(key);
      if (!arr) { arr = []; hits.set(key, arr); }
      while (arr.length && t - arr[0] >= windowMs) arr.shift();
      if (arr.length >= max) return false;
      arr.push(t);
      return true;
    },
    /** count without recording (for "too many failed attempts") */
    blocked(key) { const t = Date.now(), arr = hits.get(key) || []; return arr.filter(x => t - x < windowMs).length >= max; },
    reset(key) { hits.delete(key); },
    size: () => hits.size,
  };
}

/** Express middleware: a limiter per route group, by client IP. */
export function rateLimit(max, windowMs, message = 'Too many requests. Slow down and try again shortly.') {
  const l = limiter(max, windowMs);
  return (req, res, next) => {
    if (l.hit(clientIp(req))) return next();
    res.set('Retry-After', String(Math.ceil(windowMs / 1000)));
    if (req.accepts(['json', 'html']) === 'html') return res.status(429).type('text').send(message);
    res.status(429).json({ error: message });
  };
}

/** Security headers for every response. The game loads only its own scripts; fonts come from Google Fonts. */
export function securityHeaders(req, res, next) {
  const host = String(req.headers.host || '').replace(/[^\w.:-]/g, '');
  res.set({
    'Content-Security-Policy': [
      "default-src 'self'",
      "script-src 'self' 'wasm-unsafe-eval'", // the 3D model decoder is WebAssembly; JavaScript eval stays blocked
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com", // inline style attributes set by the UI code
      "font-src 'self' https://fonts.gstatic.com data:",
      "img-src 'self' data: blob:",
      `connect-src 'self' blob: data:${host ? ` wss://${host} ws://${host}` : ''}`, // the game's WebSocket; models' embedded textures
      "worker-src 'self' blob:",
      "manifest-src 'self'",
      "media-src 'self' data: blob:",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join('; '),
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Origin-Agent-Cluster': '?1',
  });
  if (isProd()) res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
}

/** Pages that must never be cached, indexed or leak their URL onward (admin, account links). */
export function privatePage(_req, res, next) {
  res.set({ 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow', 'Referrer-Policy': 'no-referrer' });
  next();
}

const same = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };

// ---- admin sessions: log in once with ADMIN_KEY, then a signed HttpOnly cookie (12 h). Rotating ADMIN_KEY logs everyone out. ----
const ADMIN_COOKIE = 'sm_admin', ADMIN_TTL = 12 * 3600_000;
const adminSig = (exp) => crypto.createHmac('sha256', 'admin-session:' + (process.env.ADMIN_KEY || '')).update(String(exp)).digest('hex');
export const adminEnabled = () => (process.env.ADMIN_KEY || '').length >= 16;
export const adminKeyOk = (k) => adminEnabled() && same(process.env.ADMIN_KEY, String(k || ''));
export function adminCookie(secure) {
  const exp = Date.now() + ADMIN_TTL;
  return `${ADMIN_COOKIE}=${exp}.${adminSig(exp)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${ADMIN_TTL / 1000}${secure ? '; Secure' : ''}`;
}
export const adminLogoutCookie = (secure) => `${ADMIN_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? '; Secure' : ''}`;
export function adminSession(req) {
  if (!adminEnabled()) return false;
  const raw = String(req.headers.cookie || '').split(/;\s*/).find(c => c.startsWith(ADMIN_COOKIE + '='));
  if (!raw) return false;
  const [exp, sig] = raw.slice(ADMIN_COOKIE.length + 1).split('.');
  return Number(exp) > Date.now() && !!sig && same(adminSig(exp), sig);
}
/** a form post from this site (blocks cross-site form posts even if a browser ignores SameSite) */
export function sameOrigin(req) {
  const o = req.headers.origin || req.headers.referer;
  if (!o) return false;
  try { return new URL(o).host === req.headers.host; } catch { return false; }
}

/** Start-up check of the environment: secrets present and strong, nothing debug-only left on. Never prints values. */
export function checkEnv(log = console) {
  const warn = [], env = process.env;
  const strong = (k, min = 16) => (env[k] || '').length >= min;
  if (isProd() && !env.GATE_SECRET) warn.push('GATE_SECRET is not set: sign-in tokens use a secret stored on the data disk (set GATE_SECRET so they survive a lost disk).');
  if (env.GATE_SECRET && !strong('GATE_SECRET', 32)) warn.push('GATE_SECRET is short: use 32+ random characters.');
  if (env.ADMIN_KEY && !strong('ADMIN_KEY')) warn.push('ADMIN_KEY is under 16 characters: the admin pages are switched off until it is longer.');
  if (env.CONVERSION_KEY && !strong('CONVERSION_KEY')) warn.push('CONVERSION_KEY is under 16 characters: booking webhooks are refused until it is longer.');
  if (isProd() && env.DEBUG_HOOKS === '1') warn.push('DEBUG_HOOKS=1 is ignored in production (test-only cheats stay off).');
  if (isProd() && !env.PUBLIC_URL) warn.push('PUBLIC_URL is not set: links in emails use the request host. Set it to https://your-domain.');
  if (env.PUBLIC_URL && isProd() && !/^https:\/\//.test(env.PUBLIC_URL)) warn.push('PUBLIC_URL should start with https://');
  if (env.RESEND_API_KEY && !env.MAIL_FROM) warn.push('RESEND_API_KEY is set without MAIL_FROM: emails are off.');
  if (env.DATABASE_URL && /sslmode=disable/.test(env.DATABASE_URL) && !/@(localhost|127\.0\.0\.1|[\w-]+)(:\d+)?\//.test(env.DATABASE_URL)) warn.push('DATABASE_URL turns off SSL for a remote database.');
  for (const w of warn) log.warn('⚠️ config: ' + w);
  return warn;
}

/** Debug-only room messages (teleport, instant win…) exist only for automated tests, never in production. */
export const debugHooksOn = () => process.env.DEBUG_HOOKS === '1' && !isProd();
