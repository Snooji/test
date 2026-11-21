import { Room, ServerError } from 'colyseus';
import { createGrid, placeItem, tallyVotes, ITEM_TYPES, RULES, GRID, footprint } from '../shared/logic.js';
import { ITEM_SPAWNS, PLAYER_SPAWNS, CAT_WAYPOINTS, hitsWall, inRamp, roomAt } from '../shared/world.js';
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
  maxClients = 6; // 4 movers + 2 spectators

  onAuth(client, options) {
    const email = cleanEmail(options?.email);
    if (!verifyToken(email, options?.token)) throw new ServerError(401, 'Sign in at the gate first.');
    return { email, name: cleanName(options?.name) || 'Mover' };
  }

  onCreate() {
    this.phase = 'lobby';
    this.mode = '3min';
    this.players = new Map();
    this.items = new Map();
    this.breaks = [];
    this.grid = createGrid();
    this.hostId = null;
    this.meeting = null;
    this.results = null;
    this.timeLeft = 0;
    this.cat = { x: -5, z: -6, wp: 0 };
    this.seq = 0;
    this.resetWorld();

    this.onMessage('input', (c, m) => {
      const p = this.players.get(c.sessionId);
      if (!p || typeof m !== 'object') return;
      const mx = Number(m.mx) || 0, mz = Number(m.mz) || 0;
      const len = Math.hypot(mx, mz);
      p.in.mx = len > 1 ? mx / len : mx;
      p.in.mz = len > 1 ? mz / len : mz;
      p.in.hold = !!m.hold;
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
      if (c.sessionId === this.hostId && RULES.MODES[m?.mode] && this.phase !== 'playing') this.mode = m.mode;
    });
    this.onMessage('start', (c) => {
      if (c.sessionId !== this.hostId || this.phase === 'playing' || this.phase === 'meeting') return;
      this.startRound();
    });
    this.onMessage('lobby', (c) => {
      if (c.sessionId === this.hostId && this.phase === 'results') { this.phase = 'lobby'; this.resetWorld(); }
    });
    if (process.env.DEBUG_HOOKS === '1') {
      this.onMessage('debug_break', (c) => {
        const it = [...this.items.values()].find(i => i.state === 'floor' && i.type === 'fragile');
        if (it && this.phase === 'playing') { it.state = 'broken'; this.recordBreak(it, [c.sessionId], 'got crushed'); }
      });
    }
    this.onMessage('callout', (c) => this.callMeeting(c.sessionId));
    this.onMessage('vote', (c, m) => {
      const p = this.players.get(c.sessionId);
      if (!this.meeting || !p || !this.isActive(p) || this.meeting.votes[p.id]) return;
      const t = m?.target;
      if (t !== 'skip' && !this.players.has(t)) return;
      this.meeting.votes[p.id] = t;
    });
    this.onMessage('chat', (c, m) => {
      const p = this.players.get(c.sessionId);
      const text = String(m?.text || '').replace(/[<>]/g, '').trim().slice(0, 120);
      if (!p || !text) return;
      const now = Date.now();
      if (now - (p.lastChat || 0) < 600) return;
      p.lastChat = now;
      this.broadcast('chat', { from: p.name, char: p.char, text, meeting: !!this.meeting });
    });

    this.setSimulationInterval((dt) => this.tick(Math.min(dt, 100) / 1000), TICK);
  }

  onJoin(client, options, auth) {
    const used = new Set([...this.players.values()].map(p => p.char));
    const want = CHARS.includes(options?.char) && !used.has(options.char) ? options.char : CHARS.find(c => !used.has(c)) || 'nova';
    const movers = [...this.players.values()].filter(p => !p.spectator).length;
    const p = {
      id: client.sessionId, name: auth.name, char: want,
      x: 0, z: 0, face: 0, score: 0, strikes: 0, out: false,
      spectator: movers >= MAX_MOVERS || this.phase === 'playing' || this.phase === 'meeting',
      carry: null, loadMode: false, cursor: { gx: 1, gz: 0, rot: 0 }, cursorCd: 0,
      dashT: 0, dashCd: 0, loaded: 0, task: null,
      in: { mx: 0, mz: 0, hold: false, tapN: 0, dashN: 0, rotN: 0 },
      pending: { tapN: 0, dashN: 0, rotN: 0 },
    };
    this.placeAtSpawn(p, this.players.size);
    this.players.set(p.id, p);
    if (!this.hostId) this.hostId = p.id;
    this.event({ kind: 'toast', text: `${p.name} joined the crew${p.spectator ? ' (spectating this round)' : ''}` });
  }

  onLeave(client) {
    const p = this.players.get(client.sessionId);
    if (!p) return;
    this.releaseCarry(p);
    this.players.delete(p.id);
    if (this.hostId === p.id) this.hostId = this.players.keys().next().value || null;
    this.event({ kind: 'toast', text: `${p.name} left the crew` });
  }

  // ---------- world ----------
  resetWorld() {
    this.items.clear();
    this.grid = createGrid();
    this.breaks = [];
    this.meeting = null;
    ITEM_SPAWNS.forEach(([type, x, z], i) => {
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
      Object.assign(p, { score: 0, strikes: 0, out: false, carry: null, loadMode: false, loaded: 0, task: null, dashCd: 0, dashT: 0 });
      p.spectator = i >= MAX_MOVERS;
      this.placeAtSpawn(p, i++);
    }
    this.timeLeft = RULES.MODES[this.mode];
    this.results = null;
    this.phase = 'playing';
    this.event({ kind: 'start' });
  }

  isActive(p) { return p && !p.out && !p.spectator; }
  activePlayers() { return [...this.players.values()].filter(p => this.isActive(p)); }
  event(e) { this.broadcast('evt', e); }
  tell(p, text) { const c = this.clients.find(c => c.sessionId === p.id); c?.send('evt', { kind: 'toast', text, private: true }); }

  // ---------- simulation ----------
  tick(dt) {
    this.moveCat(dt);
    if (this.phase === 'playing') {
      this.timeLeft -= dt;
      for (const p of this.players.values()) this.updatePlayer(p, dt);
      this.updateTeamCarries(dt);
      this.updateTasks(dt);
      this.checkEnd();
    } else if (this.phase === 'meeting') {
      this.updateMeeting(dt);
    } else if (this.phase === 'lobby') {
      for (const p of this.players.values()) this.freeMove(p, dt, 1);
    }
    for (const p of this.players.values()) { p.pending.tapN = 0; p.pending.dashN = 0; p.pending.rotN = 0; }
    this.broadcast('snap', this.snapshot());
  }

  moveCat(dt) {
    const [tx, tz] = CAT_WAYPOINTS[this.cat.wp];
    const dx = tx - this.cat.x, dz = tz - this.cat.z, d = Math.hypot(dx, dz);
    if (d < 0.3) { this.cat.wp = Math.floor(Math.random() * CAT_WAYPOINTS.length); return; }
    const sp = 1.4 * dt;
    const nx = this.cat.x + dx / d * sp, nz = this.cat.z + dz / d * sp;
    if (hitsWall(nx, nz, 0.25)) { this.cat.wp = (this.cat.wp + 1) % CAT_WAYPOINTS.length; return; }
    this.cat.x = nx; this.cat.z = nz; this.cat.face = Math.atan2(dx, dz);
  }

  freeMove(p, dt, mult) {
    const { mx, mz } = p.in;
    if (Math.abs(mx) + Math.abs(mz) < 0.05) return;
    const sp = SPEED * mult * dt;
    const nx = p.x + mx * sp, nz = p.z + mz * sp;
    if (!hitsWall(nx, p.z, R)) p.x = nx;
    if (!hitsWall(p.x, nz, R)) p.z = nz;
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

    // carrying into the ramp → load mode (leader only for team carries)
    if (item && item.carriers[0] === p.id && inRamp(item.x, item.z)) {
      p.loadMode = true;
      p.cursor = { gx: 1, gz: 0, rot: 0 };
      p.cursorCd = 0.35; // grace so held movement doesn't jerk the cursor on entry
      this.tell(p, 'Aim with move · ACTION to drop · ROTATE to turn · BACK to leave');
      return;
    }

    if (p.pending.tapN) this.onTap(p, item);
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
      const d = dist(p, it) - (ITEM_TYPES[it.type].w > 1 ? 0.6 : 0);
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
      if (hitsWall(o.x, o.z, R)) { o.x = item.x; o.z = item.z; }
    }
    item.carriers = [];
    item.state = 'floor';
    // never drop inside a wall or on the ramp
    if (hitsWall(item.x, item.z, 0.3) || inRamp(item.x, item.z)) { item.x = p.x - 1; item.z = p.z; }
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
      if (!hitsWall(nx, item.z, 0.7)) item.x = nx;
      if (!hitsWall(item.x, nz, 0.7)) item.z = nz;
      cs[0].x = item.x - 0.95; cs[0].z = item.z; cs[0].face = Math.PI / 2;
      cs[1].x = item.x + 0.95; cs[1].z = item.z; cs[1].face = -Math.PI / 2;
      if (Math.abs(mx) + Math.abs(mz) > 0.05) { cs[0].face = cs[1].face = Math.atan2(mx, mz); }
      // a tap from either carrier sets it down
      if (cs.some(c => c.pending.tapN)) this.releaseCarry(cs[0]);
    }
  }

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
      if (!it.task || it.task.kind !== kind) it.task = { kind, progress: 0, contributors: [] };
      const secs = kind === 'wrap' ? RULES.WRAP_SECONDS : RULES.DISASSEMBLE_SECONDS;
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
    if (!item) { p.loadMode = false; return; }
    const c = p.cursor;
    p.cursorCd = Math.max(0, p.cursorCd - dt);
    const { mx, mz } = p.in;
    if (p.cursorCd <= 0 && (Math.abs(mx) > 0.5 || Math.abs(mz) > 0.5)) {
      if (Math.abs(mz) > 0.5) c.gx += Math.sign(mz);
      if (Math.abs(mx) > 0.5) c.gz -= Math.sign(mx); // pushing right = deeper toward the cab (gz 0)
      p.cursorCd = 0.18;
    }
    if (p.pending.rotN && ITEM_TYPES[item.type].w > 1) c.rot = (c.rot + 1) % 2;
    const { w, d } = footprint(item.type, c.rot);
    c.gx = clamp(c.gx, 0, GRID.W - w);
    c.gz = clamp(c.gz, 0, GRID.D - d);

    if (p.pending.dashN) { // BACK out of the truck
      p.loadMode = false;
      p.x -= 1.5; item.x = p.x; item.z = p.z;
      if (item.carriers.length > 1) item.x += 0.95;
      return;
    }
    if (p.pending.tapN) this.dropIntoTruck(p, item);
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
      return;
    }
    item.state = 'loaded';
    const rec = this.grid.items.get(item.id);
    item.g = { x: rec.x, y: rec.y, z: rec.z, w: rec.w, d: rec.d };
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
    }
  }

  recordBreak(item, culpritIds, how) {
    this.breaks.push({ id: item.id, type: item.type, culpritIds, resolved: false, at: Date.now() });
    this.seq++;
    this.event({ kind: 'crunch', text: `💥 CRUNCH! A ${ITEM_TYPES[item.type].label.toLowerCase()} ${how}. Who did it? Hit CALL OUT!`, itemType: item.type });
  }

  // ---------- meetings ----------
  callMeeting(callerId) {
    const p = this.players.get(callerId);
    if (this.phase !== 'playing' || this.meeting || !this.isActive(p)) return;
    if (!this.breaks.some(b => !b.resolved)) return this.tell(p, 'Nothing is broken… yet. Call out when you hear a CRUNCH!');
    this.phase = 'meeting';
    this.meeting = { callerId, timeLeft: RULES.MEETING_SECONDS, votes: {} };
    for (const o of this.players.values()) { o.task = null; }
    this.event({ kind: 'meeting', caller: p.name });
  }

  updateMeeting(dt) {
    const m = this.meeting;
    m.timeLeft -= dt;
    const active = this.activePlayers();
    if (m.timeLeft > 0 && !active.every(a => m.votes[a.id])) return;

    const target = tallyVotes(m.votes, m.callerId);
    const caller = this.players.get(m.callerId);
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

  // ---------- end ----------
  checkEnd() {
    const all = [...this.items.values()];
    const done = all.every(i => i.state === 'loaded' || i.state === 'broken');
    const noneLeft = this.activePlayers().length === 0 && this.players.size > 0;
    if (this.timeLeft <= 0 || done || noneLeft) this.endRound(done ? 'Truck loaded!' : noneLeft ? 'Everyone got kicked off the truck!' : "Time's up!");
  }

  endRound(reason) {
    this.phase = 'results';
    const players = [...this.players.values()].filter(p => !p.spectator)
      .map(p => ({ id: p.id, name: p.name, char: p.char, score: p.score, strikes: p.strikes, out: p.out, loaded: p.loaded }))
      .sort((a, b) => b.score - a.score);
    const winner = players.find(p => !p.out) || null;
    const loaded = [...this.items.values()].filter(i => i.state === 'loaded');
    const teamTotal = loaded.reduce((s, i) => s + Object.values(i.earned || {}).reduce((a, b) => a + b, 0), 0);
    const unresolved = this.breaks.filter(b => !b.resolved).map(b => ({
      type: ITEM_TYPES[b.type].label,
      culprits: b.culpritIds.map(id => this.players.get(id)?.name || 'a mover who left').join(' + '),
    }));
    this.results = { reason, players, winnerId: winner?.id || null, teamTotal, unresolved, loadedCount: loaded.length, totalItems: this.items.size, broken: this.breaks.length };
    for (const p of this.players.values()) { p.carry = null; p.loadMode = false; p.task = null; }
    this.event({ kind: 'end' });
  }

  snapshot() {
    const players = [...this.players.values()].map(p => ({
      id: p.id, name: p.name, char: p.char, x: +p.x.toFixed(2), z: +p.z.toFixed(2), face: +p.face.toFixed(2),
      carry: p.carry, loadMode: p.loadMode, cursor: p.loadMode ? p.cursor : null, score: p.score, strikes: p.strikes,
      out: p.out, spectator: p.spectator, task: p.task, dashCd: +p.dashCd.toFixed(1), dashing: p.dashT > 0,
      room: roomAt(p.x, p.z),
    }));
    const items = [...this.items.values()].filter(i => i.state !== 'broken').map(i => ({
      id: i.id, type: i.type, x: +i.x.toFixed(2), z: +i.z.toFixed(2), state: i.state, wrapped: i.wrapped,
      assembled: i.assembled, g: i.g, n: i.carriers.length,
      task: i.task ? { kind: i.task.kind, p: +i.task.progress.toFixed(2) } : null,
    }));
    return {
      phase: this.phase, mode: this.mode, hostId: this.hostId, timeLeft: Math.max(0, Math.round(this.timeLeft)),
      players, items, cat: { x: +this.cat.x.toFixed(2), z: +this.cat.z.toFixed(2), face: this.cat.face || 0 },
      openBreaks: this.breaks.filter(b => !b.resolved).length,
      meeting: this.meeting ? { callerId: this.meeting.callerId, timeLeft: Math.ceil(this.meeting.timeLeft), voted: Object.keys(this.meeting.votes) } : null,
      results: this.phase === 'results' ? this.results : null,
    };
  }
}
