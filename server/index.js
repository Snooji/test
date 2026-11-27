import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import express from 'express';
import { Server, matchMaker } from '@colyseus/core';
import { WebSocketTransport } from '@colyseus/ws-transport';
import { MoveRoom } from './MoveRoom.js';
import { DemoRoom } from './DemoRoom.js';
import { signupRoutes } from './signups.js';
import { openStore } from './store.js';
import { securityHeaders, rateLimit, checkEnv } from './security.js';

const PORT = Number(process.env.PORT) || 2567;
checkEnv();
const store = await openStore();
MoveRoom.store = store;

process.on('uncaughtException', (err) => { console.error(err); store.logError({ where: 'server', message: err.message, stack: err.stack, ua: '' }).catch(() => {}); });
process.on('unhandledRejection', (err) => { console.error(err); store.logError({ where: 'server', message: String(err?.message || err), stack: err?.stack || '', ua: '' }).catch(() => {}); });

const app = express();
app.set('trust proxy', true);
app.disable('x-powered-by');                 // don't advertise the framework
app.use(securityHeaders);
app.use('/api', rateLimit(300, 60_000));      // every API route: 300 a minute per visitor (tighter limits per route in signups.js)
app.use(['/admin', '/confirm', '/unsubscribe'], rateLimit(60, 60_000));
app.get('/health', async (_req, res) => {
  const rooms = await matchMaker.query({}).catch(() => []);
  res.set('Cache-Control', 'no-store').json({ ok: true, rooms: rooms.length, players: rooms.reduce((a, r) => a + r.clients, 0) });
});
signupRoutes(app, express, store);

const dist = path.resolve('dist');
if (fs.existsSync(dist)) {
  app.get('/privacy.html', (_req, res) => res.redirect(301, '/privacy'));
  app.use(express.static(dist, { maxAge: '1h', index: false, dotfiles: 'ignore', setHeaders: (res, p) => {
    if (p.endsWith('sw.js') || p.endsWith('.webmanifest')) res.setHeader('Cache-Control', 'no-cache');
    else if (/[\\/]assets[\\/].+-[\w-]{8}\.(js|css)$/.test(p)) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable'); // fingerprinted: never changes
    else if (/[\\/](models|chars)[\\/]/.test(p)) res.setHeader('Cache-Control', 'public, max-age=604800'); // models + portraits: a week
  } }));
  const esc = (t) => String(t).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  app.get('/privacy', (_req, res) => {
    const contact = process.env.CONTACT_EMAIL
      ? `email <a href="mailto:${esc(process.env.CONTACT_EMAIL)}">${esc(process.env.CONTACT_EMAIL)}</a> from the address you signed up with and we’ll remove it`
      : 'use the unsubscribe link in any of our emails and ask us to delete it, and we’ll remove it';
    res.type('html').send(fs.readFileSync(path.join(dist, 'privacy.html'), 'utf8').replace('{{CONTACT}}', contact));
  });
  app.get('/', (_req, res) => res.sendFile(path.join(dist, 'index.html')));
  // the voxel look used to live at /voxel: old links and shared invites (…/voxel?room=XYZ) still work
  app.get('/voxel', (req, res) => res.redirect(301, '/' + (req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '')));
}

// anything else: a plain 404, and errors without stack traces or framework details
app.use((_req, res) => res.status(404).type('text').send('Not found'));
app.use((err, req, res, _next) => {
  const status = err.status >= 400 && err.status < 500 ? err.status : 500;
  if (status === 500) { console.error(err); store.logError({ where: 'http', message: String(err.message).slice(0, 500), stack: String(err.stack || '').slice(0, 2000), ua: req.get('user-agent') || '' }).catch(() => {}); }
  res.status(status).type('text').send(status === 500 ? 'Something went wrong.' : 'Bad request.');
});

const httpServer = http.createServer(app);
const gameServer = new Server({ greet: false, transport: new WebSocketTransport({ server: httpServer }) });
gameServer.define('move', MoveRoom).filterBy(['quick']);
gameServer.define('demo', DemoRoom);

await gameServer.listen(PORT);
console.log(`🚚 Starside Movers listening on http://localhost:${PORT}`);
