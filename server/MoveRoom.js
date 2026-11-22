import { Room, ServerError } from 'colyseus';
import { createGrid, placeItem, tallyVotes, ITEM_TYPES, RULES, GRID, footprint, orientations, ORIENT_LABEL, canFitAny, isRemovable, removeFromGrid, topItemAt } from '../shared/logic.js';
import { Bot, BOT_NAMES, DIFFICULTY } from './bot.js';
import { PLAYER_SPAWNS, inRamp, TRUCK } from '../shared/world.js';
import { generateLevel, classicLevel, newSeed, freeSpot } from '../shared/level.js';
import { createNav } from './nav.js';
import { verifyToken, cleanName, cleanEmail } from './signups.js';

const CHARS = ['nova', 'cosmo', 'glorp', 'zibble'];
const SPEED = 5;
const R = 0.45;           // player radius
const REACH = 1.7;        // interaction distance
const TICK = 50;          // ms (20 Hz)
const MAX_MOVERS = 4;

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const dist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);

export class MoveRoom extends Room {
  static store = null; // set by server/index.js; null in unit tests
  maxClients = 6; // 4 movers + 2 spectators

  onAuth(client, options) {
    const email = cleanEmail(options?.email);
    if (!verifyToken(email, options?.token)) throw new ServerError(401, 'Sign in at the gate first.');
    return { email, name: cleanName(options?.name) || 'Mover' };
  }

  onCreate(options = {}) {
    this.phase = 'lobby';
    this.mode = '3min';
    this.game = options.game === 'sabotage' ? 'sabotage' : 'classic';
    this.difficulty = DIFFICULTY[options.difficulty] ? options.difficulty : 'normal';
    this.bots = new Map();
    this.botSeq = 0;
    this.soloPending = !!options.solo;
    this.solo = !!options.solo;
    this.countdown = 0;
    this.classic = options.level === 'classic';
    this.seedOverride = Number.isInteger(options.seed) ? options.seed : null;
    this.players = new Map();
    this.items = new Map();
    this.breaks = [];
    this.grid = createGrid();
    this.hostId = null;
    this.meeting = null;
    this.results = null;
    this.timeLeft = 0;
    this.seq = 0;
    this.newLevel();
    this.resetWorld();

    this.onMessage('input', (c, m) => {
      const p = this.players.get(c.sessionId);
      if (!p || typeof m !== 'object') return;
      const mx = Number(m.mx) || 0, mz = Number(m.mz) || 0;
      const len = Math.hypot(mx, mz);
      p.in.mx = len > 1 ? mx / len : mx;
      p.in.mz = len > 1 ? mz / len : mz;
      p.in.hold = !!m.hold;
      if (p.resync) { p.resync = false; for (const k of ['tapN', 'dashN', 'rotN']) p.in[k] = Number(m[k]) | 0; return; }
      for (const k of ['tapN', 'dashN', 'rotN']) {
        const v = Number(m[k]) | 0;
        if (v > p.in[k]) { p.pending[k] += Math.min(3, v - p.in[k]); p.in[k] = v; }
      }
    });
    this.onMessage('char', (c, m) => {
      const p = this.players.get(c.sessionId);
      if (!p || this.phase === 'playing' || this.phase === 'meeting') return;
      if (CHARS.includes(m?.id) && ![...this.players.values()].some(o => o !== p && o.char === m.id)) p.char = m.id;
    });
    this.onMessage('mode', (c, m) => {
      if (c.sessionId !== this.hostId || !RULES.MODES[m?.mode] || this.inRound()) return;
      const wasExact = this.isExact();
      this.mode = m.mode;
      if (this.isExact() !== wasExact && !this.classic) { this.newLevel(); this.resetWorld(); } // Full load needs an exact-fill house
    });
    this.onMessage('start', (c) => {
      if (c.sessionId !== this.hostId || this.inRound()) return;
      if (this.game === 'sabotage' && this.movers().length < 3) {
        this.tell(this.players.get(c.sessionId), 'Sabotage needs at least 3 movers. Add AI movers or invite friends.');
        return;
      }
      if (this.phase === 'results') this.newLevel(); // play again → fresh house
      this.startRound();
    });
    this.onMessage('lobby', (c) => {
      if (c.sessionId === this.hostId && this.phase === 'results') { this.phase = 'lobby'; this.newLevel(); this.resetWorld(); }
    });
    this.onMessage('reroll', (c) => {
      if (c.sessionId === this.hostId && this.phase === 'lobby' && !this.classic) { this.newLevel(); this.resetWorld(); }
    });
    if (process.env.DEBUG_HOOKS === '1') {
      this.onMessage('debug_give', (c, m) => {
        const p = this.players.get(c.sessionId);
        const it = [...this.items.values()].find(i => i.state === 'floor' && i.type === m?.type);
        if (!p || !it || this.phase !== 'playing') return;
        it.wrapped = true; it.assembled = false; it.state = 'carried'; it.carriers = [p.id]; p.carry = it.id;
        p.x = 11.2; p.z = 0; it.x = p.x; it.z = p.z;
      });
      this.onMessage('debug_break', (c) => {
        const it = [...this.items.values()].find(i => i.state === 'floor' && i.type === 'fragile');
        if (it && this.phase === 'playing') { it.state = 'broken'; this.recordBreak(it, [c.sessionId], 'got crushed'); }
      });
    }
    this.onMessage('callout', (c) => this.callMeeting(c.sessionId));
    this.onMessage('help', (c) => this.helpPing(this.players.get(c.sessionId)));
    // D-pad / drag-to-aim in the truck: set the drop column directly
    this.onMessage('aim', (c, m) => {
      const p = this.players.get(c.sessionId);
      const item = p?.carry ? this.items.get(p.carry) : null;
      if (!p?.loadMode || (!item && !p.unloading)) return;
      const { w, d } = item ? footprint(item.type, p.cursor.rot) : { w: 1, d: 1 };
      p.cursor.gx = clamp(Number(m?.gx) | 0, 0, GRID.W - w);
      p.cursor.gz = clamp(Number(m?.gz) | 0, 0, GRID.D - d);
    });
    this.onMessage('vote', (c, m) => this.castVote(this.players.get(c.sessionId), m?.target));
    this.onMessage('chat', (c, m) => this.say(this.players.get(c.sessionId), m?.text));
    const hostInLobby = (c) => c.sessionId === this.hostId && (this.phase === 'lobby' || this.phase === 'results');
    this.onMessage('difficulty', (c, m) => {
      if (!hostInLobby(c) || !DIFFICULTY[m?.level]) return;
      this.difficulty = m.level;
      for (const b of this.bots.values()) b.setDifficulty(m.level);
    });
    this.onMessage('addBot', (c) => { if (hostInLobby(c)) this.addBot(); });
    this.onMessage('game', (c, m) => {
      if (!hostInLobby(c) || !['classic', 'sabotage'].includes(m?.game)) return;
      const wasExact = this.isExact();
      this.game = m.game;
      if (this.isExact() !== wasExact && !this.classic) { this.newLevel(); this.resetWorld(); }
    });
    this.onMessage('removeBot', (c) => {
      if (!hostInLobby(c)) return;
      const last = [...this.bots.keys()].pop();
      if (last) this.removeBot(last);
    });

    this.setSimulationInterval((dt) => this.tick(Math.min(dt, 100) / 1000), TICK);
  }

