import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import express from 'express';
import { Server, matchMaker } from 'colyseus';
import { WebSocketTransport } from '@colyseus/ws-transport';
import { MoveRoom } from './MoveRoom.js';
import { DemoRoom } from './DemoRoom.js';
import { signupRoutes } from './signups.js';
import { openStore } from './store.js';

const PORT = Number(process.env.PORT) || 2567;
const store = await openStore();
MoveRoom.store = store;

process.on('uncaughtException', (err) => { console.error(err); store.logError({ where: 'server', message: err.message, stack: err.stack, ua: '' }).catch(() => {}); });
process.on('unhandledRejection', (err) => { console.error(err); store.logError({ where: 'server', message: String(err?.message || err), stack: err?.stack || '', ua: '' }).catch(() => {}); });

const app = express();
app.set('trust proxy', true);
app.get('/health', async (_req, res) => {
  const rooms = await matchMaker.query({}).catch(() => []);
  res.json({ ok: true, rooms: rooms.length, players: rooms.reduce((a, r) => a + r.clients, 0), mem: Math.round(process.memoryUsage().rss / 1e6) + 'MB', uptime: Math.round(process.uptime()) });
});
signupRoutes(app, express, store);

const dist = path.resolve('dist');
if (fs.existsSync(dist)) {
  app.get('/privacy.html', (_req, res) => res.redirect(301, '/privacy'));
  app.use(express.static(dist, { maxAge: '1h', index: false, setHeaders: (res, p) => { if (p.endsWith('sw.js') || p.endsWith('.webmanifest')) res.setHeader('Cache-Control', 'no-cache'); } }));
  const esc = (t) => String(t).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  app.get('/privacy', (_req, res) => {
    const contact = process.env.CONTACT_EMAIL
      ? `email <a href="mailto:${esc(process.env.CONTACT_EMAIL)}">${esc(process.env.CONTACT_EMAIL)}</a> from the address you signed up with and we’ll remove it`
      : 'use the unsubscribe link in any of our emails and ask us to delete it, and we’ll remove it';
    res.type('html').send(fs.readFileSync(path.join(dist, 'privacy.html'), 'utf8').replace('{{CONTACT}}', contact));
  });
  app.get(['/', '/voxel'], (_req, res) => res.sendFile(path.join(dist, 'index.html'))); // /voxel = same game, voxel look (trial)
}

const httpServer = http.createServer(app);
const gameServer = new Server({ transport: new WebSocketTransport({ server: httpServer }) });
gameServer.define('move', MoveRoom).filterBy(['quick']);
gameServer.define('demo', DemoRoom);

await gameServer.listen(PORT);
console.log(`🚚 Starside Movers listening on http://localhost:${PORT}`);
