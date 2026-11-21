import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import express from 'express';
import { Server } from 'colyseus';
import { WebSocketTransport } from '@colyseus/ws-transport';
import { MoveRoom } from './MoveRoom.js';
import { signupRoutes } from './signups.js';

const PORT = Number(process.env.PORT) || 2567;
const app = express();
app.set('trust proxy', true);
app.get('/health', (_req, res) => res.json({ ok: true }));
signupRoutes(app, express);

const dist = path.resolve('dist');
if (fs.existsSync(dist)) {
  app.use(express.static(dist, { maxAge: '1h', index: false }));
  app.get('/', (_req, res) => res.sendFile(path.join(dist, 'index.html')));
}

const httpServer = http.createServer(app);
const gameServer = new Server({ transport: new WebSocketTransport({ server: httpServer }) });
gameServer.define('move', MoveRoom);

await gameServer.listen(PORT);
console.log(`🚚 Starside Movers listening on http://localhost:${PORT}`);