  onJoin(client, options, auth) {
    // a friend joining a full lobby takes a bot's seat
    if (this.phase === 'lobby' && this.movers().length >= MAX_MOVERS && this.bots.size) this.removeBot([...this.bots.keys()].pop());
    const used = new Set([...this.players.values()].map(p => p.char));
    const want = CHARS.includes(options?.char) && !used.has(options.char) ? options.char : CHARS.find(c => !used.has(c)) || 'nova';
    const movers = [...this.players.values()].filter(p => !p.spectator).length;
    const p = {
      id: client.sessionId, name: auth.name, email: auth.email, char: want,
      x: 0, z: 0, face: 0, score: 0, strikes: 0, out: false,
      spectator: movers >= MAX_MOVERS || this.inRound(),
      carry: null, loadMode: false, cursor: { gx: 1, gz: 0, rot: 0 }, cursorCd: 0,
      dashT: 0, dashCd: 0, loaded: 0, task: null,
      in: { mx: 0, mz: 0, hold: false, tapN: 0, dashN: 0, rotN: 0 },
      pending: { tapN: 0, dashN: 0, rotN: 0 },
    };
    this.placeAtSpawn(p, this.players.size);
    this.players.set(p.id, p);
    if (!this.hostId) this.hostId = p.id;
    this.event({ kind: 'toast', text: `${p.name} joined the crew${p.spectator ? ' (spectating this round)' : ''}` });
    if (this.soloPending) { this.soloPending = false; for (let i = 0; i < 3; i++) this.addBot(); }
  }

  newPlayer(id, name, char, extra = {}) {
    return {
      id, name, char, x: 0, z: 0, face: 0, score: 0, strikes: 0, out: false, spectator: false,
      carry: null, loadMode: false, cursor: { gx: 1, gz: 0, rot: 0 }, cursorCd: 0,
      dashT: 0, dashCd: 0, loaded: 0, breaks: 0, task: null,
      in: { mx: 0, mz: 0, hold: false, tapN: 0, dashN: 0, rotN: 0 },
      pending: { tapN: 0, dashN: 0, rotN: 0 }, ...extra,
    };
  }

  movers() { return [...this.players.values()].filter(p => !p.spectator); }
  inRound() { return this.phase === 'playing' || this.phase === 'meeting' || this.phase === 'countdown'; }

  addBot() {
    if (this.movers().length >= MAX_MOVERS || this.inRound()) return null;
    const used = new Set([...this.players.values()].map(p => p.char));
    const usedNames = new Set([...this.players.values()].map(p => p.name));
    const char = CHARS.find(c => !used.has(c)) || 'nova';
    const name = BOT_NAMES.find(n => !usedNames.has(n)) || 'Bot';
    const id = `bot-${++this.botSeq}`;
    const p = this.newPlayer(id, name, char, { bot: true });
    this.placeAtSpawn(p, this.players.size);
    this.players.set(id, p);
    this.bots.set(id, new Bot(this, p, this.difficulty));
    return p;
  }

  removeBot(id) {
    const p = this.players.get(id);
    if (!p?.bot) return;
    this.releaseCarry(p);
    this.players.delete(id);
    this.bots.delete(id);
  }

  async onLeave(client, consented) {
    const p = this.players.get(client.sessionId);
    if (!p) return;
    if (!consented && this.inRound() && typeof this.allowReconnection === 'function') {
      // phones drop connections when switching apps: hold their mover for 30 s
      p.in.mx = 0; p.in.mz = 0; p.in.hold = false; p.away = true;
      this.releaseCarry(p); // never leave a crewmate holding the other end
      this.system(`📡 ${p.name} lost connection. Holding their spot for 30 s…`);
      try {
        await this.allowReconnection(client, 30);
        p.away = false; p.resync = true;
        this.sendRole(p);
        this.system(`✅ ${p.name} is back!`);
        return;
      } catch { /* timed out */ }
    }
    this.releaseCarry(p);
    this.players.delete(p.id);
    if (this.hostId === p.id) this.hostId = [...this.players.values()].find(o => !o.bot)?.id || null;
    this.system(`👋 ${p.name} left the game.`);
    // multiplayer: if everyone else walked off, the last human standing wins
    if (this.inRound() && this.roundHumans >= 2) {
      const left = [...this.players.values()].filter(o => !o.bot && !o.spectator);
      if (left.length === 1) this.endRound(`Everyone else left. ${left[0].name} wins by default!`, left[0].id);
    }
  }

