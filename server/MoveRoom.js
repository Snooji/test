import { Room, ServerError } from '@colyseus/core';
import { SabotageGame } from './sabotage/game.js';
import { debugHooksOn, limiter, isProd } from './security.js';
import { createGrid, placeItem, tallyVotes, ITEM_TYPES, RULES, GRID, footprint, orientations, ORIENT_LABEL, canFitAny, isRemovable, removeFromGrid, topItemAt, SUITS, suitUnlocked, dailySeed, driveOffCheck, placementQuality, gridGaps, bestSpot } from '../shared/logic.js';
import { Bot, BOT_NAMES, DIFFICULTY } from './bot.js';
import { PLAYER_SPAWNS, inRamp, TRUCK } from '../shared/world.js';
import { generateLevel, classicLevel, newSeed, freeSpot, tutorialLevel, houseCode, seedFromCode } from '../shared/level.js';
import { createNav } from './nav.js';
import { verifyToken, cleanName, cleanEmail } from './signups.js';

import { CLASSIC_IDS, ALL_CHAR_IDS, charUnlocked, rosterEntry, unlockText } from '../shared/roster.js';
const joinLimit = limiter(40, 60_000); // room joins per visitor per minute (see onAuth)
const CHARS = CLASSIC_IDS; // defaults + AI movers
const SPEED = 5;
const R = 0.45;           // player radius
// Energy while carrying (round 9): drain per second at full speed for that load; scales with speed², so careful = cheap.
export const ENERGY = {
  drain: { standard: 0.14, fragile: 0.14, lamp: 0.18, heavy: 0.28, team: 0.26, soloLift: 0.35, dolly: 0.02, flatDolly: 0.03 },
  regenStill: 0.35, regenWalk: 0.1, injurySecs: 7, injuryMult: 0.55,
  injuries: ['twisted an ankle', 'pulled a back muscle', 'stubbed a toe', 'tweaked a knee'],
};
const FLAT_LEN = 1.3, FLAT_MAX_BOXES = 4; // the furniture dolly: short enough for a hallway, 2x2 boxes or one piece
const BOX_TYPES = ['standard', 'heavy', 'fragile'];
const DUEL_SECONDS = 5, DUEL_TAP_COST = 0.008; // ~40 taps (a full 5 s of mashing) = a third of your energy
// tap allowance: refills at 15 taps/s and holds up to 4, so taps a phone network delivers bunched together all count,
// while an autoclicker gets a 4-tap burst and then 15/s at most
const DUEL_TAP_RATE = 15, DUEL_TAP_BURST = 4;
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const SEP_STEP = 0.025;     // max push per tick when two movers overlap (well under walking pace)
const REACH = 1.7;        // interaction distance
const TICK = 50;          // ms (20 Hz)
export const TEAM_NAMES = ['Orange', 'Teal', 'Purple'];
const MAX_CREW = 6, DEFAULT_CREW = 4; // movers per round: the crew chief picks 2-6 in the lobby (this.crewSize)

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const dist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);

export class MoveRoom extends Room {
  static store = null; // set by server/index.js; null in unit tests
  maxClients = MAX_CREW + 2; // up to 6 movers + 2 watching (joins past crewSize + 2 are turned away in onAuth)

  onAuth(client, options, context) {
    // joins (and room creation) per visitor: 40 a minute is plenty for a real player, stops scripted floods
    const ip = (isProd() && context?.headers?.['cf-connecting-ip']) || context?.ip || 'unknown';
    if (!joinLimit.hit(String(ip))) throw new ServerError(429, 'Too many joins. Wait a minute and try again.');
    if (this.players && this.players.size >= (this.crewSize || DEFAULT_CREW) + 2) throw new ServerError(409, 'That crew is full.');
    const email = cleanEmail(options?.email);
    if (!verifyToken(email, options?.token)) throw new ServerError(401, 'Sign in at the gate first.');
    return { email, name: cleanName(options?.name) || 'Mover' };
  }

