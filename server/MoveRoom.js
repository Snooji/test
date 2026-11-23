import { Room, ServerError } from 'colyseus';
import { createGrid, placeItem, tallyVotes, ITEM_TYPES, RULES, GRID, footprint, orientations, ORIENT_LABEL, canFitAny, isRemovable, removeFromGrid, topItemAt, SUITS, suitUnlocked, dailySeed, driveOffCheck, placementQuality } from '../shared/logic.js';
import { Bot, BOT_NAMES, DIFFICULTY } from './bot.js';
import { PLAYER_SPAWNS, inRamp, TRUCK } from '../shared/world.js';
import { generateLevel, classicLevel, newSeed, freeSpot, tutorialLevel } from '../shared/level.js';
import { createNav } from './nav.js';
import { verifyToken, cleanName, cleanEmail } from './signups.js';

import { CLASSIC_IDS, ALL_CHAR_IDS, charUnlocked, rosterEntry, unlockText } from '../shared/roster.js';
const CHARS = CLASSIC_IDS; // defaults + AI movers
const SPEED = 5;
const R = 0.45;           // player radius
const SEP_STEP = 0.025;     // max push per tick when two movers overlap (well under walking pace)
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
    this.tutorialMode = !!options.tutorial;
    this.dollyOn = options.dolly !== false;
    this.quick = !!options.quick;
    this.daily = /^\d{4}-\d{2}-\d{2}$/.test(options.daily || '') ? options.daily : null;
    this.twist = ['zerog', 'mansion'].includes(options.twist) ? options.twist : 'none';
    if (this.daily) { this.seedOverride = dailySeed(this.daily); this.soloPending = true; this.solo = true; }
    if (this.quick) { this.soloPending = true; this.autoStartAt = 0; }
    if (this.tutorialMode) { this.soloPending = false; this.solo = true; }
    this.zeroG = false; this.zeroT = 0;
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
      if (!ALL_CHAR_IDS.includes(m?.id) || [...this.players.values()].some(o => o !== p && o.char === m.id)) return;
      if (!charUnlocked(m.id, p.profile)) return this.tell(p, `🔒 ${rosterEntry(m.id)?.name} unlocks when you ${unlockText(m.id).toLowerCase()}.`);
      p.char = m.id;
    });
    this.onMessage('mode', (c, m) => {
      if (c.sessionId !== this.hostId || !RULES.MODES[m?.mode] || this.inRound()) return;
      const wasExact = this.isExact();
      this.mode = m.mode;
      if (this.isExact() !== wasExact && !this.classic) { this.newLevel(); this.resetWorld(); } // Full load needs an exact-fill house
    });
    this.onMessage('start', (c) => {
      if (c.sessionId !== this.hostId || this.inRound()) return;
      if (this.phase === 'lobby') {
        const waiting = [...this.players.values()].filter(o => !o.bot && !o.spectator && o.id !== this.hostId && !o.ready);
        if (waiting.length) { this.tell(this.players.get(c.sessionId), `Waiting for ${waiting.map(o => o.name).join(', ')} to ready up.`); return; }
      }
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
      this.onMessage('debug_end', () => { if (this.phase === 'playing') this.timeLeft = 0.01; });
      this.onMessage('debug_tp', (c, m) => { const p = this.players.get(c.sessionId); if (p) { p.x = Number(m.x); p.z = Number(m.z); } });
      this.onMessage('debug_tutorial_done', () => { if (this.tutorial && this.phase === 'playing') this.endRound('Training complete! You’re ready for a real move.'); });
      this.onMessage('debug_place', (c, m) => { // load an item straight into the truck (for drive-off tests)
        const p = this.players.get(c.sessionId);
        const it = [...this.items.values()].find(i => i.state === 'floor' && i.type === m?.type);
        if (!p || !it) return;
        it.wrapped = true; it.assembled = false; it.state = 'carried'; it.carriers = [p.id]; p.carry = it.id;
        p.cursor = { gx: m.gx | 0, gz: m.gz | 0, rot: m.rot | 0 };
        this.dropIntoTruck(p, it);
      });
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
    // results screen: everyone confirms "restart" → next round with a fresh house
    this.onMessage('ready', (c) => {
      const p = this.players.get(c.sessionId);
      if (!p || (this.phase !== 'results' && this.phase !== 'lobby')) return;
      p.ready = !p.ready;
      if (this.phase === 'lobby') return; // in the lobby the crew chief starts once everyone is ready
      const humans = [...this.players.values()].filter(o => !o.bot);
      if (humans.length && humans.every(o => o.ready)) { this.newLevel(); this.startRound(); }
    });
    this.onMessage('twist', (c, m) => {
      if (!hostInLobby(c) || !['none', 'zerog', 'mansion'].includes(m?.twist) || this.daily || this.tutorialMode) return;
      const was = this.twist; this.twist = m.twist;
      if ((was === 'mansion') !== (this.twist === 'mansion') && !this.classic) { this.newLevel(); this.resetWorld(); }
      else this.level.twist = this.twist;
    });
    this.onMessage('suit', (c, m) => {
      const p = this.players.get(c.sessionId);
      if (p && suitUnlocked(m?.id, p.profile)) p.suit = m.id;
    });
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
    const asked = ALL_CHAR_IDS.includes(options?.char) && !used.has(options.char) ? options.char : null;
    const want = asked && charUnlocked(asked, null) ? asked : CHARS.find(c => !used.has(c)) || 'nova';
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
    if (this.tutorialMode && !this.bots.size) { const c = this.addBot(); if (c) { c.name = 'Coach'; this.bots.get(c.id).coach = true; } }
    if (this.quick && this.phase === 'lobby' && !this.autoStartAt) this.autoStartAt = 30;
    p.suit = 'classic'; p.profile = { games: 0, wins: 0 };
    const wish = asked && asked !== want ? asked : null; // an unlockable mover: confirm once their profile has loaded
    if (MoveRoom.store && auth.email) MoveRoom.store.getProfile(auth.email).then(pr => {
      p.profile = pr;
      if (wish && charUnlocked(wish, pr) && ![...this.players.values()].some(o => o !== p && o.char === wish) && this.phase !== 'playing') p.char = wish;
    }).catch(() => {});
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
    for (const b of this.bots.values()) b.hear?.(item); // everyone hears a 🆘
    const label = ITEM_TYPES[item.type].label.toLowerCase();
    this.event({ kind: 'help', id: p.id, name: p.name, item: label, x: +item.x.toFixed(1), z: +item.z.toFixed(1), text: `🆘 ${p.name} needs a hand with the ${label}! Lift the other end and split the points.` });
    return true;
  }

  // ---------- world ----------
  newLevel() {
    this.level = this.tutorialMode ? tutorialLevel()
      : this.classic ? classicLevel()
      : generateLevel(this.seedOverride ?? newSeed(), { exact: this.isExact(), mansion: this.twist === 'mansion' });
    if (this.daily) this.level.daily = this.daily; else this.seedOverride = null;
    this.level.twist = this.twist;
    this.nav = createNav(this.level);
    this.cat = { x: this.level.cat[0][0], z: this.level.cat[0][1], wp: 0 };
  }

  loadedCountCache() { let n = 0; for (const i of this.items.values()) if (i.state === 'loaded') n++; return n; }

  isExact() { return this.mode === 'load' || this.game === 'sabotage'; }
  allowsUnload() { return !this.tutorialMode; }

  resetWorld() {
    this.items.clear();
    this.gridVersion = 0; this.fitCache = null; this.stuckHinted = false;
    this.grid = createGrid();
    this.breaks = [];
    this.meeting = null;
    if (this.dollyOn && !this.tutorialMode) {
      const spot = freeSpot(this.level, this.level.items.map(([, x, z]) => ({ x, z })));
      this.items.set('dolly', { id: 'dolly', type: 'dolly', x: spot.x, z: spot.z, state: 'floor', stack: [], uses: 0, strainT: 0, strain: 0, pusher: null, carriers: [], earned: {}, task: null, helpers: [], g: null });
    }
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
    this.timeLeft = this.tutorialMode ? 3600 : RULES.MODES[this.mode] + (this.twist === 'mansion' && this.mode !== 'load' ? 60 : 0);
    this.tutorial = this.tutorialMode ? { step: -1 } : null;
    this.autoStartAt = 0; this.zeroG = false; this.zeroT = 0;
    if (this.quick && this.listing) Promise.resolve().then(() => this.lock()).catch(() => {}); // stop Quick Play matching into a live round
    for (const p of this.players.values()) Object.assign(p, { unloads: 0, helps: 0, wraps: 0, rampSlot: -1, ready: false, dolly: null, feeding: false, tripPlaced: 0 });
    this.results = null;
    for (const b of this.bots.values()) b.reset();
    this.overtime = false; this.drain = 0; this.driveoff = null; this.pendingEnd = null; this.resultsT = 0; this.tally = null;
    for (const p of this.players.values()) { p.saboteur = false; p.lastMeeting = 0; }
    if (this.game === 'sabotage') {
      const movers = this.movers();
      movers[Math.floor(Math.random() * movers.length)].saboteur = true;
      for (const p of movers) this.sendRole(p);
    }
    this.phase = 'countdown';
    this.countdown = 3;
    if (!this.demo) MoveRoom.store?.event('round_start').catch(() => {});
    this.roundHumans = [...this.players.values()].filter(p => !p.bot && !p.spectator).length;
    this.event({ kind: 'start' });
  }

  canCallOut() { return this.movers().length > 2; }

  isActive(p) { return p && !p.out && !p.spectator; }
  activePlayers() { return [...this.players.values()].filter(p => this.isActive(p)); }
  event(e) { this.broadcast('evt', e); }
  tell(p, text) { const c = this.clients.find(c => c.sessionId === p.id); c?.send('evt', { kind: 'toast', text, private: true }); }

  // ---------- simulation ----------
  tick(dt) {
    this.lastDt = dt;
    this.elapsed = (this.elapsed || 0) + dt;
    this.moveCat(dt);
    if (this.phase === 'countdown') {
      this.countdown -= dt;
      if (this.countdown <= 0) { this.phase = 'playing'; this.event({ kind: 'go' }); if (this.tutorial) this.updateTutorial(); }
    } else if (this.phase === 'playing') {
      this.timeLeft -= dt;
      for (const b of this.bots.values()) b.think(dt);
      for (const p of this.players.values()) this.updatePlayer(p, dt);
      this.separate();
      this.updateTeamCarries(dt);
      this.updateTasks(dt);
      this.updateDollies(dt);
      this.updateDecay(dt);
      if (this.twist === 'zerog') this.updateZeroG(dt);
      if (this.tutorial) this.updateTutorial();
      this.checkEnd();
    } else if (this.phase === 'meeting') {
      this.updateMeeting(dt);
    } else if (this.phase === 'driveoff') {
      if ((this.driveT -= dt) <= 0) { const [r, f, w] = this.pendingEnd; this.finishRound(r, f, w); }
    } else if (this.phase === 'results' && this.quick) {
      this.resultsT = (this.resultsT || 0) + dt;
      if (this.resultsT > 15) { this.resultsT = 0; this.phase = 'lobby'; this.newLevel(); this.resetWorld(); this.autoStartAt = 30; }
    } else if (this.phase === 'lobby') {
      for (const p of this.players.values()) this.freeMove(p, dt, 1);
      this.separate();
      if (this.quick && this.autoStartAt > 0 && (this.autoStartAt -= dt) <= 0) { this.autoStartAt = 0; this.startRound(); }
    }
    for (const p of this.players.values()) { p.pending.tapN = 0; p.pending.dashN = 0; p.pending.rotN = 0; }
    // the menu's demo game streams at ~7 Hz; real games at 20 Hz
    if (!this.demo || (this.demoTick = (this.demoTick || 0) + 1) % 3 === 0) this.broadcast('snap', this.snapshot());
  }

  /** Zero-G twist: every 25 s gravity cuts out for 6 s; loose items drift and movers float faster. */
  updateZeroG(dt) {
    this.zeroT += dt;
    const was = this.zeroG;
    this.zeroG = (this.zeroT % 25) > 19;
    if (this.zeroG && !was) this.event({ kind: 'toast', text: '🪐 Gravity is failing! Loose boxes are drifting…' });
    if (!this.zeroG) return;
    for (const it of this.items.values()) {
      if (it.state !== 'floor') continue;
      it.vx = (it.vx || 0) * 0.98 + (Math.random() - 0.5) * 0.6 * dt; it.vz = (it.vz || 0) * 0.98 + (Math.random() - 0.5) * 0.6 * dt;
      const nx = it.x + it.vx, nz = it.z + it.vz;
      if (!this.level.hitsWall(nx, it.z, 0.55) && !inRamp(nx, it.z)) it.x = nx; else it.vx = -it.vx;
      if (!this.level.hitsWall(it.x, nz, 0.55) && !inRamp(it.x, nz)) it.z = nz; else it.vz = -it.vz;
    }
  }

  // ---------- training ----------
  updateTutorial() {
    const T = this.tutorial;
    const human = [...this.players.values()].find(p => !p.bot);
    if (!human) return;
    const it = (type) => [...this.items.values()].find(i => i.type === type);
    // short lines; {ACT} {ROT} {HELP} become the right button for each device on the client
    const steps = [
      { text: 'Walk to the box. Tap {ACT} to pick it up.', target: 'standard', done: () => human.carry === it('standard').id || it('standard').state === 'loaded' },
      { text: 'Take it to the truck. Follow the arrow.', target: 'ramp', done: () => human.loadMode || it('standard').state === 'loaded' },
      { text: 'Move to aim. Tap {ACT} to drop it in.', target: 'ramp', done: () => it('standard').state === 'loaded' },
      { text: 'Heavy box next. Heavy goes on the bottom.', target: 'heavy', done: () => it('heavy').state === 'loaded' },
      { text: 'Fragile box next. Put it on top of a box.', target: 'fragile', done: () => it('fragile').state === 'loaded' },
      { text: 'Hold {ACT} next to the lamp to wrap it.', target: 'lamp', done: () => it('lamp').wrapped || it('lamp').state === 'loaded' },
      { text: 'Load the lamp. Tap {ROT} to turn it.', target: 'lamp', done: () => it('lamp').state === 'loaded' },
      { text: 'Grab the couch. Tap {HELP} to call the Coach.', target: 'couch', done: () => it('couch').carriers.length === 2 || it('couch').state === 'loaded' },
      { text: 'Carry the couch to the truck together.', target: 'couch', done: () => it('couch').state === 'loaded' },
    ];
    let step = Math.max(0, T.step);
    while (step < steps.length && steps[step].done()) step++;
    // point at the item, or at the truck once you're holding it
    if (step < steps.length) {
      const tt = steps[step].target, item = tt && tt !== 'ramp' ? it(tt) : null;
      T.target = tt === 'ramp' || (item && (item.carriers.includes(human.id))) ? 'ramp' : item ? item.id : null;
    }
    if (step !== T.step) {
      T.step = step;
      if (step >= steps.length) { this.event({ kind: 'tutorial', step, total: steps.length, done: true }); return this.endRound('Training complete! You’re ready for a real move.'); }
      T.text = steps[step].text; T.targetType = steps[step].target; T.total = steps.length;
      this.event({ kind: 'tutorial', step, total: steps.length, text: T.text });
    }
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
      const push = Math.min((MIN - d) / 2, SEP_STEP), ux = dx / d * push, uz = dz / d * push;
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
      const dly = this.dollyOf(p);
      if (dly) mult *= dly.stack.some(id => ITEM_TYPES[this.items.get(id)?.type]?.heavy) ? 0.7 : 0.85;
      this.freeMove(p, dt, mult);
      if (item) { item.x = p.x + Math.sin(p.face) * 0.2; item.z = p.z + Math.cos(p.face) * 0.2; }
      if (dly) { dly.x = p.x + Math.sin(p.face) * 0.9; dly.z = p.z + Math.cos(p.face) * 0.9; }
    }

    // pushing a loaded dolly onto the ramp: boxes come off top first, one at a time
    if (p.rampLock && !inRamp(p.x, p.z) && !(item && inRamp(item.x, item.z))) p.rampLock = false;
    const dly2 = this.dollyOf(p);
    if (dly2 && !item && dly2.stack.length && inRamp(p.x, p.z) && !p.rampLock) {
      p.tripPlaced = 0;
      this.feedFromDolly(p);
      p.cursorCd = 0.35;
      this.takeRampSlot(p);
      this.tell(p, `Unloading the dolly: ${dly2.stack.length + 1} box${dly2.stack.length ? 'es' : ''}, top first. Aim and drop each one.`);
      return;
    }

    // empty-handed on the ramp: hold ACTION to start pulling items back out (Full load only)
    if (!item && this.allowsUnload() && inRamp(p.x, p.z) && p.in.hold && this.grid.items.size) {
      p.unloadT = (p.unloadT || 0) + dt;
      if (p.unloadT > 0.6) {
        p.unloadT = 0; p.loadMode = true; p.unloading = true; p.cursor = { gx: 1, gz: 1, rot: 0 }; p.cursorCd = 0.35;
        this.takeRampSlot(p);
        this.tell(p, 'Unloading: aim at a stack, ACTION pulls the top piece, BACK to leave');
      }
      return;
    } else p.unloadT = 0;

    // carrying into the ramp → load mode (leader only for team carries)
    if (item && item.carriers[0] === p.id && inRamp(item.x, item.z) && !p.rampLock) {
      p.loadMode = true;
      p.cursor = { gx: 1, gz: 0, rot: 0 };
      this.takeRampSlot(p);
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
    if (p.dolly) return this.dollyTap(p);
    const target = this.nearestItem(p);
    if (!target) return;
    const t = ITEM_TYPES[target.type];
    if (target.type === 'dolly') {
      target.state = 'pushed'; target.pusher = p.id; p.dolly = target.id;
      this.event({ kind: 'emote', id: p.id, e: '🛒' });
      this.tell(p, 'Dolly! Tap next to boxes to stack up to 3. Push it to the truck to unload them.');
      return;
    }
    if (target.assembled) return this.tell(p, `Hold ACTION to disassemble the ${t.label.toLowerCase()} first`);
    if (t.teamCarry) {
      if (target.state === 'carried') {
        if (target.carriers.length >= 2) return;
        if (this.players.get(target.carriers[0])?.loadMode) return; // already being placed in the truck
        target.carriers.push(p.id); p.carry = target.id; p.helps = (p.helps || 0) + 1;
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
      if (it.type === 'dolly' && (p.bot || it.state !== 'floor')) continue; // AI movers leave the dolly alone
      if (it.state !== 'floor' && !(it.state === 'carried' && ITEM_TYPES[it.type].teamCarry && it.carriers.length === 1)) continue;
      const t = ITEM_TYPES[it.type], len = Math.max(t.w, t.d);
      const d = dist(p, it) - (len > 1 ? len * 0.35 : 0);
      if (d < bd) { bd = d; best = it; }
    }
    return best;
  }

  // ---------- the dolly ----------
  dollyOf(p) { return p.dolly ? this.items.get(p.dolly) : null; }

  dollyTap(p) {
    const d = this.dollyOf(p);
    let box = null, bd = REACH;
    for (const it of this.items.values()) {
      if (it.state !== 'floor' || !['standard', 'heavy', 'fragile'].includes(it.type)) continue;
      const dd = dist(p, it); if (dd < bd) { bd = dd; box = it; }
    }
    if (box && d.stack.length < 3) {
      box.state = 'dolly'; box.dollyId = d.id; box.carriers = [];
      d.stack.push(box.id);
      this.event({ kind: 'emote', id: p.id, e: ITEM_TYPES[box.type].heavy ? '😤' : '📦' });
      return;
    }
    if (box) return this.tell(p, 'The dolly is full (3 boxes). Push it to the truck.');
    // nothing to stack: set the dolly down (boxes stay on it)
    this.dropDolly(p);
  }

  dropDolly(p) {
    const d = this.dollyOf(p);
    p.dolly = null;
    if (!d) return;
    d.state = 'floor'; d.pusher = null;
    if (this.level.hitsWall(d.x, d.z, 0.4) || inRamp(d.x, d.z)) { d.x = p.x - 1; d.z = p.z; }
  }

  /** next box off the dolly (top of the stack) into your hands, in the truck */
  feedFromDolly(p) {
    const d = this.dollyOf(p);
    const id = d?.stack.pop();
    if (!id) return false;
    const box = this.items.get(id);
    box.state = 'carried'; box.carriers = [p.id]; box.dollyId = null; box.x = p.x; box.z = p.z;
    p.carry = id; p.loadMode = true; p.feeding = true;
    p.cursor = { gx: p.cursor?.gx ?? 1, gz: p.cursor?.gz ?? 0, rot: 0 };
    return true;
  }

  finishDollyTrip(p) {
    const d = this.dollyOf(p);
    p.feeding = false;
    if (!d || !p.tripPlaced) return;
    p.tripPlaced = 0;
    d.uses += 1;
    if (d.uses >= 2) { // a wheel pops off; a fresh dolly turns up somewhere else
      for (const id of d.stack) { const b = this.items.get(id); if (b) { b.state = 'floor'; b.dollyId = null; b.x = p.x - 1.2; b.z = p.z; } }
      p.dolly = null;
      const spot = freeSpot(this.level, [...this.items.values()].filter(i => i.state === 'floor').map(i => ({ x: i.x, z: i.z })));
      Object.assign(d, { x: spot.x, z: spot.z, state: 'floor', stack: [], uses: 0, strainT: 0, strain: 0, pusher: null });
      this.event({ kind: 'toast', text: `🛒 The dolly lost a wheel! A fresh one turned up in the ${this.level.roomAt(spot.x, spot.z)}.` });
    }
  }

  /** pieces pulled out of the truck and left outside lose value (5 s grace, then ~30 s to zero) and finally rot */
  updateDecay(dt) {
    for (const it of this.items.values()) {
      if (!it.pulled || it.state !== 'floor') continue;
      it.outsideT = (it.outsideT || 0) + dt;
      if (it.outsideT < 5) continue;
      it.value = Math.max(0, (it.value ?? 1) - dt / 30);
      if (it.value > 0) continue;
      const label = ITEM_TYPES[it.type].label.toLowerCase();
      it.rottedOnce = true;
      this.respawn(it);
      this.event({ kind: 'toast', text: `🍂 A ${label} sat outside the truck too long and rotted away. A new one is back in the house.` });
    }
  }

  /** a heavy box riding on a fragile/standard box too long crushes it */
  updateDollies(dt) {
    for (const d of this.items.values()) {
      if (d.type !== 'dolly' || d.stack.length < 2) { if (d.type === 'dolly') { d.strainT = 0; d.strain = 0; } continue; }
      let under = null;
      for (let i = 1; i < d.stack.length; i++) {
        const top = this.items.get(d.stack[i]), below = this.items.get(d.stack[i - 1]);
        if (ITEM_TYPES[top.type].heavy && !ITEM_TYPES[below.type].heavy) { under = below; break; }
      }
      if (!under) { d.strainT = 0; d.strain = 0; continue; }
      const limit = ITEM_TYPES[under.type].fragile ? 6 : 10;
      d.strainT += dt; d.strain = +(d.strainT / limit).toFixed(2);
      if (d.strainT < limit) continue;
      d.strainT = 0; d.strain = 0;
      d.stack = d.stack.filter(id => id !== under.id);
      const who = this.players.get(d.pusher) ? [d.pusher] : [];
      for (const id of who) this.players.get(id).score -= ITEM_TYPES[under.type].pts;
      under.state = 'broken'; under.dollyId = null;
      this.recordBreak(under, who, 'got crushed on the dolly');
      this.respawn(under);
    }
  }

  releaseCarry(p) {
    if (p.dolly && !p.carry) { this.dropDolly(p); p.loadMode = false; return; }
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
      if (cs.length < 2) { item.axis = undefined; continue; }
      if (cs[0].loadMode) continue;
      let mx = 0, mz = 0;
      for (const c of cs) { mx += c.in.mx; mz += c.in.mz; }
      mx /= cs.length; mz /= cs.length;
      const off = this.carryOffset(item);
      if (item.axis === undefined) item.axis = Math.atan2(cs[1].z - cs[0].z, cs[1].x - cs[0].x);
      const spots = (x, z, a) => [[x - Math.cos(a) * off, z - Math.sin(a) * off], [x + Math.cos(a) * off, z + Math.sin(a) * off]];
      const clear = (x, z, a) => !this.level.hitsWall(x, z, 0.45) && spots(x, z, a).every(([sx, sz]) => !this.level.hitsWall(sx, sz, R * 0.8));
      const stuckNow = !clear(item.x, item.z, item.axis); // squeezed already: allow any move that doesn't hit the furniture itself
      const ok = (x, z, a) => clear(x, z, a) || (stuckNow && !this.level.hitsWall(x, z, 0.45));
      const moving = Math.abs(mx) + Math.abs(mz) > 0.05;
      if (moving) { // swing the pole round toward the walking line (either end can lead)
        let want = Math.atan2(mz, mx), diff = ((want - item.axis) % Math.PI + Math.PI * 1.5) % Math.PI - Math.PI / 2;
        const turn = Math.sign(diff) * Math.min(Math.abs(diff), 1.6 * dt);
        if (turn && ok(item.x, item.z, item.axis + turn)) item.axis += turn;
      }
      const sp = SPEED * 0.7 * dt;
      const nx = item.x + mx * sp, nz = item.z + mz * sp;
      if (ok(nx, item.z, item.axis)) item.x = nx;
      if (ok(item.x, nz, item.axis)) item.z = nz;
      const sp2 = spots(item.x, item.z, item.axis), maxStep = SPEED * dt;
      cs.slice(0, 2).forEach((c, k) => { // walk into position; never jump
        const [tx, tz] = sp2[k], dx = tx - c.x, dz = tz - c.z, d = Math.hypot(dx, dz);
        const nx2 = d <= maxStep ? tx : c.x + dx / d * maxStep, nz2 = d <= maxStep ? tz : c.z + dz / d * maxStep;
        if (!this.level.hitsWall(nx2, nz2, R * 0.8)) { c.x = nx2; c.z = nz2; }
        c.face = moving ? Math.atan2(mx, mz) : Math.atan2(item.x - c.x, item.z - c.z);
      });
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
        for (const id of it.task.contributors) { const h = this.players.get(id); if (h) { h.score += RULES.HELPER_BONUS; h.wraps = (h.wraps || 0) + 1; } }
        this.event({ kind: 'toast', text: `${kind === 'wrap' ? '🧣 Pad-wrapped' : '🔧 Disassembled'} the ${t.label.toLowerCase()}! +${RULES.HELPER_BONUS} each` });
        it.task = null;
      }
    }
  }

  updateLoadMode(p, item, dt) {
    if (!item && !p.unloading) { p.loadMode = false; return; }
    if (p.slotTo) { // walk over to our spot on the ramp at normal pace (no teleports)
      const dx = p.slotTo[0] - p.x, dz = p.slotTo[1] - p.z, d = Math.hypot(dx, dz), st = SPEED * dt;
      if (d <= st) { p.x = p.slotTo[0]; p.z = p.slotTo[1]; p.slotTo = null; } else { p.x += dx / d * st; p.z += dz / d * st; }
      if (item && item.carriers.length < 2) { item.x = p.x; item.z = p.z; }
    }
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
      if (p.pending.dashN) { p.loadMode = false; p.unloading = false; p.rampLock = true; p.slotTo = null; return; }
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

    if (p.pending.dashN && p.feeding) { // BACK: the box goes back on top of the dolly
      const d = this.dollyOf(p);
      item.state = 'dolly'; item.dollyId = d.id; item.carriers = []; d.stack.push(item.id);
      p.carry = null; p.loadMode = false; p.rampLock = true; p.slotTo = null;
      this.finishDollyTrip(p);
      return;
    }
    if (p.pending.dashN) { // BACK out of the truck: step off the ramp so it doesn't re-trigger
      p.loadMode = false; p.rampLock = true; p.slotTo = null;
      return;
    }
    if (p.pending.tapN) this.dropIntoTruck(p, item);
  }

  /** Movers aiming in the truck each stand in their own spot on the ramp. */
  takeRampSlot(p) {
    const SLOTS = [[11.4, -1.7], [11.4, -0.55], [11.4, 0.6], [11.4, 1.75]];
    const used = new Set([...this.players.values()].filter(o => o !== p && o.loadMode).map(o => o.rampSlot));
    const i = SLOTS.findIndex((_, k) => !used.has(k));
    p.rampSlot = i;
    if (i < 0) return;
    const item = p.carry ? this.items.get(p.carry) : null;
    if (item && item.carriers.length > 1) return; // team carries keep their formation
    p.slotTo = SLOTS[i];
  }

  pullFromTruck(p) {
    const id = topItemAt(this.grid, p.cursor.gx, p.cursor.gz);
    if (!id) return this.tell(p, 'That column is empty.');
    if (!isRemovable(this.grid, id)) return this.tell(p, 'Something is resting on it. Pull the top piece first.');
    const item = this.items.get(id);
    removeFromGrid(this.grid, id);
    this.gridVersion++;
    item.prevOwners = Object.keys(item.earned || {}); item.pulledAt = this.elapsed || 0;
    for (const [pid, amt] of Object.entries(item.earned || {})) { const o = this.players.get(pid); if (o) { o.score -= amt; o.loaded = Math.max(0, o.loaded - 1); } }
    item.earned = {}; item.g = null; item.state = 'carried'; item.carriers = [p.id]; item.x = p.x; item.z = p.z;
    item.pulled = true; item.outsideT = 0; if (item.value === undefined) item.value = 1;
    p.carry = id; p.unloading = false; p.cursor.rot = 0; p.unloads = (p.unloads || 0) + 1;
    this.event({ kind: 'emote', id: p.id, e: '↩️' });
    this.tell(p, `Pulled out the ${ITEM_TYPES[item.type].label.toLowerCase()}: its points come off until it's back in. Left outside too long, it loses value and rots.`);
  }

  respawn(item) {
    const t = ITEM_TYPES[item.type];
    const taken = [...this.items.values()].filter(i => i.state === 'floor').map(i => ({ x: i.x, z: i.z }));
    const spot = freeSpot(this.level, taken);
    Object.assign(item, { state: 'floor', x: spot.x, z: spot.z, wrapped: false, assembled: !!t.needsDisassemble, carriers: [], earned: {}, g: null, task: null, value: 1, pulled: false, outsideT: 0, prevOwners: null });
    this.event({ kind: 'toast', text: `📦 A replacement ${t.label.toLowerCase()} turned up in the ${this.level.roomAt(spot.x, spot.z)}.` });
  }

  dropIntoTruck(p, item) {
    const t = ITEM_TYPES[item.type];
    const loaderIds = [...item.carriers];
    const { gx, gz, rot } = p.cursor;
    const res = placeItem(this.grid, { id: item.id, type: item.type, wrapped: item.wrapped, loaderIds }, gx, gz, rot);
    if (!res.ok) return this.tell(p, res.reason === 'full' ? 'That stack is full — try another column!' : "Won't fit there!");

    for (const id of loaderIds) { const o = this.players.get(id); if (o) { o.carry = null; o.loadMode = false; o.slotTo = null; } }
    item.carriers = [];
    if (p.feeding) { // next box off the dolly, or the trip is done
      p.tripPlaced = (p.tripPlaced || 0) + 1;
      if (!this.feedFromDolly(p)) this.finishDollyTrip(p);
    }
    for (const id of loaderIds) { const o = this.players.get(id); if (o && !o.loadMode) o.rampLock = true; }

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
    let pts = Math.round(t.pts * (item.value ?? 1));
    item.pulled = false;
    if (t.needsWrap && !item.wrapped) { pts = Math.round(pts / 2); this.event({ kind: 'toast', text: `😬 The ${t.label.toLowerCase()} got scuffed! Half points — pad-wrap next time.` }); }
    // claim window: pulled out and put straight back → the points go back to whoever placed it first
    const CLAIM_SECONDS = 8;
    const prev = (item.prevOwners || []).filter(id => this.players.has(id));
    const payTo = prev.length && (this.elapsed || 0) - (item.pulledAt || 0) < CLAIM_SECONDS ? prev : loaderIds;
    item.prevOwners = null;
    const share = Math.round(pts / payTo.length);
    item.earned = {};
    for (const id of payTo) {
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
    if (!this.canCallOut()) return; // 1v1: nobody else to accuse
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
    const remaining = all.filter(i => i.type !== 'dolly' && (i.state === 'floor' || i.state === 'carried' || i.state === 'dolly'));
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

  /** Competitive rounds end with the truck driving off; a sloppy load costs whoever placed the wobbly pieces. */
  endRound(reason, forcedWinnerId = null, winners = null) {
    if (this.phase === 'driveoff' || this.phase === 'results') return;
    const drive = this.game === 'classic' && !this.tutorialMode && !forcedWinnerId && this.grid.items.size > 0;
    if (!drive) return this.finishRound(reason, forcedWinnerId, winners);
    for (const p of this.players.values()) { if (p.carry) this.releaseCarry(p); p.loadMode = false; p.task = null; }
    const check = driveOffCheck(this.grid);
    const lost = {};
    for (const d of check.damaged) {
      const it = this.items.get(d.id);
      if (!it) continue;
      it.damaged = d.reason;
      const value = ITEM_TYPES[it.type].pts;
      const payers = d.culpritIds.length ? d.culpritIds : Object.keys(it.earned || {});
      for (const id of payers) { const o = this.players.get(id); if (o) { const amt = Math.round(value / payers.length); o.score -= amt; lost[id] = (lost[id] || 0) + amt; } }
      d.name = ITEM_TYPES[it.type].label;
      d.by = payers.map(id => this.players.get(id)?.name).filter(Boolean).join(' + ');
    }
    this.driveoff = { ...check, lost: Object.entries(lost).map(([id, amt]) => ({ id, name: this.players.get(id)?.name, amt })) };

    // final tally: who placed each piece still in the truck, how well, and in what condition
    const tally = {};
    const row = (id) => (tally[id] ||= { pieces: 0, base: 0, condition: 0, placement: 0, damage: 0, final: 0 });
    for (const it of this.items.values()) {
      if (it.state !== 'loaded') continue;
      const payees = Object.keys(it.earned || {});
      if (!payees.length) continue;
      const full = Math.round(ITEM_TYPES[it.type].pts / payees.length);
      if (it.damaged) { // still counts as placed; the damage line takes it away
        for (const pid of payees) { const r = row(pid); r.pieces++; r.base += full; r.condition += it.earned[pid] - full; }
        continue;
      }
      const { q } = placementQuality(this.grid, it.id);
      for (const pid of payees) {
        const o = this.players.get(pid); if (!o) continue;
        const share = it.earned[pid], fin = Math.round(share * q), r = row(pid);
        r.pieces++; r.base += full; r.condition += share - full; r.placement += fin - share;
        o.score += fin - share; it.earned[pid] = fin;
      }
    }
    for (const l of this.driveoff.lost) row(l.id).damage -= l.amt;
    // final = what those pieces are worth now (other bonuses/penalties in the round are separate)
    for (const r of Object.values(tally)) r.final = r.base + r.condition + r.placement + r.damage;
    this.tally = tally;
    this.pendingEnd = [reason, forcedWinnerId, winners];
    this.phase = 'driveoff';
    this.driveT = check.damaged.length ? 7 : 5;
    this.event({ kind: 'driveoff', safety: check.safety, damaged: check.damaged.map(d => ({ id: d.id, name: d.name, reason: d.reason, by: d.by })) });
  }

  finishRound(reason, forcedWinnerId = null, winners = null) {
    this.phase = 'results';
    const players = [...this.players.values()].filter(p => !p.spectator)
      .map(p => ({ id: p.id, name: p.name, char: p.char, score: p.score, strikes: p.strikes, out: p.out, loaded: p.loaded, breaks: p.breaks || 0, bot: !!p.bot }))
      .sort((a, b) => b.score - a.score);
    const sab = [...this.players.values()].find(p => p.saboteur);
    let winner = (forcedWinnerId && players.find(p => p.id === forcedWinnerId)) || players.find(p => !p.out) || null;
    if (winners === 'saboteur' && sab) winner = players.find(p => p.id === sab.id) || winner;
    if (winners === 'crew') winner = players.find(p => sab ? p.id !== sab.id : true) || winner;
    const loaded = [...this.items.values()].filter(i => i.state === 'loaded' && !i.damaged);
    const teamTotal = loaded.reduce((s, i) => s + Object.values(i.earned || {}).reduce((a, b) => a + b, 0), 0);
    const unresolved = this.breaks.filter(b => !b.resolved).map(b => ({
      type: ITEM_TYPES[b.type].label,
      culprits: b.culpritIds.map(id => this.players.get(id)?.name || 'a mover who left').join(' + '),
    }));
    const movers = [...this.players.values()].filter(p => !p.spectator);
    const best = (key) => movers.reduce((b, p) => ((p[key] || 0) > (b?.[key] || 0) ? p : b), null);
    const awards = [
      ['loaded', '📦 Most loaded'], ['helps', '💪 Best lifting buddy'], ['wraps', '🧣 Wrap master'], ['unloads', '🧩 Repack hero'],
    ].map(([k, title]) => { const p = best(k); return p ? { id: p.id, name: p.name, title, value: p[k] } : null; }).filter(Boolean);
    this.results = { reason, awards, players, winnerId: winner?.id || null, teamTotal, unresolved, loadedCount: loaded.length, totalItems: this.items.size, broken: this.breaks.length, difficulty: this.bots.size ? this.difficulty : null, tally: this.tally || null,
      driveoff: this.driveoff ? { safety: this.driveoff.safety, damaged: this.driveoff.damaged.map(d => ({ name: d.name, reason: d.reason, by: d.by })), lost: this.driveoff.lost } : null,
      game: this.game, winners, saboteurId: sab?.id || null, saboteurName: sab?.name || null, crewScore: this.game === 'sabotage' ? this.crewScore() : null };
    for (const p of this.players.values()) { p.carry = null; p.loadMode = false; p.task = null; }
    this.event({ kind: 'end' });
    this.recordResults();
    if (this.quick) { if (this.listing) Promise.resolve().then(() => this.unlock()).catch(() => {}); this.autoStartAt = 30; }
  }

  /** Save stats + leaderboard entries for human players (never blocks the game). */
  recordResults() {
    const store = MoveRoom.store, r = this.results;
    if (!store || !r || this.demo) return;
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
      out: p.out, spectator: p.spectator, task: p.task, unloading: !!p.unloading, dolly: p.dolly || null, dashCd: +p.dashCd.toFixed(1), dashing: p.dashT > 0,
      room: this.level.roomAt(p.x, p.z), bot: !!p.bot, away: !!p.away, suit: p.suit || 'classic', ready: !!p.ready,
    }));
    const items = [...this.items.values()].filter(i => i.state !== 'broken').map(i => ({
      id: i.id, type: i.type, x: +i.x.toFixed(2), z: +i.z.toFixed(2), state: i.state, wrapped: i.wrapped,
      assembled: i.assembled, g: i.g, n: i.carriers.length, damaged: i.damaged ? 1 : 0, ...(i.pulled && i.value < 1 ? { value: +i.value.toFixed(2) } : {}),
      ...(i.type === 'dolly' ? { stack: i.stack, uses: i.uses, strain: i.strain, pusher: i.pusher } : {}), ...(i.state === 'dolly' ? { on: i.dollyId } : {}),
      task: i.task ? { kind: i.task.kind, p: +i.task.progress.toFixed(2) } : null,
    }));
    return {
      phase: this.phase, mode: this.mode, hostId: this.hostId, timeLeft: Math.max(0, Math.round(this.timeLeft)),
      countdown: this.phase === 'countdown' ? Math.ceil(this.countdown) : 0, driveT: this.phase === 'driveoff' ? +this.driveT.toFixed(2) : 0,
      canCallOut: this.canCallOut(),
      game: this.game, overtime: !!this.overtime, crewScore: this.game === 'sabotage' ? this.crewScore() : null,
      quick: this.quick, autoStart: this.quick && this.autoStartAt > 0 ? Math.ceil(this.autoStartAt) : 0, twist: this.twist, zeroG: this.zeroG,
      daily: this.daily, tutorial: this.tutorial && this.tutorial.step >= 0 ? { step: this.tutorial.step, total: this.tutorial.total, text: this.tutorial.text, target: this.tutorial.target } : null,
      level: { seed: this.level.seed, classic: !!this.level.classic, exact: !!this.level.exact, mansion: !!this.level.mansion, tutorial: !!this.level.tutorial, daily: this.level.daily || null, name: this.level.name, rooms: this.level.rooms.length, yard: this.level.yardDistance }, difficulty: this.difficulty, solo: this.solo,
      loadedCount: [...this.items.values()].filter(i => i.state === 'loaded').length, totalItems: this.items.size,
      players, items, cat: { x: +this.cat.x.toFixed(2), z: +this.cat.z.toFixed(2), face: this.cat.face || 0 },
      openBreaks: this.breaks.filter(b => !b.resolved).length,
      meeting: this.meeting ? { callerId: this.meeting.callerId, timeLeft: Math.ceil(this.meeting.timeLeft), voted: Object.keys(this.meeting.votes) } : null,
      results: this.phase === 'results' ? this.results : null,
    };
  }
}