  sendRole(p) {
    if (this.game !== 'sabotage' || p.bot) return;
    this.clients.find(c => c.sessionId === p.id)?.send('evt', { kind: 'role', saboteur: !!p.saboteur });
  }

  /** Crew score in sabotage: the value of everything packed, minus overtime drain. */
  crewScore() {
    let v = 0;
    for (const i of this.items.values()) if (i.state === 'loaded') v += ITEM_TYPES[i.type].pts;
    return Math.max(0, Math.round(v - (this.drain || 0)));
  }

  system(text) { this.broadcast('chat', { from: 'Starside', text, system: true }); }

  helpPing(p) {
    const item = p?.carry ? this.items.get(p.carry) : null;
    if (!item || !ITEM_TYPES[item.type].teamCarry || item.carriers.length !== 1 || this.phase !== 'playing') return false;
    const now = this.clock?.currentTime ?? Date.now();
    if (p.lastHelp && now - p.lastHelp < 5000) return false;
    p.lastHelp = now;
    const label = ITEM_TYPES[item.type].label.toLowerCase();
    this.event({ kind: 'help', id: p.id, name: p.name, item: label, x: +item.x.toFixed(1), z: +item.z.toFixed(1), text: `🆘 ${p.name} needs a hand with the ${label}! Lift the other end and split the points.` });
    return true;
  }

  // ---------- world ----------
  newLevel() {
    this.level = this.classic ? classicLevel() : generateLevel(this.seedOverride ?? newSeed(), { exact: this.isExact() });
    this.seedOverride = null;
    this.nav = createNav(this.level);
    this.cat = { x: this.level.cat[0][0], z: this.level.cat[0][1], wp: 0 };
  }

  loadedCountCache() { let n = 0; for (const i of this.items.values()) if (i.state === 'loaded') n++; return n; }

  isExact() { return this.mode === 'load' || this.game === 'sabotage'; }
  allowsUnload() { return this.isExact(); }

  resetWorld() {
    this.items.clear();
    this.gridVersion = 0; this.fitCache = null; this.stuckHinted = false;
    this.grid = createGrid();
    this.breaks = [];
    this.meeting = null;
    this.level.items.forEach(([type, x, z], i) => {
      const t = ITEM_TYPES[type];
      this.items.set('i' + i, {
        id: 'i' + i, type, x, z, state: 'floor', wrapped: false,
        assembled: !!t.needsDisassemble, carriers: [], earned: {}, task: null, helpers: [], g: null,
      });
    });
    let i = 0;
    for (const p of this.players.values()) this.placeAtSpawn(p, i++);
  }

  placeAtSpawn(p, i) {
    const s = PLAYER_SPAWNS[i % PLAYER_SPAWNS.length];
    p.x = s.x; p.z = s.z; p.face = Math.PI;
  }

  startRound() {
    this.resetWorld();
    let i = 0;
    for (const p of this.players.values()) {
      Object.assign(p, { score: 0, strikes: 0, out: false, carry: null, loadMode: false, loaded: 0, breaks: 0, task: null, dashCd: 0, dashT: 0 });
      p.spectator = i >= MAX_MOVERS;
      this.placeAtSpawn(p, i++);
    }
    this.timeLeft = RULES.MODES[this.mode];
    this.results = null;
    for (const b of this.bots.values()) b.reset();
    this.overtime = false; this.drain = 0;
    for (const p of this.players.values()) { p.saboteur = false; p.lastMeeting = 0; }
    if (this.game === 'sabotage') {
      const movers = this.movers();
      movers[Math.floor(Math.random() * movers.length)].saboteur = true;
      for (const p of movers) this.sendRole(p);
    }
    this.phase = 'countdown';
    this.countdown = 3;
    MoveRoom.store?.event('round_start').catch(() => {});
    this.roundHumans = [...this.players.values()].filter(p => !p.bot && !p.spectator).length;
    this.event({ kind: 'start' });
  }

  isActive(p) { return p && !p.out && !p.spectator; }
  activePlayers() { return [...this.players.values()].filter(p => this.isActive(p)); }
  event(e) { this.broadcast('evt', e); }
  tell(p, text) { const c = this.clients.find(c => c.sessionId === p.id); c?.send('evt', { kind: 'toast', text, private: true }); }

  // ---------- simulation ----------
  tick(dt) {
    this.lastDt = dt;
    this.moveCat(dt);
    if (this.phase === 'countdown') {
      this.countdown -= dt;
      if (this.countdown <= 0) { this.phase = 'playing'; this.event({ kind: 'go' }); }
    } else if (this.phase === 'playing') {
      this.timeLeft -= dt;
      for (const b of this.bots.values()) b.think(dt);
      for (const p of this.players.values()) this.updatePlayer(p, dt);
      this.separate();
      this.updateTeamCarries(dt);
      this.updateTasks(dt);
      this.checkEnd();
    } else if (this.phase === 'meeting') {
      this.updateMeeting(dt);
    } else if (this.phase === 'lobby') {
      for (const p of this.players.values()) this.freeMove(p, dt, 1);
      this.separate();
    }
    for (const p of this.players.values()) { p.pending.tapN = 0; p.pending.dashN = 0; p.pending.rotN = 0; }
    this.broadcast('snap', this.snapshot());
  }