  onCreate(options = {}) {
    // flood guard: each client's messages draw on a budget (refills 80/s, holds 200). Over it, messages are dropped;
    // a client that keeps hammering far past it is disconnected.
    const on = this.onMessage.bind(this);
    this.onMessage = (type, fn) => on(type, (c, m) => (this.flooding(c) ? undefined : fn(c, m)));
    this.phase = 'lobby';
    this.crewSize = Math.max(2, Math.min(MAX_CREW, Math.round(Number(options.crew) || DEFAULT_CREW)));
    this.teamN = 0; // 0 = everyone for themselves; 2 or 3 teams sharing the truck, scored as a team
    this.mode = '3min';
    this.game = options.game === 'sabotage' ? 'sabotage' : 'classic';
    this.sab = null;
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
    // floors (1–4): the crew chief picks in the lobby; the daily house picks 1 or 2 from its seed
    this.floors = this.daily ? 1 + (this.seedOverride % 2) : Math.max(1, Math.min(4, Math.round(Number(options.floors) || 1)));
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
      if (p.resync) { p.resync = false; for (const k of ['tapN', 'dashN', 'rotN', 'flipN']) p.in[k] = Number(m[k]) | 0; return; }
      for (const k of ['tapN', 'dashN', 'rotN', 'flipN']) {
        const v = Number(m[k]) | 0;
        if (v > p.in[k]) { p.pending[k] += Math.min(3, v - p.in[k]); p.in[k] = v; }
      }
    });
    this.onMessage('sab', (c) => { const p = this.players.get(c.sessionId); if (p && this.phase === 'playing') this.sab?.onSabotage(p); });
    this.onMessage('duelTap', (c) => this.duelTap(this.players.get(c.sessionId)));
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
      if (this.isExact() !== wasExact && !this.classic) { this.newLevel(false); this.resetWorld(); } // Full load needs an exact-fill house (same seed)
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
    // a house code typed by the crew chief: that exact house (same code + same options = same house for anyone)
    this.onMessage('seed', (c, m) => {
      const seed = seedFromCode(String(m?.code ?? ''));
      if (!hostInLobby(c) || seed === null || this.daily || this.tutorialMode || this.classic) return;
      this.seedOverride = seed; this.newLevel(); this.resetWorld();
    });
    this.onMessage('reroll', (c) => {
      if (c.sessionId === this.hostId && this.phase === 'lobby' && !this.classic) { this.newLevel(); this.resetWorld(); }
    });
    if (debugHooksOn()) { // automated tests only: never in production (server/security.js)
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
      this.onMessage('debug_duel', (c) => { // two AI movers carry the couch right next to you, and you challenge them
        const p = this.players.get(c.sessionId), [x, y] = [...this.bots.values()].map(b => b.p);
        const it = [...this.items.values()].find(i => i.type === 'couch');
        if (!p || !x || !y || !it || this.phase !== 'playing' || p.carry) return;
        it.wrapped = true; it.state = 'carried'; it.carriers = [x.id, y.id]; x.carry = y.carry = it.id;
        x.task = y.task = null; x.x = it.x - 1.2; x.z = it.z; y.x = it.x + 1.2; y.z = it.z; p.x = it.x + 1.4; p.z = it.z + 0.6;
        this.startDuel(p, it);
      });
      this.onMessage('debug_drop', (c) => { const ws = c.ref; (ws?.terminate || ws?.close)?.call(ws); }); // cut the socket, no goodbye (= a phone losing signal)
      this.onMessage('debug_long_meeting', () => { if (this.meeting) this.meeting.timeLeft = 120; }); // slow test browsers
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
    // House setup (floors + twist): everyone picks; the crew chief's pick is what the lobby shows, and when the round
    // starts one human's pick is drawn at random (drawSetup).
    const vote = (c, patch) => {
      const p = this.players.get(c.sessionId);
      if (!p || p.bot || (this.phase !== 'lobby' && this.phase !== 'results') || this.daily || this.tutorialMode) return false;
      p.setup = { floors: p.setup?.floors ?? (c.sessionId === this.hostId ? this.floors : 1), twist: p.setup?.twist ?? (c.sessionId === this.hostId ? this.twist : 'none'), ...patch };
      return c.sessionId === this.hostId;
    };
    this.onMessage('twist', (c, m) => {
      if (!['none', 'zerog', 'mansion'].includes(m?.twist) || !vote(c, { twist: m.twist })) return;
      this.applySetup({ floors: this.floors, twist: m.twist });
    });
    this.onMessage('floors', (c, m) => {
      const n = Math.round(Number(m?.floors));
      if (!(n >= 1 && n <= 4) || this.classic || !vote(c, { floors: n })) return;
      this.applySetup({ floors: n, twist: this.twist });
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
    // crew size (2-6 movers): the crew chief's call. Solo games fill the crew with AI movers; with friends, extra AI step out.
    this.onMessage('crew', (c, m) => {
      const n = Math.round(Number(m?.size));
      if (!hostInLobby(c) || !(n >= 2 && n <= MAX_CREW)) return;
      this.crewSize = n;
      if (this.teamN === 3 && n < 6) this.teamN = 2;
      this.fitCrew();
    });
    // teams: the crew chief picks off / 2 / 3 (3 needs a crew of 6); everyone shares the one truck
    this.onMessage('teams', (c, m) => {
      const n = Number(m?.n) | 0;
      if (!hostInLobby(c) || this.game === 'sabotage' || ![0, 2, 3].includes(n)) return;
      if (n === 3 && this.crewSize < 6) return this.tell(this.players.get(c.sessionId), 'Three teams need a crew of 6.');
      this.teamN = n; this.balanceTeams(true);
    });
    // switch sides in the lobby, as long as the teams stay even (one apart at most)
    this.onMessage('team', (c, m) => {
      const p = this.players.get(c.sessionId), t = Number(m?.t) | 0;
      if (!p || p.spectator || !this.teamN || this.inRound() || t < 1 || t > this.teamN || p.team === t) return;
      const size = (k) => this.movers().filter(o => o.team === k).length;
      if (size(t) + 1 > size(p.team)) { // that would make it lopsided: an AI mover on that side swaps with you, else no room
        const bot = this.movers().find(o => o.bot && o.team === t);
        if (!bot) return this.tell(p, `The ${TEAM_NAMES[t - 1]} team is full. Teams stay even.`);
        bot.team = p.team;
      }
      p.team = t;
    });
    this.onMessage('game', (c, m) => {
      if (!hostInLobby(c) || !['classic', 'sabotage'].includes(m?.game)) return;
      const wasExact = this.isExact();
      this.game = m.game;
      if (this.game === 'sabotage') this.teamN = 0; // the crew against a saboteur already is a team game
      if (this.isExact() !== wasExact && !this.classic) { this.newLevel(false); this.resetWorld(); }
    });
    this.onMessage('removeBot', (c) => {
      if (!hostInLobby(c)) return;
      const last = [...this.bots.keys()].pop();
      if (last) this.removeBot(last);
    });

    this.setSimulationInterval((dt) => this.tick(Math.min(dt, 100) / 1000), TICK);
  }

  onJoin(client, options, auth) {
    this.forceFull = true; // the newcomer needs every item
    // a friend joining a full lobby takes a bot's seat
    if (this.phase === 'lobby' && this.movers().length >= this.crewSize && this.bots.size) this.removeBot([...this.bots.keys()].pop());
    const used = new Set([...this.players.values()].map(p => p.char));
    const asked = ALL_CHAR_IDS.includes(options?.char) && !used.has(options.char) ? options.char : null;
    const want = asked && charUnlocked(asked, null) ? asked : CHARS.find(c => !used.has(c)) || 'nova';
    const movers = [...this.players.values()].filter(p => !p.spectator).length;
    const p = {
      id: client.sessionId, name: auth.name, email: auth.email, char: want,
      x: 0, z: 0, face: 0, score: 0, strikes: 0, out: false,
      spectator: movers >= this.crewSize || this.inRound(),
      carry: null, loadMode: false, cursor: { gx: 1, gz: 0, rot: 0 }, cursorCd: 0,
      dashT: 0, dashCd: 0, loaded: 0, task: null,
      in: { mx: 0, mz: 0, hold: false, tapN: 0, dashN: 0, rotN: 0, flipN: 0 },
      pending: { tapN: 0, dashN: 0, rotN: 0, flipN: 0 },
    };
    this.placeAtSpawn(p, this.players.size);
    this.players.set(p.id, p);
    if (!this.hostId) this.hostId = p.id;
    this.event({ kind: 'toast', text: `${p.name} joined the crew${p.spectator ? ' (spectating this round)' : ''}` });
    if (this.soloPending) { this.soloPending = false; for (let i = 1; i < this.crewSize; i++) this.addBot(); } // a full crew of AI movers
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
      in: { mx: 0, mz: 0, hold: false, tapN: 0, dashN: 0, rotN: 0, flipN: 0 },
      pending: { tapN: 0, dashN: 0, rotN: 0, flipN: 0 }, ...extra,
    };
  }

  movers() { return [...this.players.values()].filter(p => !p.spectator); }
  /** keep the crew at crewSize: AI movers leave first if there are too many; solo games fill up with AI; extra humans watch */
  fitCrew() {
    if (this.inRound()) return;
    while (this.movers().length > this.crewSize && this.bots.size) this.removeBot([...this.bots.keys()].pop());
    let i = 0;
    for (const p of this.players.values()) if (!p.bot) p.spectator = i++ >= this.crewSize;
    if (this.solo && !this.tutorialMode) while (this.movers().length < this.crewSize && this.addBot()) { /* fill */ }
  }
  /** keep every mover on a team, the teams even (at most one apart); `fresh` deals everyone out again */
  balanceTeams(fresh = false) {
    const movers = this.movers();
    if (!this.teamN) { for (const p of this.players.values()) p.team = 0; return; }
    for (const p of this.players.values()) if (p.spectator || fresh) p.team = 0;
    const cap = Math.ceil(movers.length / this.teamN), size = (k) => movers.filter(o => o.team === k).length;
    // humans first so friends get dealt out evenly before the AI fill in
    for (const p of [...movers].sort((a, b) => (a.bot ? 1 : 0) - (b.bot ? 1 : 0))) {
      if (p.team >= 1 && p.team <= this.teamN && size(p.team) <= cap) continue;
      p.team = 0;
      let best = 1; for (let k = 2; k <= this.teamN; k++) if (size(k) < size(best)) best = k;
      p.team = best;
    }
    // still lopsided (people switched, then someone left): move an AI mover over, else whoever joined last
    for (let guard = 0; guard < 6; guard++) {
      const ks = Array.from({ length: this.teamN }, (_, i) => i + 1).sort((a, b) => size(b) - size(a));
      if (size(ks[0]) - size(ks[ks.length - 1]) <= 1) break;
      const from = movers.filter(o => o.team === ks[0]), pick = from.find(o => o.bot) || from[from.length - 1];
      pick.team = ks[ks.length - 1];
    }
  }
  teamScores() {
    if (!this.teamN) return null;
    return Array.from({ length: this.teamN }, (_, i) => {
      const ms = this.movers().filter(p => p.team === i + 1);
      return { t: i + 1, name: TEAM_NAMES[i], score: ms.reduce((a, p) => a + p.score, 0), members: ms.map(p => p.id) };
    });
  }
  inRound() { return this.phase === 'playing' || this.phase === 'meeting' || this.phase === 'countdown'; }

  addBot() {
    if (this.movers().length >= this.crewSize || this.inRound()) return null;
    const used = new Set([...this.players.values()].map(p => p.char));
    const usedNames = new Set([...this.players.values()].map(p => p.name));
    const char = CHARS.find(c => !used.has(c)) || ALL_CHAR_IDS.find(c => !used.has(c)) || 'nova'; // a 5th and 6th mover come from the full roster
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

  /** Dropped without saying goodbye (phones drop the socket when you switch apps): mid-round, hold their mover for 30 s. */
  onDrop(client) {
    const p = this.players.get(client.sessionId);
    if (!p || !this.inRound()) return; // not in a round: nothing to hold, onLeave tidies up
    p.in.mx = 0; p.in.mz = 0; p.in.hold = false; p.away = true;
    this.releaseCarry(p); // never leave a crewmate holding the other end
    this.system(`📡 ${p.name} lost connection. Holding their spot for 30 s…`);
    const wait = this.allowReconnection(client, 30); // back in time → onReconnect; not → onLeave
    wait?.catch?.(() => {});
  }

  onReconnect(client) {
    const p = this.players.get(client.sessionId);
    if (!p) return;
    p.away = false; p.resync = true; // the next snapshot is a full one
    this.sendRole(p);
    this.system(`✅ ${p.name} is back!`);
  }

  /** Gone for good: left on purpose, dropped outside a round, or didn't make it back in time. */
  async onLeave(client) {
    this.msgBudget?.delete(client.sessionId);
    const p = this.players.get(client.sessionId);
    if (!p) return;
    this.sab?.onLeave(p);
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
    // the nearest free AI mover drops what it's walking to and comes to help
    const free = [...this.bots.values()].filter(b => b.p !== p && this.isActive(b.p) && !b.p.carry && !b.p.loadMode && !b.p.dolly && !b.p.flatDolly && !b.p.task && !b.p.duel)
      .sort((a, b) => a.travel(a.p, item) - b.travel(b.p, item)); // walking distance: a floor away is via the stairs, not 40 m
    const helper = free.find(b => Math.random() < ({ easy: 0.7, normal: 0.95, hard: 1 }[b.difficulty] ?? 0.9));
    if (helper) {
      helper.answerHelp(item);
      this.broadcast('chat', { from: helper.p.name, char: helper.p.char, text: pick(['On my way! 🏃', 'Got you, coming!', 'Hold on, I’ll grab the other end!']), bot: true });
    }
    const label = ITEM_TYPES[item.type].label.toLowerCase();
    this.event({ kind: 'help', id: p.id, name: p.name, item: label, x: +item.x.toFixed(1), z: +item.z.toFixed(1), text: `🆘 ${p.name} needs a hand with the ${label}! Lift the other end and split the points.` });
    return true;
  }

  // ---------- world ----------
  /** fresh = a new random house; false = same seed with the current options (floors, twist, mode changed) */
  newLevel(fresh = true) {
    this.level = this.tutorialMode ? tutorialLevel()
      : this.classic ? classicLevel()
      : generateLevel(this.seedOverride ?? (!fresh && this.level?.seed !== undefined && !this.level.classic && !this.level.tutorial ? this.level.seed : newSeed()), { exact: this.isExact(), mansion: this.twist === 'mansion', floors: this.floors });
    if (this.daily) this.level.daily = this.daily; else this.seedOverride = null;
    this.level.twist = this.twist;
    this.nav = createNav(this.level);
    this.cat = { x: this.level.cat[0][0], z: this.level.cat[0][1], wp: 0 };
  }

  loadedCountCache() { let n = 0; for (const i of this.items.values()) if (i.state === 'loaded') n++; return n; }

  isExact() { return this.mode === 'load' || this.game === 'sabotage'; }
  allowsUnload() { return !this.tutorialMode; }

  resetWorld() {
    this.forceFull = true; // a new set of items: everyone gets the full list
    this.items.clear();
    this.duels = new Map();
    for (const p of this.players.values()) p.duel = null;
    this.gridVersion = 0; this.fitCache = null; this.stuckHinted = false;
    this.grid = createGrid();
    this.breaks = [];
    this.meeting = null;
    if (this.dollyOn && !this.tutorialMode) {
      const spot = freeSpot(this.level, this.level.items.map(([, x, z]) => ({ x, z })));
      this.items.set('dolly', { id: 'dolly', type: 'dolly', x: spot.x, z: spot.z, state: 'floor', stack: [], uses: 0, strainT: 0, strain: 0, pusher: null, carriers: [], earned: {}, task: null, helpers: [], g: null });
      const spot2 = freeSpot(this.level, [...this.level.items.map(([, x, z]) => ({ x, z })), spot], Math.random, 0); // the furniture dolly lives downstairs
      this.items.set('flatdolly', { id: 'flatdolly', type: 'flatdolly', x: spot2.x, z: spot2.z, state: 'floor', piece: null, stack: [], wobble: 0, pusher: null, respawnAt: 0, carriers: [], earned: {}, task: null, helpers: [], g: null });
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

  /** Switch to a house setup, keeping the same seed (so a typed house code still holds). */
  applySetup({ floors, twist }) {
    const rebuild = !this.classic && (floors !== this.floors || (twist === 'mansion') !== (this.twist === 'mansion'));
    this.floors = floors; this.twist = twist;
    if (rebuild) this.newLevel(false); else this.level.twist = twist;
    return rebuild;
  }

  /** Round start: draw one human's house-setup pick at random (the crew chief's current one if they didn't pick). */
  drawSetup() {
    if (this.daily || this.tutorialMode || this.classic) return;
    const humans = [...this.players.values()].filter(p => !p.bot && !p.spectator);
    const picks = humans.map(p => ({ p, s: p.setup || (p.id === this.hostId ? { floors: this.floors, twist: this.twist } : null) })).filter(x => x.s);
    if (picks.length < 2 || picks.every(x => x.s.floors === picks[0].s.floors && x.s.twist === picks[0].s.twist)) return;
    const { p, s } = picks[Math.floor(Math.random() * picks.length)];
    this.applySetup(s);
    const tw = { none: 'no twist', zerog: 'Zero-G', mansion: 'Moon Mansion' }[s.twist];
    this.lastDraw = { name: p.name, floors: s.floors, twist: s.twist };
    this.event({ kind: 'toast', text: `🎲 House setup drawn from ${picks.length} picks: ${p.name}'s (${s.floors} floor${s.floors > 1 ? 's' : ''}, ${tw}).` });
  }

  startRound() {
    if (this.phase === 'lobby' || this.phase === 'results') this.drawSetup();
    this.balanceTeams();
    this.resetWorld();
    let i = 0;
    for (const p of this.players.values()) {
      Object.assign(p, { score: 0, strikes: 0, out: false, carry: null, loadMode: false, loaded: 0, breaks: 0, task: null, dashCd: 0, dashT: 0, energy: 1, injuredT: 0 });
      p.spectator = i >= this.crewSize;
      this.placeAtSpawn(p, i++);
    }
    this.timeLeft = this.tutorialMode ? 3600 : RULES.MODES[this.mode] + (this.twist === 'mansion' && this.mode !== 'load' ? 60 : 0)
      + (this.mode !== 'load' ? 45 * ((this.level.floors || 1) - 1) : 0); // more stairs, more time: 45 s for each floor above the ground
    this.tutorial = this.tutorialMode ? { step: -1 } : null;
    this.autoStartAt = 0; this.zeroG = false; this.zeroT = 0;
    if (this.quick && this.listing) Promise.resolve().then(() => this.lock()).catch(() => {}); // stop Quick Play matching into a live round
    for (const p of this.players.values()) Object.assign(p, { unloads: 0, helps: 0, wraps: 0, rampSlot: -1, ready: false, dolly: null, feeding: false, tripPlaced: 0, flatDolly: null, flatFeeding: null });
    this.results = null;
    for (const b of this.bots.values()) b.reset();
    this.overtime = false; this.drain = 0; this.driveoff = null; this.pendingEnd = null; this.resultsT = 0; this.tally = null;
    for (const p of this.players.values()) { p.saboteur = false; p.lastMeeting = 0; }
    this.sab = this.game === 'sabotage' && !this.tutorialMode ? new SabotageGame(this) : null; // pack the house: its own rules
    if (this.sab) { this.sab.setupWorld(); this.sab.dealRoles(); }
    else if (this.game === 'sabotage') {
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

  /** a meeting needs 3+ movers, at least 30 s of play since the last one, and (classic) a crunch nobody has talked about yet */
  canCallOut() {
    if (this.movers().length <= 2 || (this.elapsed || 0) < (this.meetingCdUntil || 0)) return false;
    return this.game === 'sabotage' || this.breaks.some(b => !b.resolved && !b.discussed);
  }

  isActive(p) { return p && !p.out && !p.spectator; }
  activePlayers() { return [...this.players.values()].filter(p => this.isActive(p)); }
  event(e) { this.broadcast('evt', e); }
  tell(p, text) { const c = this.clients.find(c => c.sessionId === p.id); c?.send('evt', { kind: 'toast', text, private: true }); }

  // ---------- simulation ----------
  tick(dt) {
    this.lastDt = dt;
    if (this.teamN && !this.inRound() && this.phase !== 'driveoff') this.balanceTeams(); // people come and go in the lobby
    this.elapsed = (this.elapsed || 0) + dt;
    this.moveCat(dt);
    if (this.phase === 'countdown') {
      this.countdown -= dt;
      if (this.countdown <= 0) { this.phase = 'playing'; this.event({ kind: 'go' }); if (this.tutorial) this.updateTutorial(); }
    } else if (this.phase === 'playing') {
      this.timeLeft -= dt;
      for (const b of this.bots.values()) b.think(dt);
      for (const p of this.players.values()) { p.px = p.x; p.pz = p.z; }
      for (const p of this.players.values()) this.updatePlayer(p, dt);
      this.separate();
      this.updateTeamCarries(dt);
      this.applyStairs();
      this.updateEnergy(dt);
      this.updateTasks(dt);
      this.updateDollies(dt);
      this.updateFlatDolly();
      this.updateDuels(dt);
      this.updateDecay(dt);
      this.sab?.tick(dt);
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
      this.applyStairs();
      if (this.quick && this.autoStartAt > 0 && (this.autoStartAt -= dt) <= 0) { this.autoStartAt = 0; this.startRound(); }
    }
    for (const p of this.players.values()) { p.pending.tapN = 0; p.pending.dashN = 0; p.pending.rotN = 0; p.pending.flipN = 0; }
    // the menu's demo game streams at ~7 Hz; real games at 20 Hz
    if (!this.demo || (this.demoTick = (this.demoTick || 0) + 1) % 3 === 0) this.broadcastSnap();
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

    if (p.pending.dashN && p.dashCd <= 0 && !(p.injuredT > 0)) { p.dashT = 0.6; p.dashCd = 5; this.event({ kind: 'emote', id: p.id, e: '🚀' }); }
    if (p.injuredT > 0) p.dashT = 0; // hurt: no sprinting

    if (!team) {
      let mult = p.dashT > 0 ? 2 : 1;
      if (item) {
        const t = ITEM_TYPES[item.type];
        if (t.teamCarry) mult *= this.activePlayers().length === 1 ? 0.4 : 0; // solo-lift only when alone; else wait for a buddy
        else if (t.heavy) mult *= 0.6;
      }
      if (p.task) mult = 0; // working on furniture
      if (p.duel) mult = 0; // in a tap battle
      if (p.injuredT > 0) mult *= ENERGY.injuryMult;
      const dly = this.dollyOf(p);
      if (dly) mult *= dly.stack.some(id => ITEM_TYPES[this.items.get(id)?.type]?.heavy) ? 0.7 : 0.85;
      const fd = this.flatOf(p);
      if (fd) mult *= fd.piece ? 0.8 : 0.95;
      const ox = p.x, oz = p.z, of = p.face;
      this.freeMove(p, dt, mult);
      if (fd && this.flatBlocked(p, fd)) { p.x = ox; p.z = oz; p.face = of; } // the dolly (and the piece on it) can't go through walls
      if (fd && this.level.floors > 1 && (this.level.onStairs(p.x, p.z) || this.level.onStairs(fd.x, fd.z) || this.level.onStairs(p.x + Math.sin(p.face) * this.flatReach(fd), p.z + Math.cos(p.face) * this.flatReach(fd)))) {
        // the four-wheel furniture dolly stays downstairs (the two-wheel dolly tips back and bumps up the steps)
        p.x = ox; p.z = oz; p.face = of;
        if (!p.bot && (this.elapsed - (p.stairHintAt || -99)) > 6) { p.stairHintAt = this.elapsed; this.tell(p, 'The furniture dolly stays downstairs. Carry the piece up or down the stairs, or use the two-wheel dolly for boxes.'); }
      }
      if (item) { item.x = p.x + Math.sin(p.face) * 0.2; item.z = p.z + Math.cos(p.face) * 0.2; }
      if (dly) { dly.x = p.x + Math.sin(p.face) * 0.9; dly.z = p.z + Math.cos(p.face) * 0.9; this.syncDollyStack(dly); }
      if (fd) { const off = this.flatReach(fd); fd.x = p.x + Math.sin(p.face) * off; fd.z = p.z + Math.cos(p.face) * off; fd.face = p.face; this.syncFlatPiece(fd); }
      if (fd) this.flatWobble(p, fd, dt, ox, oz, of);
    }

    // pushing a loaded dolly onto the ramp: boxes come off top first, one at a time
    if (p.rampLock && !inRamp(p.x, p.z) && !(item && inRamp(item.x, item.z))) p.rampLock = false;
    const fd2 = this.flatOf(p);
    if (fd2?.piece && !item && inRamp(p.x, p.z) && !p.rampLock) { // furniture dolly at the truck: you place the piece yourself
      const piece = this.items.get(fd2.piece);
      fd2.piece = null; fd2.state = 'parked';
      piece.state = 'carried'; piece.carriers = [p.id]; piece.flatId = null; piece.x = p.x; piece.z = p.z;
      p.carry = piece.id; p.loadMode = true; p.flatFeeding = fd2.id; p.cursor = bestSpot(this.grid, piece.type); p.cursorCd = 0.35;
      this.takeRampSlot(p);
      this.tell(p, `Furniture dolly: place the ${ITEM_TYPES[piece.type].label.toLowerCase()} yourself. Aim · ACTION drop · BACK puts it back on the dolly.`);
      return;
    }
    if (fd2?.stack?.length && !item && inRamp(p.x, p.z) && !p.rampLock) { // furniture dolly of boxes: one at a time, like the two-wheel one
      p.tripPlaced = 0; p.feedFrom = 'flat';
      this.feedFromDolly(p);
      p.cursorCd = 0.35;
      this.takeRampSlot(p);
      return;
    }
    const dly2 = this.dollyOf(p);
    if (dly2 && !item && dly2.stack.length && inRamp(p.x, p.z) && !p.rampLock) {
      p.tripPlaced = 0; p.feedFrom = 'dolly';
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
    if (item && item.carriers[0] === p.id && inRamp(item.x, item.z) && !p.rampLock && !ITEM_TYPES[item.type].tool) { // (a flat box isn't cargo)
      p.loadMode = true;
      p.cursor = bestSpot(this.grid, item.type); // start on a spot that follows the packing rules (new movers follow the outline)
      this.takeRampSlot(p);
      p.cursorCd = 0.35; // grace so held movement doesn't jerk the cursor on entry
      this.tell(p, 'In the truck: aim, then place it. Turn the piece if it doesn’t fit. Back leaves the truck.');
      return;
    }

    if (p.pending.tapN) { p.pending.tapN = 0; this.onTap(p, item); } // consume: one tap = one action
  }

  onTap(p, item) {
    if (this.sab?.onTap(p, item)) return;
    if (item) { // put it on a parked dolly with room, else set it down on the floor
      if (this.putOnDolly(p, item)) return;
      this.releaseCarry(p);
      return;
    }
    if (p.dolly) return this.dollyTap(p);
    if (p.flatDolly) return this.flatTap(p);
    // an AI mover says what it walked to; use that if it's in reach, else the nearest thing (people)
    const want = p.tapWant ? this.items.get(p.tapWant) : null;
    p.tapWant = null;
    const wantOk = want && (want.state === 'floor' || (want.state === 'carried' && ITEM_TYPES[want.type].teamCarry && want.carriers.length === 1 && !want.carriers.includes(p.id)))
      && dist(p, want) - Math.max(ITEM_TYPES[want.type].w, ITEM_TYPES[want.type].d) * 0.35 < REACH + 0.3;
    const target = wantOk ? want : this.nearestItem(p);
    if (!target) return;
    const t = ITEM_TYPES[target.type];
    if (this.holderOf(target)) return this.startDuel(p, target); // someone else has it: fight for it
    if (target.type === 'flatdolly') {
      target.state = 'pushed'; target.pusher = p.id; p.flatDolly = target.id;
      this.event({ kind: 'emote', id: p.id, e: '🛞' });
      this.tell(p, target.piece ? 'Furniture dolly. Push it to the truck.' : 'Furniture dolly! Tap next to a couch, bed, desk or table to load it (take desks and tables apart first). One piece, moved by you alone.');
      return;
    }
    if (target.type === 'dolly') {
      target.state = 'pushed'; target.pusher = p.id; p.dolly = target.id;
      this.event({ kind: 'emote', id: p.id, e: '🛒' });
      this.tell(p, 'Dolly! Tap next to boxes to stack up to 3. Push it to the truck to unload them.');
      return;
    }
    if (target.assembled) return this.tell(p, `Hold ACTION to disassemble the ${t.label.toLowerCase()} first`);
    if (t.teamCarry) {
      if (target.state === 'carried') {
        if (target.carriers.length >= 2) return this.startDuel(p, target);
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
      const grab = !p.bot && this.holderOf(it) && this.holderOf(it) !== p && !p.carry && !(this.teamN && this.holderOf(it).team === p.team); // a box someone carries / a dolly someone pushes
      if ((it.type === 'dolly' || it.type === 'flatdolly') && (p.bot || it.state !== 'floor') && !grab) continue; // AI movers leave the dollies alone
      const stealable = grab || (it.state === 'carried' && ITEM_TYPES[it.type].teamCarry && it.carriers.length === 2 && !p.carry && !it.carriers.includes(p.id));
      if (it.state !== 'floor' && !(it.state === 'carried' && ITEM_TYPES[it.type].teamCarry && it.carriers.length === 1) && !stealable) continue;
      const t = ITEM_TYPES[it.type], len = Math.max(t.w, t.d);
      const d = dist(p, it) - (len > 1 ? len * 0.35 : 0);
      if (d < bd) { bd = d; best = it; }
    }
    return best;
  }

  /** who you'd have to beat to take this: the one mover carrying a box (or one-mover piece), or whoever pushes a dolly.
   *  (A two-mover lift is fought over end by end: see startDuel.) */
  holderOf(it) {
    if ((it.type === 'dolly' || it.type === 'flatdolly') && it.state === 'pushed') return this.players.get(it.pusher) || null;
    if (ITEM_TYPES[it.type].tool) return null; // props (a flat box) aren't worth a fight
    if (it.state === 'carried' && it.carriers.length === 1 && !ITEM_TYPES[it.type].teamCarry) return this.players.get(it.carriers[0]) || null;
    return null;
  }
  /** does this mover still have it (carrying it, or pushing the dolly)? */
  stillHolds(it, who) {
    if (!it || !who) return false;
    if (it.type === 'dolly' || it.type === 'flatdolly') return it.state === 'pushed' && it.pusher === who.id;
    return it.state === 'carried' && it.carriers.includes(who.id);
  }

  // ---------- tap battles: steal an end of a two-mover lift, a box someone carries, or a dolly someone pushes ----------
  startDuel(p, item) {
    this.duels ||= new Map();
    if (this.duels.has(item.id) || p.duel || p.carry || p.dolly || p.flatDolly || !this.isActive(p)) return;
    const one = this.holderOf(item);
    const holders = one ? [one] : item.carriers.map(id => this.players.get(id)).filter(Boolean);
    if (holders.some(h => h.loadMode || h.duel || h === p)) return; // already at the truck, or busy
    if (this.teamN && holders.every(h => h.team === p.team)) return this.tell(p, 'That’s your teammate! Steal from the other team.');
    if (one && one.carry && one.carry !== item.id) return; // pushing a dolly but also holding a box (unloading it)
    const victim = holders.filter(h => !this.teamN || h.team !== p.team).sort((a, b) => dist(p, a) - dist(p, b))[0]; // never your own teammate
    if (!victim) return;
    const d = { item: item.id, a: p.id, b: victim.id, t: DUEL_SECONDS, ca: 0, cb: 0, tok: { [p.id]: DUEL_TAP_BURST, [victim.id]: DUEL_TAP_BURST } };
    this.duels.set(item.id, d);
    p.duel = item.id; victim.duel = item.id;
    const label = ITEM_TYPES[item.type].label.toLowerCase();
    this.event({ kind: 'duel', item: item.id, a: p.id, b: victim.id });
    const what = item.type === 'dolly' || item.type === 'flatdolly' ? `${victim.name}'s ${label}` : one ? `the ${label} ${victim.name} is carrying` : `${victim.name}'s end of the ${label}`;
    this.event({ kind: 'toast', text: `⚔️ ${p.name} is trying to steal ${what}! TAP TAP TAP!`, cls: 'help' });
  }
  duelTap(p) {
    if (!p?.duel) return;
    const d = this.duels?.get(p.duel);
    if (!d) return;
    if ((d.tok[p.id] ?? 0) < 1) return; // over the allowance: an autoclicker
    d.tok[p.id] -= 1;
    this.duelPoint(d, p);
  }
  /** one tap: worth as much as you have energy left (a worn-out mover barely moves the bar), and it tires you */
  duelPoint(d, p) {
    const e = p.energy ?? 1, w = Math.max(0.15, e);
    if (p.id === d.a) d.ca += w; else if (p.id === d.b) d.cb += w;
    p.energy = Math.max(0, e - DUEL_TAP_COST);
  }
  updateDuels(dt) {
    if (!this.duels?.size) return;
    for (const [id, d] of this.duels) {
      const a = this.players.get(d.a), b = this.players.get(d.b), item = this.items.get(id);
      for (const k of [d.a, d.b]) d.tok[k] = Math.min(DUEL_TAP_BURST, (d.tok[k] ?? 0) + dt * DUEL_TAP_RATE);
      for (const who of [a, b]) { // AI movers mash too, at a human pace set by difficulty: a slow start, and they tire
        const bot = who && this.bots.get(who.id);
        if (!bot) continue;
        const into = DUEL_SECONDS - d.t;
        if (into < 0.45) continue; // reaction time
        const rate = ({ easy: 3, normal: 4.5, hard: 5.5 }[bot.difficulty] || 4.5) * (1 - 0.35 * Math.min(1, into / DUEL_SECONDS));
        bot.duelAcc = (bot.duelAcc || 0) + dt * rate * (0.75 + Math.random() * 0.5);
        while (bot.duelAcc >= 1) { bot.duelAcc -= 1; this.duelPoint(d, who); }
      }
      d.t -= dt;
      const held = this.stillHolds(item, b);
      const over = d.t <= 0 || !a || !this.isActive(a) || !item || !held;
      if (!over) continue;
      this.duels.delete(id);
      if (a) a.duel = null; if (b) b.duel = null;
      const label = item ? ITEM_TYPES[item.type].label.toLowerCase() : '';
      if (!a || !item || !held) { this.event({ kind: 'duelEnd', item: id, a: d.a, b: d.b, ca: d.ca, cb: d.cb }); continue; } // it got dropped or loaded mid-fight: nothing to win
      const free = !a.carry && !a.dolly && !a.flatDolly && this.isActive(a);
      if ((d.ca > d.cb || !this.isActive(b)) && free) {
        const dollyKind = item.type === 'dolly' ? 'dolly' : item.type === 'flatdolly' ? 'flatDolly' : null;
        if (dollyKind) { // the dolly and everything on it change hands
          item.pusher = a.id; b[dollyKind] = null; a[dollyKind] = id;
          if (item.type === 'flatdolly') item.wobble = 0;
          this.event({ kind: 'emote', id: a.id, e: item.type === 'dolly' ? '🛒' : '🛞' });
          this.event({ kind: 'toast', text: `⚔️ ${a.name} wins ${Math.round(d.ca)}–${Math.round(d.cb)} and takes ${b.name}'s ${label}${item.stack?.length || item.piece ? ', load and all' : ''}!` });
        } else {
          item.carriers[item.carriers.indexOf(d.b)] = a.id;
          if (b.carry === id) b.carry = null;
          a.carry = id;
          this.event({ kind: 'emote', id: a.id, e: '💪' });
          this.event({ kind: 'toast', text: `⚔️ ${a.name} wins ${Math.round(d.ca)}–${Math.round(d.cb)} and takes ${ITEM_TYPES[item.type].teamCarry ? `${b.name}'s end of the ${label}` : `the ${label} from ${b.name}`}!` });
        }
      } else {
        this.event({ kind: 'toast', text: `🛡️ ${b?.name || 'The carrier'} holds on ${Math.round(d.cb)}–${Math.round(d.ca)}! The ${label} stays put.` });
      }
      this.event({ kind: 'duelEnd', item: id, a: d.a, b: d.b, ca: d.ca, cb: d.cb });
    }
  }

  // ---------- the furniture dolly (flat, four wheels): one two-mover piece, moved solo, single use ----------
  flatOf(p) { return p.flatDolly ? this.items.get(p.flatDolly) : null; }
  /** how far ahead of the pusher the dolly's centre sits (half the load's length, lengthwise) */
  flatReach(fd) { const pc = fd.piece && this.items.get(fd.piece), t = pc && ITEM_TYPES[pc.type]; return 0.55 + (t ? Math.max(t.w, t.d) * 0.5 : FLAT_LEN / 2); }
  flatBlocked(p, fd) {
    const pc = fd.piece && this.items.get(fd.piece), t = pc && ITEM_TYPES[pc.type];
    const len = t ? Math.max(t.w, t.d) : FLAT_LEN, off = this.flatReach(fd), sx = Math.sin(p.face), sz = Math.cos(p.face);
    for (const k of [off - len / 2 + 0.3, off, off + len / 2 - 0.3]) if (this.level.hitsWall(p.x + sx * k, p.z + sz * k, 0.42)) return true;
    return false;
  }
  syncFlatPiece(fd) { const pc = fd.piece && this.items.get(fd.piece); if (pc) { pc.x = fd.x; pc.z = fd.z; } for (const id of fd.stack || []) { const b = this.items.get(id); if (b) { b.x = fd.x; b.z = fd.z; } } }
  flatTap(p) {
    const d = this.flatOf(p);
    d.stack ||= [];
    if (!d.piece) {
      // the nearest thing it can take: a box (up to four, 2x2) or, while it's empty, one piece of furniture
      let best = null, bd = REACH + 0.6;
      for (const it of this.items.values()) {
        if (it.state !== 'floor') continue;
        const t = ITEM_TYPES[it.type], box = BOX_TYPES.includes(it.type);
        if (!box && (!t.furniture || t.tool || d.stack.length)) continue;
        const dd = dist(p, it) - (box ? 0 : Math.max(t.w, t.d) * 0.35);
        if (dd < bd) { bd = dd; best = it; }
      }
      if (best && BOX_TYPES.includes(best.type)) {
        if (d.stack.length >= FLAT_MAX_BOXES) return this.tell(p, `The furniture dolly is full (${FLAT_MAX_BOXES} boxes). Push it to the truck, and easy on the corners.`);
        best.state = 'flat'; best.flatId = d.id; best.carriers = []; d.stack.push(best.id); this.syncFlatPiece(d);
        this.event({ kind: 'emote', id: p.id, e: '📦' });
        if (d.stack.length === FLAT_MAX_BOXES) this.tell(p, 'Fully loaded: too fast for too long, or a sharp turn, and a box slides off. Fragile ones break; standard after two falls, heavy after three.');
        return;
      }
      if (best?.assembled) return this.tell(p, `Hold ACTION to take the ${ITEM_TYPES[best.type].label.toLowerCase()} apart first, then load it on the dolly.`);
      if (best) {
        best.state = 'flat'; best.flatId = d.id; best.carriers = []; d.piece = best.id; this.syncFlatPiece(d);
        this.event({ kind: 'emote', id: p.id, e: '🛞' });
        this.tell(p, `${ITEM_TYPES[best.type].label} on the furniture dolly. Push it to the truck!`);
        return;
      }
    }
    this.dropFlat(p); // nothing to load (or already loaded): set it down where you are
  }
  /** A full load (4 boxes) wobbles when pushed flat out for too long or swung round a corner; at the limit the top box
   *  slides off. Easing off settles it. Fragile boxes break on the first fall, standard on the second, heavy on the third. */
  flatWobble(p, fd, dt, ox, oz, of) {
    const loaded = (fd.stack?.length || 0) >= FLAT_MAX_BOXES || (this.sab && fd.piece); // sabotage: a piece of furniture can slide off too
    if (!loaded) { fd.wobble = Math.max(0, (fd.wobble || 0) - dt * 0.5); return; }
    const moved = Math.hypot(p.x - ox, p.z - oz) / Math.max(dt, 1e-3);
    let turn = Math.abs(p.face - of); if (turn > Math.PI) turn = 2 * Math.PI - turn;
    const turnRate = turn / Math.max(dt, 1e-3), push = Math.hypot(p.in.mx, p.in.mz);
    let w = fd.wobble || 0;
    if (moved > 0.4 && (push > 0.85 || p.dashT > 0)) w += dt * (p.dashT > 0 ? 0.7 : 0.3); // flat out: ~3 s, dashing much sooner
    if (moved > 0.4 && turnRate > 4) w += turn * 0.22;                                      // a sharp swing round a corner
    if (moved <= 0.4 || (push < 0.6 && turnRate < 2)) w -= dt * 0.35;                       // taking it steady settles it
    fd.wobble = Math.max(0, w);
    if (fd.wobble >= 1) { fd.wobble = 0.5; if (this.sab && fd.piece) this.sab.pieceFalls(p, fd); else this.spillFromFlat(p, fd); }
  }
  spillFromFlat(p, fd) {
    const id = fd.stack.pop(), box = id && this.items.get(id);
    if (!box) return;
    const side = Math.random() < 0.5 ? -1 : 1, sx = Math.cos(p.face) * side, sz = -Math.sin(p.face) * side;
    let x = fd.x + sx * 1.0, z = fd.z + sz * 1.0;
    if (this.level.hitsWall(x, z, 0.45)) { x = fd.x - sx * 1.0; z = fd.z - sz * 1.0; }
    if (this.level.hitsWall(x, z, 0.45)) { x = p.x; z = p.z; }
    Object.assign(box, { state: 'floor', flatId: null, x: +x.toFixed(2), z: +z.toFixed(2) });
    box.falls = (box.falls || 0) + 1;
    const limit = { fragile: 1, standard: 2, heavy: 3 }[box.type] || 2, label = ITEM_TYPES[box.type].label.toLowerCase();
    if (box.falls >= limit) {
      p.score -= ITEM_TYPES[box.type].pts;
      box.state = 'broken';
      this.recordBreak(box, [p.id], 'fell off the furniture dolly');
      this.respawn(box);
      return;
    }
    this.event({ kind: 'emote', id: p.id, e: '😬' });
    this.tell(p, `A ${label} slid off the dolly! ${limit - box.falls === 1 ? 'One more fall and it breaks.' : `${limit - box.falls} more falls and it breaks.`}`);
  }
  dropFlat(p) {
    const d = this.flatOf(p);
    p.flatDolly = null;
    if (!d) return;
    d.state = 'floor'; d.pusher = null;
    if (this.level.hitsWall(d.x, d.z, 0.5) || inRamp(d.x, d.z)) { d.x = p.x - 1.3; d.z = p.z; }
    this.syncFlatPiece(d);
  }
  flatBack(p, item) {
    const d = this.items.get(p.flatFeeding);
    p.flatFeeding = null; p.carry = null; p.loadMode = false; p.rampLock = true; p.slotTo = null;
    if (!d || !item) return;
    item.state = 'flat'; item.flatId = d.id; item.carriers = []; d.piece = item.id;
    d.state = 'pushed'; d.pusher = p.id; p.flatDolly = d.id; this.syncFlatPiece(d);
  }
  /** the piece is in the truck: the furniture dolly is spent and turns up elsewhere in 5 s */
  finishFlat(p) {
    const d = this.items.get(p.flatFeeding);
    p.flatFeeding = null; p.flatDolly = null;
    if (!d) return;
    Object.assign(d, { state: 'gone', pusher: null, piece: null, respawnAt: (this.elapsed || 0) + 5 });
    this.event({ kind: 'toast', text: '🛞 Furniture dolly used up. Another one turns up in the house in 5 s.' });
  }
  updateFlatDolly() {
    const d = this.items.get('flatdolly');
    if (d?.state !== 'gone' || (this.elapsed || 0) < d.respawnAt) return;
    const spot = freeSpot(this.level, [...this.items.values()].filter(i => i.state === 'floor').map(i => ({ x: i.x, z: i.z })), Math.random, 0);
    Object.assign(d, { state: 'floor', x: spot.x, z: spot.z });
    this.event({ kind: 'toast', text: `🛞 A furniture dolly is waiting in the ${this.level.roomAt(spot.x, spot.z)}.` });
  }

  // ---------- the dolly ----------
  dollyOf(p) { return p.dolly ? this.items.get(p.dolly) : null; }

  dollyTap(p) {
    const d = this.dollyOf(p);
    let box = null, bd = REACH;
    for (const it of this.items.values()) {
      if (it.state !== 'floor' || !['standard', 'heavy', 'fragile'].includes(it.type)) continue;
      const dd = Math.min(dist(p, it), dist(d, it)); if (dd < bd) { bd = dd; box = it; } // within reach of you or of the dolly's nose
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

  /** Carrying a box (or a piece of furniture) next to a parked dolly that has room: it goes on the dolly. */
  putOnDolly(p, item) {
    const t = ITEM_TYPES[item.type], isBox = BOX_TYPES.includes(item.type);
    if (!isBox && !(t.furniture && !(t.needsDisassemble && item.assembled))) return false;
    const near = ['dolly', 'flatdolly'].map(id => this.items.get(id)).filter(dl => dl && dl.state === 'floor' && dist(p, dl) <= REACH + 0.2)
      .sort((a, b) => dist(p, a) - dist(p, b));
    for (const dl of near) {
      const two = dl.type === 'dolly';
      const room = two ? isBox && dl.stack.length < 3 : !dl.piece && (isBox ? (dl.stack?.length || 0) < FLAT_MAX_BOXES : !(dl.stack?.length));
      if (!room) continue;
      for (const id of item.carriers) { const o = this.players.get(id); if (o) { o.carry = null; o.loadMode = false; } }
      item.carriers = [];
      if (two) { Object.assign(item, { state: 'dolly', dollyId: dl.id }); dl.stack.push(item.id); this.syncDollyStack(dl); }
      else { Object.assign(item, { state: 'flat', flatId: dl.id }); if (isBox) (dl.stack ||= []).push(item.id); else dl.piece = item.id; this.syncFlatPiece(dl); }
      this.event({ kind: 'emote', id: p.id, e: two ? '🛒' : '🛞' });
      return true;
    }
    return false;
  }

  /** Hold next to a parked, loaded dolly: its top box (or its piece of furniture) comes off into your hands, to restack. */
  takeOffDolly(p, dl) {
    let id;
    if (dl.type === 'dolly') id = dl.stack.pop();
    else if (dl.piece) { id = dl.piece; dl.piece = null; dl.wobble = 0; }
    else id = dl.stack?.pop();
    const it = id && this.items.get(id);
    if (!it) return false;
    Object.assign(it, { state: 'carried', carriers: [p.id], dollyId: null, flatId: null, x: p.x, z: p.z });
    p.carry = it.id;
    this.event({ kind: 'emote', id: p.id, e: '📦' });
    return true;
  }
  parkedLoadedDolly(p) {
    return ['dolly', 'flatdolly'].map(id => this.items.get(id))
      .find(dl => dl && dl.state === 'floor' && dist(p, dl) <= 1.3 && (dl.stack?.length || dl.piece)) || null;
  }

  dropDolly(p) {
    const d = this.dollyOf(p);
    p.dolly = null;
    if (!d) return;
    d.state = 'floor'; d.pusher = null;
    if (this.level.hitsWall(d.x, d.z, 0.4) || inRamp(d.x, d.z)) { d.x = p.x - 1; d.z = p.z; }
    this.syncDollyStack(d);
  }
  /** boxes riding a dolly are wherever the dolly is (up the stairs included: they're on its floor, not left behind) */
  syncDollyStack(d) { for (const id of d.stack || []) { const b = this.items.get(id); if (b) { b.x = d.x; b.z = d.z; } } }

  /** next box off the dolly (top of the stack) into your hands, in the truck */
  feedFromDolly(p) {
    const d = p.feedFrom === 'flat' ? this.flatOf(p) : this.dollyOf(p);
    const id = d?.stack.pop();
    if (!id) return false;
    const box = this.items.get(id);
    box.state = 'carried'; box.carriers = [p.id]; box.dollyId = null; box.flatId = null; box.x = p.x; box.z = p.z;
    p.carry = id; p.loadMode = true; p.feeding = true;
    p.cursor = bestSpot(this.grid, box.type);
    return true;
  }

  finishDollyTrip(p) {
    if (p.feedFrom === 'flat') { p.feeding = false; p.feedFrom = null; p.tripPlaced = 0; return; } // the furniture dolly doesn't wear out on boxes
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
    if (p.flatDolly && !p.carry) { this.dropFlat(p); p.loadMode = false; return; }
    if (p.flatFeeding && p.carry) this.flatBack(p, this.items.get(p.carry)); // e.g. disconnected while placing: back on the dolly
    if (p.feeding && p.feedFrom === 'flat' && p.carry) { const d = this.flatOf(p), b = this.items.get(p.carry); if (d && b) { b.state = 'flat'; b.flatId = d.id; b.carriers = []; d.stack.push(b.id); p.carry = null; p.feeding = false; p.feedFrom = null; this.syncFlatPiece(d); } }
    const item = p.carry ? this.items.get(p.carry) : null;
    p.loadMode = false;
    if (!item) { p.carry = null; return; }
    for (const id of item.carriers) {
      const o = this.players.get(id);
      if (!o) continue;
      o.carry = null; o.loadMode = false;
      // carriers may brush a wall (they slide at 0.8 R): step them out by the overlap; only someone truly inside a wall goes to the piece
      if (this.level.hitsWall(o.x, o.z, R)) this.pushOutOfWalls(o);
      if (this.level.hitsWall(o.x, o.z, R * 0.8)) { o.x = item.x; o.z = item.z; }
    }
    item.carriers = [];
    item.state = 'floor';
    // never drop inside a wall or on the ramp
    if (this.level.hitsWall(item.x, item.z, 0.3) || inRamp(item.x, item.z)) { item.x = p.x - 1; item.z = p.z; }
  }

  /** Nudge a mover out of any wall it overlaps by a few centimetres (a small step, never a jump). */
  pushOutOfWalls(o) {
    for (let pass = 0; pass < 3; pass++) {
      let moved = false;
      for (const w of this.level.walls) {
        const cx = Math.max(w.x0, Math.min(o.x, w.x1)), cz = Math.max(w.z0, Math.min(o.z, w.z1));
        const dx = o.x - cx, dz = o.z - cz, d = Math.hypot(dx, dz);
        if (d >= R || d < 1e-6) continue;
        const push = R - d + 0.01; o.x += dx / d * push; o.z += dz / d * push; moved = true;
      }
      if (!moved) return;
    }
  }

  /** What a mover is hauling right now, for the energy meter: [drain key, top speed multiplier for that load]. */
  loadOf(p) {
    if (p.flatDolly) return ['flatDolly', 0.8];
    const item = p.carry ? this.items.get(p.carry) : null;
    if (!item) return this.dollyOf(p) ? ['dolly', 0.85] : null;
    const t = ITEM_TYPES[item.type];
    if (item.carriers.length > 1) return ['team', 0.7];
    if (t.teamCarry) return ['soloLift', 0.4];
    return [t.heavy ? 'heavy' : item.type === 'lamp' ? 'lamp' : item.type === 'fragile' ? 'fragile' : 'standard', t.heavy ? 0.6 : 1];
  }

  /** Energy: carrying drains it (faster the faster you go), standing still refills it; empty = a short injury. */
  updateEnergy(dt) {
    for (const p of this.players.values()) {
      if (p.energy === undefined) p.energy = 1;
      if (p.injuredT > 0) { p.injuredT = Math.max(0, p.injuredT - dt); if (!p.injuredT) this.tell(p, '💪 Feeling better. Back to full speed.'); }
      if (!this.isActive(p)) continue;
      const speed = Math.hypot(p.x - (p.px ?? p.x), p.z - (p.pz ?? p.z)) / dt;
      const load = p.loadMode ? null : this.loadOf(p);
      if (load && speed > 0.15) {
        const ratio = speed / (SPEED * load[1]);
        p.energy -= ENERGY.drain[load[0]] * ratio * ratio * dt;
      } else if (!p.duel) { // no catching your breath mid tap battle
        p.energy += (speed > 0.15 ? ENERGY.regenWalk : ENERGY.regenStill) * dt;
      }
      p.energy = Math.min(1, p.energy);
      if (p.energy <= 0) {
        if (this.tutorialMode) { p.energy = 0.05; continue; } // training: no injuries, just a warning bar
        p.energy = 0.5;
        p.injuredT = ENERGY.injurySecs;
        const what = ENERGY.injuries[Math.floor(Math.random() * ENERGY.injuries.length)];
        this.event({ kind: 'emote', id: p.id, e: '🤕' });
        this.event({ kind: 'toast', text: `🤕 ${p.name} ${what}! Slowed down for ${ENERGY.injurySecs} s. Pace yourselves.` });
        if (!this.demo && !p.bot) MoveRoom.store?.event('injury').catch(() => {});
      }
    }
  }

  updateTeamCarries(dt) {
    for (const item of this.items.values()) {
      if (item.state !== 'carried') continue;
      const cs = item.carriers.map(id => this.players.get(id)).filter(Boolean);
      if (cs.length < 2) { item.axis = undefined; continue; }
      if (cs[0].loadMode || this.duels?.has(item.id)) continue; // tug-of-war: nobody moves
      let mx = 0, mz = 0;
      for (const c of cs) { mx += c.in.mx; mz += c.in.mz; }
      mx /= cs.length; mz /= cs.length;
      const off = this.carryOffset(item);
      if (item.axis === undefined) item.axis = Math.atan2(cs[1].z - cs[0].z, cs[1].x - cs[0].x);
      const spots = (x, z, a) => [[x - Math.cos(a) * off, z - Math.sin(a) * off], [x + Math.cos(a) * off, z + Math.sin(a) * off]];
      const clear = (x, z, a) => !this.level.hitsWall(x, z, 0.45) && spots(x, z, a).every(([sx, sz]) => !this.level.hitsWall(sx, sz, R * 0.8));
      // squeezed already, or wedged for a second (a doorway at the wrong angle): let the furniture itself through;
      // the carriers still walk round and never stand in a wall
      const wedged = (item.blockedT || 0) > 1;
      const stuckNow = wedged || !clear(item.x, item.z, item.axis);
      const ok = (x, z, a) => clear(x, z, a) || (stuckNow && !this.level.hitsWall(x, z, 0.45));
      const bx = item.x, bz = item.z;
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
      if (moving && Math.hypot(item.x - bx, item.z - bz) < sp * 0.2) item.blockedT = (item.blockedT || 0) + dt; else if (moving) item.blockedT = Math.max(0, (item.blockedT || 0) - dt * 2);
      const sp2 = spots(item.x, item.z, item.axis), maxStep = SPEED * dt;
      let lost = false;
      cs.slice(0, 2).forEach((c, k) => { // walk into position (sliding along walls); never jump
        const [tx, tz] = sp2[k], dx = tx - c.x, dz = tz - c.z, d = Math.hypot(dx, dz);
        const nx2 = d <= maxStep ? tx : c.x + dx / d * maxStep, nz2 = d <= maxStep ? tz : c.z + dz / d * maxStep;
        if (!this.level.hitsWall(nx2, c.z, R * 0.8)) c.x = nx2;
        if (!this.level.hitsWall(c.x, nz2, R * 0.8)) c.z = nz2;
        c.face = moving ? Math.atan2(mx, mz) : Math.atan2(item.x - c.x, item.z - c.z);
        if (Math.hypot(tx - c.x, tz - c.z) > 3) lost = true;
      });
      if (lost) { // someone got stuck round a corner: they lose their grip and the piece is set down
        this.event({ kind: 'toast', text: `😬 Lost grip on the ${ITEM_TYPES[item.type].label.toLowerCase()}! Set it down and lift again.` });
        this.releaseCarry(cs[0]);
        continue;
      }
      // a tap from either carrier sets it down
      if (cs.some(c => c.pending.tapN)) this.releaseCarry(cs[0]);
    }
  }

  /** Past the middle of a flight you're on the next floor (a different strip of the map, same spot on screen).
   *  Whatever you hold comes with you; a team lift moves when the piece itself crosses, carriers and all. */
  applyStairs() {
    const L = this.level;
    if (!(L.floors > 1)) return;
    const move = (o, dz) => { o.z += dz; if (o.pz !== undefined) o.pz += dz; };
    for (const p of this.players.values()) {
      if (p.loadMode) continue;
      const item = p.carry ? this.items.get(p.carry) : null;
      if (item && item.carriers.length > 1) continue;
      const dz = L.stairShift(p.x, p.z);
      if (!dz) continue;
      move(p, dz);
      if (item) move(item, dz);
      const dly = this.dollyOf(p), fd = this.flatOf(p);
      if (dly) { move(dly, dz); this.syncDollyStack(dly); } // its boxes change floor with it
      if (fd) { move(fd, dz); this.syncFlatPiece(fd); }
    }
    for (const item of this.items.values()) {
      if (item.state === 'carried' && item.carriers.length > 1) {
        const dz = L.stairShift(item.x, item.z);
        if (!dz) continue;
        move(item, dz);
        for (const id of item.carriers) { const c = this.players.get(id); if (c) move(c, dz); }
      } else if (item.state === 'floor') { const dz = L.stairShift(item.x, item.z); if (dz) move(item, dz); } // set down on the stairs: it rests on that step
    }
  }

  carryOffset(item) { const t = ITEM_TYPES[item.type]; return Math.max(t.w, t.d) * 0.48 + 0.1; }

  updateTasks(dt) {
    for (const it of this.items.values()) it.helpers = [];
    for (const p of this.players.values()) {
      p.task = null;
      if (this.sab && this.isActive(p) && p.in.hold && this.sab.onHold(p, dt)) continue; // packing, repairs, sabotage holds
      if (!p.in.hold) p.unstackT = 0;
      if (!this.isActive(p) || p.carry || !p.in.hold) continue;
      const dl = !p.dolly && !p.flatDolly ? this.parkedLoadedDolly(p) : null;
      if (dl) { // hold by a loaded dolly: take the top thing off (restack)
        p.unstackT = (p.unstackT || 0) + dt; p.task = { id: dl.id, kind: 'unstack' };
        if (p.unstackT >= 0.4) { p.unstackT = 0; this.takeOffDolly(p, dl); }
        continue;
      }
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
      const secs = (kind === 'wrap' ? RULES.WRAP_SECONDS : RULES.DISASSEMBLE_SECONDS + (it.jam || 0)) * (p.injuredT > 0 ? 1.6 : 1);
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
    const ors = orientations(item.type), nOr = ors.length;
    // ROTATE turns the piece on the same side (same height); FLIP tips it onto another side (lying flat / on its side / standing up)
    const turn = (sameSide) => {
      const h0 = ors[((c.rot % nOr) + nOr) % nOr].h;
      for (let k = 1; k < nOr; k++) { const j = (c.rot + k) % nOr; if ((ors[j].h === h0) === sameSide) return j; }
      return null;
    };
    if (nOr > 1 && (p.pending.rotN || p.pending.flipN)) {
      const j = p.pending.flipN ? turn(false) : (turn(true) ?? turn(false));
      const label = ITEM_TYPES[item.type].label;
      if (j === null) this.tell(p, p.pending.flipN ? `${label} only sits one way up. Rotate turns it.` : `${label} looks the same turned. Try flip.`);
      else { c.rot = j; const f = footprint(item.type, c.rot); this.tell(p, `${p.pending.flipN ? '⤾' : '↻'} ${label} ${ORIENT_LABEL(f)} (${f.w}×${f.d}×${f.h})`); }
    }
    const { w, d } = footprint(item.type, c.rot);
    c.gx = clamp(c.gx, 0, GRID.W - w);
    c.gz = clamp(c.gz, 0, GRID.D - d);

    if (p.pending.dashN && p.flatFeeding) { this.flatBack(p, item); return; } // BACK: the piece goes back on the furniture dolly
    if (p.pending.dashN && p.feeding) { // BACK: the box goes back on top of the dolly
      const flat = p.feedFrom === 'flat', d = flat ? this.flatOf(p) : this.dollyOf(p);
      if (flat) { item.state = 'flat'; item.flatId = d.id; } else { item.state = 'dolly'; item.dollyId = d.id; }
      item.carriers = []; d.stack.push(item.id); if (flat) this.syncFlatPiece(d);
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
    const SLOTS = [[11.4, -1.7], [11.4, -0.55], [11.4, 0.6], [11.4, 1.75], [10.3, -1.15], [10.3, 1.15]]; // a second row for crews of 5-6
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
    if (this.sab?.onBreak(item)) return; // sabotage: broken is gone for good
    const t = ITEM_TYPES[item.type];
    const taken = [...this.items.values()].filter(i => i.state === 'floor').map(i => ({ x: i.x, z: i.z }));
    const spot = freeSpot(this.level, taken);
    Object.assign(item, { state: 'floor', x: spot.x, z: spot.z, wrapped: false, assembled: !!t.needsDisassemble, carriers: [], earned: {}, g: null, task: null, value: 1, pulled: false, outsideT: 0, prevOwners: null, falls: 0, flatId: null, dollyId: null }); // a fresh one: no falls yet
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
    if (p.flatFeeding) this.finishFlat(p);
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
    if (this.movers().length <= 2) return; // 1v1: nobody else to accuse
    if ((this.elapsed || 0) < (this.meetingCdUntil || 0)) return this.tell(p, `Back to work first: the next meeting can be called in ${Math.ceil(this.meetingCdUntil - this.elapsed)} s.`);
    if (this.game === 'sabotage') {
      const now = Date.now();
      if (now - (p.lastMeeting || 0) < 20000) return this.tell(p, 'You called a meeting recently. Wait a bit.');
      p.lastMeeting = now;
    } else if (!this.breaks.some(b => !b.resolved && !b.discussed)) return this.tell(p, this.breaks.some(b => !b.resolved) ? 'The crew already talked about that crunch. Call out at the next one!' : 'Nothing is broken… yet. Call out when you hear a CRUNCH!');
    this.phase = 'meeting';
    this.meeting = { callerId, timeLeft: RULES.MEETING_SECONDS, votes: {}, botAt: {} };
    for (const id of this.bots.keys()) if (this.isActive(this.players.get(id))) this.meeting.botAt[id] = 3 + Math.random() * 9;
    for (const o of this.players.values()) { o.task = null; }
    this.event({ kind: 'meeting', caller: p.name });
    this.sab?.onMeetingStart();
  }

  castVote(p, t) {
    if (!this.meeting || !p || !this.isActive(p) || this.meeting.votes[p.id]) return;
    if (t !== 'skip' && !this.players.has(t)) return;
    this.meeting.votes[p.id] = t;
    p.votes = (p.votes || 0) + 1;
  }

  flooding(c) {
    const t = Date.now(), b = (this.msgBudget ||= new Map()).get(c.sessionId) || { tok: 200, at: t, over: 0 };
    b.tok = Math.min(200, b.tok + (t - b.at) * 0.08); b.at = t;
    this.msgBudget.set(c.sessionId, b);
    if (b.tok >= 1) { b.tok -= 1; b.over = Math.max(0, b.over - 0.01); return false; }
    if (++b.over > 400) { try { c.leave?.(4008, 'Too many messages'); } catch {} }
    return true;
  }

  say(p, raw) {
    const text = String(raw || '').replace(/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e]/g, '').trim().slice(0, 120); // shown as plain text everywhere, so <b> stays <b>; control/direction characters go
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
    this.endMeeting();
  }

  /** back to work: every crunch so far has had its meeting, and nobody can call another for 30 s of play */
  endMeeting() {
    this.meeting = null;
    this.phase = 'playing';
    for (const b of this.breaks) b.discussed = true;
    this.meetingCdUntil = (this.elapsed || 0) + 30;
    this.sab?.onMeetingEnd();
  }

  resolveSabotageVote(target, votes) {
    this.endMeeting();
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
    if (this.sab) { // sabotage has its own endings and no clock
      const r = this.sab.checkEnd();
      if (r) this.endRound(r.reason, null, r.winner);
      return;
    }
    const all = [...this.items.values()];
    const remaining = all.filter(i => !ITEM_TYPES[i.type].tool && (i.state === 'floor' || i.state === 'carried' || i.state === 'dolly' || i.state === 'flat'));
    let filled = 0;
    for (const col of this.grid.cells) for (const stack of col) for (const c of stack) if (c) filled++;
    if (this.fitCache?.v !== this.gridVersion || this.fitCache?.n !== remaining.length) {
      this.fitCache = { v: this.gridVersion, n: remaining.length, fits: canFitAny(this.grid, remaining.map(i => i.type)) };
    }
    let doneReason = null;
    if (this.isExact()) {
      const gaps = gridGaps(this.grid);
      if (filled === GRID.W * GRID.D * GRID.H) doneReason = 'Perfect load! The truck is packed to the roof.';
      else if (!remaining.length) doneReason = 'Full load! Everything is in the truck.';
      else if (gaps.empty <= 2 && gaps.open === 0) doneReason = `Full load! Only ${gaps.empty === 1 ? 'one gap' : 'two gaps'} left, buried in the load.`; // holes under the load can't be reached; holes at the top still can
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
    this.driveT = check.damaged.length ? 8 : 6; // ramp in, shutter down, then the drive
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
    const teams = this.teamScores()?.sort((a, b) => b.score - a.score) || null;
    const tie = teams && teams.length > 1 && teams[0].score === teams[1].score;
    const teamWinner = !teams ? null : forcedWinnerId ? this.players.get(forcedWinnerId)?.team || null : tie ? null : teams[0].t; // a tie: no team wins
    if (teams) winner = teamWinner ? players.find(p => this.players.get(p.id)?.team === teamWinner) || null : null; // the team's top scorer
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
      teams, winTeam: teamWinner, game: this.game, winners, saboteurId: sab?.id || null, saboteurName: sab?.name || null, crewScore: this.game === 'sabotage' ? this.crewScore() : null };
    for (const p of this.players.values()) { p.carry = null; p.loadMode = false; p.task = null; }
    this.event({ kind: 'end' });
    this.recordResults();
    if (this.quick) { if (this.listing) Promise.resolve().then(() => this.unlock()).catch(() => {}); this.autoStartAt = 30; }
  }

  /** did this mover actually play? loaded or helped lift something, wrapped, repacked, or (sabotage) voted in a meeting */
  tookPart(p) { return (p.loaded || 0) + (p.helps || 0) + (p.wraps || 0) + (p.unloads || 0) + (p.votes || 0) > 0; }

  /** Save stats + leaderboard entries for human players (never blocks the game). */
  recordResults() {
    const store = MoveRoom.store, r = this.results;
    if (!store || !r || this.demo) return;
    store.event('round_end').catch(() => {});
    for (const p of this.players.values()) {
      if (p.bot || p.spectator || !p.email) continue;
      if (!this.tookPart(p)) continue; // AFK: standing around all round doesn't count as a move (unlocks are earned)
      const won = r.teams ? !!r.winTeam && p.team === r.winTeam : r.game === 'sabotage' ? (r.winners === 'saboteur' ? p.id === r.saboteurId : p.id !== r.saboteurId && r.winners === 'crew') : r.winnerId === p.id;
      store.recordGame(p.email, { won, loaded: p.loaded }).catch(() => {});
      if (this.level?.daily) store.addScore({ day: this.level.daily, email: p.email, name: p.name, score: p.score, detail: `${this.level.name} · ${this.mode === 'load' ? 'Full load' : this.mode}` }).catch(() => {});
    }
  }

  /** The server is about to restart (a new version going live): tell everyone first, so it isn't a mystery freeze. */
  onBeforeShutdown() {
    this.event({ kind: 'restart' });
    this.broadcastSnap?.();
    return new Promise(res => setTimeout(() => { this.disconnect(4001).catch(() => {}).finally(res); }, 600));
  }

  onUncaughtException(err, method) {
    console.error('room error in', method, err);
    MoveRoom.store?.logError({ where: 'room:' + method, message: err.message, stack: err.stack, ua: '' }).catch(() => {});
  }

  /** Send the snapshot with only the items that changed since the last one; every item again once a second, when someone
   *  joins and when the house changes (clients merge with shared/snap.js). Cuts the bytes per update about three-fold. */
  broadcastSnap() {
    const s = this.snapshot();
    this.snapN = (this.snapN || 0) + 1;
    if (this.forceFull || !this.sentItems || this.snapN % (this.demo ? 7 : 20) === 0) {
      this.sentItems = new Map(s.items.map(it => [it.id, JSON.stringify(it)]));
      this.forceFull = false;
    } else {
      const changed = [];
      for (const it of s.items) { const k = JSON.stringify(it); if (this.sentItems.get(it.id) !== k) { changed.push(it); this.sentItems.set(it.id, k); } }
      s.items = changed; s.itemsDelta = true;
    }
    this.broadcast('snap', s);
  }

  snapshot() {
    const players = [...this.players.values()].map(p => ({
      id: p.id, name: p.name, char: p.char, x: +p.x.toFixed(2), z: +p.z.toFixed(2), face: +p.face.toFixed(2),
      carry: p.carry, loadMode: p.loadMode, cursor: p.loadMode ? p.cursor : null, score: p.score, strikes: p.strikes,
      out: p.out, spectator: p.spectator, task: p.task, team: p.team || 0, unloading: !!p.unloading, dolly: p.dolly || null, flatDolly: p.flatDolly || null, dashCd: +p.dashCd.toFixed(1), dashing: p.dashT > 0, energy: +(p.energy ?? 1).toFixed(2), injured: +(p.injuredT || 0).toFixed(1),
      room: this.level.roomAt(p.x, p.z), setup: p.setup || null, bot: !!p.bot, away: !!p.away, suit: p.suit || 'classic', ready: !!p.ready,
    }));
    const items = [...this.items.values()].filter(i => i.state !== 'broken').map(i => ({
      id: i.id, type: i.type, x: +i.x.toFixed(2), z: +i.z.toFixed(2), state: i.state, wrapped: i.wrapped,
      assembled: i.assembled, g: i.g, n: i.carriers.length, damaged: i.damaged ? 1 : 0, ...(i.pulled && i.value < 1 ? { value: +i.value.toFixed(2) } : {}),
      ...(i.type === 'dolly' ? { stack: i.stack, uses: i.uses, strain: i.strain, pusher: i.pusher } : {}), ...(i.state === 'dolly' ? { on: i.dollyId } : {}), ...(i.type === 'flatdolly' ? { piece: i.piece, pusher: i.pusher, stack: i.stack || [], wobble: +(i.wobble || 0).toFixed(2) } : {}), ...(i.state === 'flat' ? { on: i.flatId } : {}),
      task: i.task ? { kind: i.task.kind, p: +i.task.progress.toFixed(2) } : null,
    }));
    return {
      phase: this.phase, mode: this.mode, hostId: this.hostId, timeLeft: Math.max(0, Math.round(this.timeLeft)),
      countdown: this.phase === 'countdown' ? Math.ceil(this.countdown) : 0, driveT: this.phase === 'driveoff' ? +this.driveT.toFixed(2) : 0,
      canCallOut: this.canCallOut(),
      game: this.game, overtime: !!this.overtime, sab: this.sab ? this.sab.snapshot() : null, crewScore: this.game === 'sabotage' ? this.crewScore() : null,
      duels: [...(this.duels?.values() || [])].map(d => ({ item: d.item, a: d.a, b: d.b, t: +Math.max(0, d.t).toFixed(1), ca: +d.ca.toFixed(1), cb: +d.cb.toFixed(1) })),
      quick: this.quick, autoStart: this.quick && this.autoStartAt > 0 ? Math.ceil(this.autoStartAt) : 0, twist: this.twist, zeroG: this.zeroG,
      daily: this.daily, tutorial: this.tutorial && this.tutorial.step >= 0 ? { step: this.tutorial.step, total: this.tutorial.total, text: this.tutorial.text, target: this.tutorial.target } : null,
      floors: this.floors,
      level: { seed: this.level.seed, code: this.level.classic || this.level.tutorial ? null : houseCode(this.level.seed), classic: !!this.level.classic, exact: !!this.level.exact, mansion: !!this.level.mansion, floors: this.level.floors || 1, tutorial: !!this.level.tutorial, daily: this.level.daily || null, name: this.level.name, rooms: this.level.rooms.length, yard: this.level.yardDistance }, difficulty: this.difficulty, solo: this.solo, crewSize: this.crewSize, teamN: this.teamN, teams: this.teamScores(),
      loadedCount: [...this.items.values()].filter(i => i.state === 'loaded').length, totalItems: this.items.size,
      players, items, cat: { x: +this.cat.x.toFixed(2), z: +this.cat.z.toFixed(2), face: this.cat.face || 0 },
      openBreaks: this.breaks.filter(b => !b.resolved).length,
      meeting: this.meeting ? { callerId: this.meeting.callerId, timeLeft: Math.ceil(this.meeting.timeLeft), voted: Object.keys(this.meeting.votes) } : null,
      results: this.phase === 'results' ? this.results : null,
    };
  }
}