  /** Soft push so movers never stand inside each other (names stay readable). */
  separate() {
    const ps = [...this.players.values()].filter(p => !p.out && !p.spectator && !p.loadMode && !(p.carry && this.items.get(p.carry)?.carriers.length > 1));
    const MIN = 0.85;
    for (let i = 0; i < ps.length; i++) for (let j = i + 1; j < ps.length; j++) {
      const a = ps[i], b = ps[j];
      let dx = b.x - a.x, dz = b.z - a.z, d = Math.hypot(dx, dz);
      if (d >= MIN) continue;
      if (d < 1e-3) { dx = 1; dz = 0; d = 1; }
      const push = (MIN - d) / 2, ux = dx / d * push, uz = dz / d * push;
      if (!this.level.hitsWall(a.x - ux, a.z - uz, R)) { a.x -= ux; a.z -= uz; }
      if (!this.level.hitsWall(b.x + ux, b.z + uz, R)) { b.x += ux; b.z += uz; }
    }
  }

  moveCat(dt) {
    const [tx, tz] = this.level.cat[this.cat.wp];
    const dx = tx - this.cat.x, dz = tz - this.cat.z, d = Math.hypot(dx, dz);
    if (d < 0.3) { this.cat.wp = Math.floor(Math.random() * this.level.cat.length); return; }
    const sp = 1.4 * dt;
    const nx = this.cat.x + dx / d * sp, nz = this.cat.z + dz / d * sp;
    if (this.level.hitsWall(nx, nz, 0.25)) { this.cat.wp = (this.cat.wp + 1) % this.level.cat.length; return; }
    this.cat.x = nx; this.cat.z = nz; this.cat.face = Math.atan2(dx, dz);
  }

  freeMove(p, dt, mult) {
    const { mx, mz } = p.in;
    if (Math.abs(mx) + Math.abs(mz) < 0.05) return;
    const sp = SPEED * mult * dt;
    const nx = p.x + mx * sp, nz = p.z + mz * sp;
    if (!this.level.hitsWall(nx, p.z, R)) p.x = nx;
    if (!this.level.hitsWall(p.x, nz, R)) p.z = nz;
    p.face = Math.atan2(mx, mz);
  }

  updatePlayer(p, dt) {
    p.dashCd = Math.max(0, p.dashCd - dt);
    p.dashT = Math.max(0, p.dashT - dt);
    if (!this.isActive(p)) { this.freeMove(p, dt, 1.2); return; } // ghosts float around

    const item = p.carry ? this.items.get(p.carry) : null;
    const team = item && item.carriers.length > 1;

    if (p.loadMode) return this.updateLoadMode(p, item, dt);

    if (p.pending.dashN && p.dashCd <= 0) { p.dashT = 0.6; p.dashCd = 5; this.event({ kind: 'emote', id: p.id, e: '🚀' }); }

    if (!team) {
      let mult = p.dashT > 0 ? 2 : 1;
      if (item) {
        const t = ITEM_TYPES[item.type];
        if (t.teamCarry) mult *= this.activePlayers().length === 1 ? 0.4 : 0; // solo-lift only when alone; else wait for a buddy
        else if (t.heavy) mult *= 0.6;
      }
      if (p.task) mult = 0; // working on furniture
      this.freeMove(p, dt, mult);
      if (item) { item.x = p.x + Math.sin(p.face) * 0.2; item.z = p.z + Math.cos(p.face) * 0.2; }
    }

    // empty-handed on the ramp: hold ACTION to start pulling items back out (Full load only)
    if (!item && this.allowsUnload() && inRamp(p.x, p.z) && p.in.hold && this.grid.items.size) {
      p.unloadT = (p.unloadT || 0) + dt;
      if (p.unloadT > 0.6) {
        p.unloadT = 0; p.loadMode = true; p.unloading = true; p.cursor = { gx: 1, gz: 1, rot: 0 }; p.cursorCd = 0.35;
        this.tell(p, 'Unloading: aim at a stack, ACTION pulls the top piece, BACK to leave');
      }
      return;
    } else p.unloadT = 0;

    // carrying into the ramp → load mode (leader only for team carries)
    if (item && item.carriers[0] === p.id && inRamp(item.x, item.z)) {
      p.loadMode = true;
      p.cursor = { gx: 1, gz: 0, rot: 0 };
      p.cursorCd = 0.35; // grace so held movement doesn't jerk the cursor on entry
      this.tell(p, 'Aim with move · ACTION to drop · ROTATE to turn · BACK to leave');
      return;
    }

    if (p.pending.tapN) { p.pending.tapN = 0; this.onTap(p, item); } // consume: one tap = one action
  }

  onTap(p, item) {
    if (item) { // set it down on the floor
      this.releaseCarry(p);
      return;
    }
    const target = this.nearestItem(p);
    if (!target) return;
    const t = ITEM_TYPES[target.type];
    if (target.assembled) return this.tell(p, `Hold ACTION to disassemble the ${t.label.toLowerCase()} first`);
    if (t.teamCarry) {
      if (target.state === 'carried') {
        if (target.carriers.length >= 2) return;
        if (this.players.get(target.carriers[0])?.loadMode) return; // already being placed in the truck
        target.carriers.push(p.id); p.carry = target.id;
        this.event({ kind: 'emote', id: p.id, e: '💪' });
        this.event({ kind: 'toast', text: `Team lift! ${target.carriers.map(id => this.players.get(id)?.name).join(' + ')} carry the ${t.label.toLowerCase()}` });
        return;
      }
      const solo = this.activePlayers().length === 1;
      target.state = 'carried'; target.carriers = [p.id]; p.carry = target.id;
      if (!solo) this.tell(p, `This ${t.label.toLowerCase()} is a two-mover lift — get a crewmate to grab the other end!`);
      return;
    }
    target.state = 'carried'; target.carriers = [p.id]; p.carry = target.id;
    this.event({ kind: 'emote', id: p.id, e: t.fragile ? '🥚' : t.heavy ? '😤' : '📦' });
  }

  nearestItem(p) {
    let best = null, bd = REACH;
    for (const it of this.items.values()) {
      if (it.state !== 'floor' && !(it.state === 'carried' && ITEM_TYPES[it.type].teamCarry && it.carriers.length === 1)) continue;
      const t = ITEM_TYPES[it.type], len = Math.max(t.w, t.d);
      const d = dist(p, it) - (len > 1 ? len * 0.35 : 0);
      if (d < bd) { bd = d; best = it; }
    }
    return best;
  }

  releaseCarry(p) {
    const item = p.carry ? this.items.get(p.carry) : null;
    p.loadMode = false;
    if (!item) { p.carry = null; return; }
    for (const id of item.carriers) {
      const o = this.players.get(id);
      if (!o) continue;
      o.carry = null; o.loadMode = false;
      // team-carry positions ignore walls; never leave a mover embedded in one
      if (this.level.hitsWall(o.x, o.z, R)) { o.x = item.x; o.z = item.z; }
    }
    item.carriers = [];
    item.state = 'floor';
    // never drop inside a wall or on the ramp
    if (this.level.hitsWall(item.x, item.z, 0.3) || inRamp(item.x, item.z)) { item.x = p.x - 1; item.z = p.z; }
  }

  updateTeamCarries(dt) {
    for (const item of this.items.values()) {
      if (item.state !== 'carried') continue;
      const cs = item.carriers.map(id => this.players.get(id)).filter(Boolean);
      if (cs.length < 2 || cs[0].loadMode) continue;
      let mx = 0, mz = 0;
      for (const c of cs) { mx += c.in.mx; mz += c.in.mz; }
      mx /= cs.length; mz /= cs.length;
      const sp = SPEED * 0.7 * dt;
      const nx = item.x + mx * sp, nz = item.z + mz * sp;
      if (!this.level.hitsWall(nx, item.z, 0.45)) item.x = nx;
      if (!this.level.hitsWall(item.x, nz, 0.45)) item.z = nz;
      const off = this.carryOffset(item);
      cs[0].x = item.x - off; cs[0].z = item.z; cs[0].face = Math.PI / 2;
      cs[1].x = item.x + off; cs[1].z = item.z; cs[1].face = -Math.PI / 2;
      if (Math.abs(mx) + Math.abs(mz) > 0.05) { cs[0].face = cs[1].face = Math.atan2(mx, mz); }
      // a tap from either carrier sets it down
      if (cs.some(c => c.pending.tapN)) this.releaseCarry(cs[0]);
    }
  }

  carryOffset(item) { const t = ITEM_TYPES[item.type]; return Math.max(t.w, t.d) * 0.48 + 0.1; }

  updateTasks(dt) {
    for (const it of this.items.values()) it.helpers = [];
    for (const p of this.players.values()) {
      p.task = null;
      if (!this.isActive(p) || p.carry || !p.in.hold) continue;
      const it = this.nearestItem(p);
      if (!it || it.state !== 'floor') continue;
      const t = ITEM_TYPES[it.type];
      const kind = it.assembled ? 'disassemble' : (t.needsWrap && !it.wrapped ? 'wrap' : null);
      if (!kind) continue;
      if (it.jam > 0 && kind === 'disassemble' && !p.saboteur && !it.jamNoticed) { it.jamNoticed = true; this.tell(p, '🔩 These bolts are way too tight… someone has been messing with this.'); }
      if (!it.task || it.task.kind !== kind) it.task = { kind, progress: 0, contributors: [] };
      if (p.saboteur && kind === 'disassemble') { // looks like helping; actually over-tightens the bolts
        it.jam = Math.min(8, (it.jam || 0) + dt * 1.3);
        p.task = { id: it.id, kind };
        continue;
      }
      const secs = kind === 'wrap' ? RULES.WRAP_SECONDS : RULES.DISASSEMBLE_SECONDS + (it.jam || 0);
      it.task.progress += dt / secs;
      it.helpers.push(p.id);
      if (!it.task.contributors.includes(p.id)) it.task.contributors.push(p.id);
      p.task = { id: it.id, kind };
      if (it.task.progress >= 1) {
        if (kind === 'wrap') it.wrapped = true; else it.assembled = false;
        for (const id of it.task.contributors) { const h = this.players.get(id); if (h) h.score += RULES.HELPER_BONUS; }
        this.event({ kind: 'toast', text: `${kind === 'wrap' ? '🧣 Pad-wrapped' : '🔧 Disassembled'} the ${t.label.toLowerCase()}! +${RULES.HELPER_BONUS} each` });
        it.task = null;
      }
    }
  }

  updateLoadMode(p, item, dt) {
    if (!item && !p.unloading) { p.loadMode = false; return; }
    const c = p.cursor;
    p.cursorCd = Math.max(0, p.cursorCd - dt);
    const { mx, mz } = p.in;
    if (!item) { // unloading: pick which item to pull back out
      if (p.cursorCd <= 0 && (Math.abs(mx) > 0.5 || Math.abs(mz) > 0.5)) {
        if (Math.abs(mz) > 0.5) c.gx += Math.sign(mz);
        if (Math.abs(mx) > 0.5) c.gz -= Math.sign(mx);
        p.cursorCd = 0.18;
      }
      c.gx = clamp(c.gx, 0, GRID.W - 1); c.gz = clamp(c.gz, 0, GRID.D - 1);
      if (p.pending.dashN) { p.loadMode = false; p.unloading = false; p.x = TRUCK.ramp.x0 - 1.2; return; }
      if (p.pending.tapN) this.pullFromTruck(p);
      return;
    }
    if (p.cursorCd <= 0 && (Math.abs(mx) > 0.5 || Math.abs(mz) > 0.5)) {
      if (Math.abs(mz) > 0.5) c.gx += Math.sign(mz);
      if (Math.abs(mx) > 0.5) c.gz -= Math.sign(mx); // pushing right = deeper toward the cab (gz 0)
      p.cursorCd = 0.18;
    }
    const nOr = orientations(item.type).length;
    if (p.pending.rotN && nOr > 1) {
      c.rot = (c.rot + 1) % nOr;
      const f = footprint(item.type, c.rot);
      this.tell(p, `↻ ${ITEM_TYPES[item.type].label} ${ORIENT_LABEL(f)} (${f.w}×${f.d}×${f.h})`);
    }
    const { w, d } = footprint(item.type, c.rot);
    c.gx = clamp(c.gx, 0, GRID.W - w);
    c.gz = clamp(c.gz, 0, GRID.D - d);

    if (p.pending.dashN) { // BACK out of the truck: step off the ramp so it doesn't re-trigger
      p.loadMode = false;
      p.x = TRUCK.ramp.x0 - 1.2; item.x = p.x; item.z = p.z;
      if (item.carriers.length > 1) item.x += this.carryOffset(item);
      return;
    }
    if (p.pending.tapN) this.dropIntoTruck(p, item);
  }

  pullFromTruck(p) {
    const id = topItemAt(this.grid, p.cursor.gx, p.cursor.gz);
    if (!id) return this.tell(p, 'That column is empty.');
    if (!isRemovable(this.grid, id)) return this.tell(p, 'Something is resting on it. Pull the top piece first.');
    const item = this.items.get(id);
    removeFromGrid(this.grid, id);
    this.gridVersion++;
    for (const [pid, amt] of Object.entries(item.earned || {})) { const o = this.players.get(pid); if (o) { o.score -= amt; o.loaded = Math.max(0, o.loaded - 1); } }
    item.earned = {}; item.g = null; item.state = 'carried'; item.carriers = [p.id]; item.x = p.x; item.z = p.z;
    p.carry = id; p.unloading = false; p.cursor.rot = 0;
    this.event({ kind: 'emote', id: p.id, e: '↩️' });
    this.tell(p, `Pulled out the ${ITEM_TYPES[item.type].label.toLowerCase()}. Drop it somewhere better, or BACK to set it on the ground.`);
  }

  respawn(item) {
    const t = ITEM_TYPES[item.type];
    const taken = [...this.items.values()].filter(i => i.state === 'floor').map(i => ({ x: i.x, z: i.z }));
    const spot = freeSpot(this.level, taken);
    Object.assign(item, { state: 'floor', x: spot.x, z: spot.z, wrapped: false, assembled: !!t.needsDisassemble, carriers: [], earned: {}, g: null, task: null });
    this.event({ kind: 'toast', text: `📦 A replacement ${t.label.toLowerCase()} turned up in the ${this.level.roomAt(spot.x, spot.z)}.` });
  }

  dropIntoTruck(p, item) {
    const t = ITEM_TYPES[item.type];
    const loaderIds = [...item.carriers];
    const { gx, gz, rot } = p.cursor;
    const res = placeItem(this.grid, { id: item.id, type: item.type, wrapped: item.wrapped, loaderIds }, gx, gz, rot);
    if (!res.ok) return this.tell(p, res.reason === 'full' ? 'That stack is full — try another column!' : "Won't fit there!");

    for (const id of loaderIds) { const o = this.players.get(id); if (o) { o.carry = null; o.loadMode = false; o.x -= 1.2; } }
    item.carriers = [];

    if (res.selfBroken) {
      item.state = 'broken';
      this.recordBreak(item, loaderIds, 'shattered (it was not pad-wrapped)');
      this.respawn(item);
      return;
    }
    this.gridVersion++;
    item.state = 'loaded';
    const rec = this.grid.items.get(item.id);
    item.g = { x: rec.x, y: rec.y, z: rec.z, w: rec.w, d: rec.d, h: rec.h, ...(ITEM_TYPES[item.type].cells ? { cells: rec.cells } : {}) };
    let pts = t.pts;
    if (t.needsWrap && !item.wrapped) { pts = Math.round(pts / 2); this.event({ kind: 'toast', text: `😬 The ${t.label.toLowerCase()} got scuffed! Half points — pad-wrap next time.` }); }
    const share = Math.round(pts / loaderIds.length);
    item.earned = {};
    for (const id of loaderIds) {
      const o = this.players.get(id);
      if (!o) continue;
      o.score += share; o.loaded += 1; item.earned[id] = share;
      this.event({ kind: 'emote', id, e: `+${share}` });
    }
    for (const bid of res.broken) {
      const b = this.items.get(bid);
      if (!b) continue;
      b.state = 'broken'; b.g = null;
      for (const [id, amt] of Object.entries(b.earned || {})) { const o = this.players.get(id); if (o) o.score -= amt; }
      this.recordBreak(b, loaderIds, 'got crushed');
      this.respawn(b);
    }
  }

  recordBreak(item, culpritIds, how) {
    this.breaks.push({ id: item.id, type: item.type, culpritIds, resolved: false, at: Date.now() });
    for (const id of culpritIds) { const o = this.players.get(id); if (o) o.breaks = (o.breaks || 0) + 1; }
    for (const b of this.bots.values()) b.onCrunch(culpritIds);
    this.seq++;
    this.event({ kind: 'crunch', text: `💥 CRUNCH! A ${ITEM_TYPES[item.type].label.toLowerCase()} ${how}. Who did it? Hit CALL OUT!`, itemType: item.type });
  }

  // ---------- meetings ----------
  callMeeting(callerId) {
    const p = this.players.get(callerId);
    if (this.phase !== 'playing' || this.meeting || !this.isActive(p)) return;
    if (this.game === 'sabotage') {
      const now = Date.now();
      if (now - (p.lastMeeting || 0) < 20000) return this.tell(p, 'You called a meeting recently. Wait a bit.');
      p.lastMeeting = now;
    } else if (!this.breaks.some(b => !b.resolved)) return this.tell(p, 'Nothing is broken… yet. Call out when you hear a CRUNCH!');
    this.phase = 'meeting';
    this.meeting = { callerId, timeLeft: RULES.MEETING_SECONDS, votes: {}, botAt: {} };
    for (const id of this.bots.keys()) if (this.isActive(this.players.get(id))) this.meeting.botAt[id] = 3 + Math.random() * 9;
    for (const o of this.players.values()) { o.task = null; }
    this.event({ kind: 'meeting', caller: p.name });
  }

  castVote(p, t) {
    if (!this.meeting || !p || !this.isActive(p) || this.meeting.votes[p.id]) return;
    if (t !== 'skip' && !this.players.has(t)) return;
    this.meeting.votes[p.id] = t;
  }

  say(p, raw) {
    const text = String(raw || '').replace(/[<>]/g, '').trim().slice(0, 120);
    if (!p || !text) return;
    const now = Date.now();
    if (!p.bot && now - (p.lastChat || 0) < 600) return;
    p.lastChat = now;
    this.broadcast('chat', { from: p.name, char: p.char, text, meeting: !!this.meeting, bot: !!p.bot });
  }

  updateMeeting(dt) {
    const m = this.meeting;
    m.timeLeft -= dt;
    for (const [id, at] of Object.entries(m.botAt)) {
      m.botAt[id] = at - dt;
      if (m.botAt[id] > 0) continue;
      delete m.botAt[id];
      const bot = this.bots.get(id), p = this.players.get(id);
      if (!bot || !p) continue;
      const target = bot.meetingVote();
      if (Math.random() < 0.6) this.say(p, bot.meetingLine(target));
      this.castVote(p, target);
    }
    const active = this.activePlayers();
    if (m.timeLeft > 0 && !active.every(a => m.votes[a.id])) return;

    const target = tallyVotes(m.votes, m.callerId);
    const caller = this.players.get(m.callerId);
    if (this.game === 'sabotage') return this.resolveSabotageVote(target, m.votes);
    const open = this.breaks.filter(b => !b.resolved);
    const guilty = target !== 'skip' && open.some(b => b.culpritIds.includes(target));
    let penalized, text;
    if (guilty) {
      penalized = this.players.get(target);
      open.filter(b => b.culpritIds.includes(target)).forEach(b => { b.resolved = true; });
      text = `✅ Correct! ${penalized?.name} broke it. −${RULES.PENALTY} and a strike.`;
    } else {
      penalized = caller;
      const who = target === 'skip' ? 'Nobody was voted out' : `${this.players.get(target)?.name} was innocent`;
      text = `❌ ${who}! ${caller?.name || 'The caller'} takes −${RULES.PENALTY} and a strike for the false alarm.`;
    }
    if (penalized) {
      penalized.score -= RULES.PENALTY;
      penalized.strikes += 1;
      if (penalized.strikes >= RULES.MAX_STRIKES) {
        penalized.out = true;
        this.releaseCarry(penalized);
        text += ` ${penalized.name} is OFF THE TRUCK! 🚪`;
      }
    }
    this.event({ kind: 'verdict', text, target, guilty, penalizedId: penalized?.id, votes: m.votes });
    this.meeting = null;
    this.phase = 'playing';
  }

  resolveSabotageVote(target, votes) {
    this.meeting = null;
    this.phase = 'playing';
    const t = target !== 'skip' ? this.players.get(target) : null;
    if (!t) { this.event({ kind: 'verdict', text: '🤷 No one was voted off. Back to work!', votes }); return; }
    if (t.saboteur) {
      this.event({ kind: 'verdict', text: `🎯 ${t.name} WAS the saboteur! The crew wins!`, guilty: true, votes });
      return this.endRound(`The crew caught the saboteur: ${t.name}!`, null, 'crew');
    }
    t.out = true;
    this.releaseCarry(t);
    this.event({ kind: 'verdict', text: `😬 ${t.name} was NOT the saboteur. They're off the truck.`, guilty: false, votes });
    if (!this.activePlayers().some(p => !p.saboteur)) this.endRound('The saboteur outlasted the crew!', null, 'saboteur');
  }

  // ---------- end ----------
  checkEnd() {
    const all = [...this.items.values()];
    const remaining = all.filter(i => i.state === 'floor' || i.state === 'carried');
    let filled = 0;
    for (const col of this.grid.cells) for (const stack of col) for (const c of stack) if (c) filled++;
    if (this.fitCache?.v !== this.gridVersion || this.fitCache?.n !== remaining.length) {
      this.fitCache = { v: this.gridVersion, n: remaining.length, fits: canFitAny(this.grid, remaining.map(i => i.type)) };
    }
    let doneReason = null;
    if (this.isExact()) {
      if (filled === GRID.W * GRID.D * GRID.H) doneReason = 'Perfect load! The truck is packed to the roof.';
      else if (remaining.length && !this.fitCache.fits && !this.stuckHinted) {
        this.stuckHinted = true;
        this.event({ kind: 'toast', text: '🧩 Nothing else fits! Hold ACTION on the ramp to pull pieces back out and repack.' });
      }
      if (this.fitCache.fits) this.stuckHinted = false;
    } else if (!remaining.length) doneReason = 'Truck loaded!';
    else if (!this.fitCache.fits) doneReason = 'Truck full! Nothing else fits.';
    const done = !!doneReason;
    const humans = [...this.players.values()].filter(p => !p.bot && !p.spectator);
    const noneLeft = (this.activePlayers().length === 0 && this.players.size > 0) || (humans.length > 0 && humans.every(h => h.out) && this.bots.size > 0);
    if (this.game === 'sabotage') {
      if (done) return this.endRound('Perfect load! The crew beat the saboteur.', null, 'crew');
      if (this.timeLeft <= 0) {
        if (!this.overtime) { this.overtime = true; this.event({ kind: 'toast', text: '⏰ Overtime! The crew score is draining. Finish the load before it hits zero!' }); }
        this.drain += 4 * this.lastDt;
        if (this.crewScore() <= 0) return this.endRound('The crew score hit zero. The saboteur wins!', null, 'saboteur');
      }
      if (!this.activePlayers().some(p => !p.saboteur)) return this.endRound('The saboteur outlasted the crew!', null, 'saboteur');
      return;
    }
    if (this.timeLeft <= 0 || done || noneLeft) this.endRound(done ? doneReason : noneLeft ? 'Everyone got kicked off the truck!' : "Time's up!");
  }

  endRound(reason, forcedWinnerId = null, winners = null) {
    this.phase = 'results';
    const players = [...this.players.values()].filter(p => !p.spectator)
      .map(p => ({ id: p.id, name: p.name, char: p.char, score: p.score, strikes: p.strikes, out: p.out, loaded: p.loaded, breaks: p.breaks || 0, bot: !!p.bot }))
      .sort((a, b) => b.score - a.score);
    const sab = [...this.players.values()].find(p => p.saboteur);
    let winner = (forcedWinnerId && players.find(p => p.id === forcedWinnerId)) || players.find(p => !p.out) || null;
    if (winners === 'saboteur' && sab) winner = players.find(p => p.id === sab.id) || winner;
    if (winners === 'crew') winner = players.find(p => sab ? p.id !== sab.id : true) || winner;
    const loaded = [...this.items.values()].filter(i => i.state === 'loaded');
    const teamTotal = loaded.reduce((s, i) => s + Object.values(i.earned || {}).reduce((a, b) => a + b, 0), 0);
    const unresolved = this.breaks.filter(b => !b.resolved).map(b => ({
      type: ITEM_TYPES[b.type].label,
      culprits: b.culpritIds.map(id => this.players.get(id)?.name || 'a mover who left').join(' + '),
    }));
    this.results = { reason, players, winnerId: winner?.id || null, teamTotal, unresolved, loadedCount: loaded.length, totalItems: this.items.size, broken: this.breaks.length, difficulty: this.bots.size ? this.difficulty : null,
      game: this.game, winners, saboteurId: sab?.id || null, saboteurName: sab?.name || null, crewScore: this.game === 'sabotage' ? this.crewScore() : null };
    for (const p of this.players.values()) { p.carry = null; p.loadMode = false; p.task = null; }
    this.event({ kind: 'end' });
    this.recordResults();
  }

  /** Save stats + leaderboard entries for human players (never blocks the game). */
  recordResults() {
    const store = MoveRoom.store, r = this.results;
    if (!store || !r) return;
    store.event('round_end').catch(() => {});
    for (const p of this.players.values()) {
      if (p.bot || p.spectator || !p.email) continue;
      const won = r.game === 'sabotage' ? (r.winners === 'saboteur' ? p.id === r.saboteurId : p.id !== r.saboteurId && r.winners === 'crew') : r.winnerId === p.id;
      store.recordGame(p.email, { won, loaded: p.loaded }).catch(() => {});
      if (this.level?.daily) store.addScore({ day: this.level.daily, email: p.email, name: p.name, score: p.score, detail: `${this.level.name} · ${this.mode === 'load' ? 'Full load' : this.mode}` }).catch(() => {});
    }
  }

  onUncaughtException(err, method) {
    console.error('room error in', method, err);
    MoveRoom.store?.logError({ where: 'room:' + method, message: err.message, stack: err.stack, ua: '' }).catch(() => {});
  }

  snapshot() {
    const players = [...this.players.values()].map(p => ({
      id: p.id, name: p.name, char: p.char, x: +p.x.toFixed(2), z: +p.z.toFixed(2), face: +p.face.toFixed(2),
      carry: p.carry, loadMode: p.loadMode, cursor: p.loadMode ? p.cursor : null, score: p.score, strikes: p.strikes,
      out: p.out, spectator: p.spectator, task: p.task, unloading: !!p.unloading, dashCd: +p.dashCd.toFixed(1), dashing: p.dashT > 0,
      room: this.level.roomAt(p.x, p.z), bot: !!p.bot, away: !!p.away,
    }));
    const items = [...this.items.values()].filter(i => i.state !== 'broken').map(i => ({
      id: i.id, type: i.type, x: +i.x.toFixed(2), z: +i.z.toFixed(2), state: i.state, wrapped: i.wrapped,
      assembled: i.assembled, g: i.g, n: i.carriers.length,
      task: i.task ? { kind: i.task.kind, p: +i.task.progress.toFixed(2) } : null,
    }));
    return {
      phase: this.phase, mode: this.mode, hostId: this.hostId, timeLeft: Math.max(0, Math.round(this.timeLeft)),
      countdown: this.phase === 'countdown' ? Math.ceil(this.countdown) : 0,
      game: this.game, overtime: !!this.overtime, crewScore: this.game === 'sabotage' ? this.crewScore() : null,
      level: { seed: this.level.seed, classic: !!this.level.classic, exact: !!this.level.exact, name: this.level.name, rooms: this.level.rooms.length, yard: this.level.yardDistance }, difficulty: this.difficulty, solo: this.solo,
      loadedCount: [...this.items.values()].filter(i => i.state === 'loaded').length, totalItems: this.items.size,
      players, items, cat: { x: +this.cat.x.toFixed(2), z: +this.cat.z.toFixed(2), face: this.cat.face || 0 },
      openBreaks: this.breaks.filter(b => !b.resolved).length,
      meeting: this.meeting ? { callerId: this.meeting.callerId, timeLeft: Math.ceil(this.meeting.timeLeft), voted: Object.keys(this.meeting.votes) } : null,
      results: this.phase === 'results' ? this.results : null,
    };
  }
}
