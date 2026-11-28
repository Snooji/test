import { Client } from '@colyseus/sdk';
import { GameScene, TEAM_COLORS } from './scene.js';
const TEAM_NAMES = ['Orange', 'Teal', 'Purple'];
const teamChip = (t) => t ? `<span class="tchip" style="--tc:${TEAM_COLORS[t - 1]}">${TEAM_NAMES[t - 1]}</span>` : '';
import { Input, ACTIONS, keyName, PAD_LABEL } from './input.js';
import { mergeItems } from '../../shared/snap.js';
import { PORTRAITS, CHARACTERS, portrait, charInfo, CREW_ORDER, setPortrait } from './portraits.js';
import { renderClassicPortraits } from './voxel.js';
import { charUnlocked, unlockText, unlockProgress } from '../../shared/roster.js';
import { ITEM_TYPES, TIPS, footprint, orientations, ORIENT_LABEL, SUITS, suitUnlocked } from '../../shared/logic.js';
import { inRamp } from '../../shared/world.js';
import { sfx, setMuted, isMuted, setMusic, isMusicOn, musicMood } from './audio.js';
import { drawMinimap } from './minimap.js';
{ // the voxel crew's rendered portraits for the four classic movers
  document.body.classList.add('voxel');
  try { for (const [id, url] of Object.entries(renderClassicPortraits())) setPortrait(id, url); } catch (e) { console.warn('portraits', e); }
}

const $ = (id) => document.getElementById(id);
/** write only when it changes: no layout work when a snapshot repeats what's on screen (20 times a second) */
const setText = (id, v) => { const e = typeof id === 'string' ? $(id) : id; if (e.textContent !== v) e.textContent = v; };
const setHTML = (id, v) => { const e = typeof id === 'string' ? $(id) : id; if (e.dataset.html !== v) { e.dataset.html = v; e.innerHTML = v; } };
const show = (el, on = true) => (typeof el === 'string' ? $(el) : el).classList.toggle('hidden', !on);
const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const isTouch = matchMedia('(pointer: coarse)').matches;

const wsUrl = location.port === '5173' ? `ws://${location.hostname}:2567` : `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`;
const httpBase = location.port === '5173' ? `http://${location.hostname}:2567` : '';
const client = new Client(wsUrl);

let gate = null;
try { gate = JSON.parse(localStorage.getItem('sm_gate') || 'null'); } catch { gate = null; }
let room = null, snap = null, myId = null, lastPhase = null, myVote = null;
let prefChar = null, prefDiff = 'normal';
try { prefChar = localStorage.getItem('sm_char'); prefDiff = localStorage.getItem('sm_diff') || 'normal'; } catch {}
let reconnecting = false;
let myRole = null; // sabotage: true = saboteur, false = crew; told privately by the server
let myProfile = { games: 0, wins: 0, loaded: 0 };
let autoStartSent = false;
const todayUTC = () => new Date().toISOString().slice(0, 10);

// ---- funnel + error reporting (anonymous counters; no personal data) ----
/** who you are, sent in headers (never in the URL, which lands in server logs) */
const authHeaders = () => (gate ? { 'x-sm-email': gate.email, 'x-sm-token': gate.token, ...(gate.account ? { 'x-sm-account': gate.account } : {}) } : {});
const track = (name) => { try { navigator.sendBeacon?.(httpBase + '/api/event', new Blob([JSON.stringify({ name })], { type: 'application/json' })) || fetch(httpBase + '/api/event', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }), keepalive: true }); } catch {} };
let errorsSent = 0;
const reportError = (message, stack) => {
  if (errorsSent++ >= 5) return;
  fetch(httpBase + '/api/error', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: String(message).slice(0, 500), stack: String(stack || '').slice(0, 2000) }), keepalive: true }).catch(() => {});
};
addEventListener('error', (e) => reportError(e.message, e.error?.stack));
addEventListener('unhandledrejection', (e) => reportError(e.reason?.message || e.reason, e.reason?.stack));
track('visit');

const scene = new GameScene($('app'));
const input = new Input({
  onCallout: () => room?.send('callout'), onChatKey: () => focusChat(), onHelp: () => room?.send('help'),
  onMenu: () => { if (!$('hud').classList.contains('hidden')) (menuOpen ? closeGameMenu() : openGameMenu()); },
  onPad: (on) => { renderKeyHelp(); toast(on ? '🎮 Controller connected: left stick moves, A grab/drop (hold to wrap), B dash, X rotate, RB flip, Y help, LB call out, Start menu.' : '🎮 Controller disconnected.'); },
});

// ---------- gate ----------
$('gate-crew').innerHTML = Object.keys(PORTRAITS).map(k => portrait(k)).join('');
// emails this device has already proved (so signing back in doesn't need a new code)
const knownAccounts = () => { try { return JSON.parse(localStorage.getItem('sm_accts') || '{}'); } catch { return {}; } };
const rememberAccount = (email, account) => { if (!account) return; const a = knownAccounts(); a[email.toLowerCase()] = account; try { localStorage.setItem('sm_accts', JSON.stringify(a)); } catch {} };
let codeFor = null; // the email a code was sent to
const codeStep = (email) => {
  codeFor = email;
  show('gate-code-row', !!email);
  $('gate-name').disabled = $('gate-email').disabled = !!email;
  $('gate-submit').textContent = email ? 'Check code & play' : 'Clock in & play';
  if (email) { $('gate-code-note').innerHTML = `We emailed a 6-digit code to <b>${esc(email)}</b>. Check spam too.`; $('gate-code').value = ''; $('gate-code').focus(); }
};
const signedIn = (j) => { rememberAccount(j.email, j.account); gate = j; try { localStorage.setItem('sm_gate', JSON.stringify(j)); } catch {} codeStep(null); sfx('blip'); route(); };
async function askCode() {
  const name = $('gate-name').value.trim(), email = $('gate-email').value.trim();
  if (!name) { $('gate-err').textContent = 'Pick a mover name first (up to 16 letters).'; $('gate-name').focus(); return; }
  if (!email) { $('gate-err').textContent = 'Enter your email. We send you a code to sign in.'; $('gate-email').focus(); return; }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) { $('gate-err').textContent = 'That email doesn’t look right. Check for typos.'; $('gate-email').focus(); return; }
  const r = await fetch(httpBase + '/api/signup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, email, account: knownAccounts()[email.toLowerCase()] }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || 'Could not sign you in. Try again in a minute.');
  if (j.verify) codeStep(j.email); else signedIn(j);
}
$('gate-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('gate-err').textContent = '';
  const btn = $('gate-submit'); btn.disabled = true;
  try {
    if (!codeFor) await askCode();
    else {
      const code = $('gate-code').value.replace(/\D/g, '');
      if (code.length !== 6) { $('gate-err').textContent = 'Type the 6-digit code from the email.'; return; }
      const r = await fetch(httpBase + '/api/verify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: codeFor, code }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || 'That code didn’t work.');
      signedIn(j);
    }
  } catch (err) { $('gate-err').textContent = /fetch|network/i.test(err.message) ? 'Can’t reach the game right now. Check your signal and try again.' : err.message; }
  finally { btn.disabled = false; }
});
$('gate-resend').addEventListener('click', async () => { $('gate-err').textContent = ''; codeStep(null); try { await askCode(); toast('📧 New code sent'); } catch (err) { $('gate-err').textContent = err.message; } });
$('gate-back').addEventListener('click', () => { $('gate-err').textContent = ''; codeStep(null); });
$('btn-signout').onclick = () => { try { localStorage.removeItem('sm_gate'); } catch {} gate = null; route(); };

// ---------- home ----------
const roomFromUrl = () => new URLSearchParams(location.search).get('room');
function parseCode(v) {
  v = v.trim();
  try { const u = new URL(v); return u.searchParams.get('room') || ''; } catch { return v; }
}
$('btn-create').onclick = () => { track('create_click'); connect(null); };
$('btn-solo').onclick = () => { track('solo_click'); connect(null, { solo: true, difficulty: prefDiff }); };
$('btn-quick').onclick = () => { track('quickplay_click'); connect(null, { quick: true }); };
const startTraining = () => { track('tutorial_start'); connect(null, { tutorial: true }); };
$('btn-train').onclick = startTraining;
$('btn-train2').onclick = startTraining;
$('btn-daily').onclick = () => connect(null, { daily: todayUTC(), difficulty: 'normal' });

async function loadHome() {
  $('daily-label').textContent = `${todayUTC()} · same house for everyone`;
  try {
    const r = await fetch(`${httpBase}/api/profile`, { headers: authHeaders() });
    if (r.ok) myProfile = await r.json();
    else if (r.status === 401) { // an old sign-in from before emails were checked: clock in again (with a code)
      try { localStorage.removeItem('sm_gate'); } catch {}
      const old = gate; gate = null; route();
      if (old) { $('gate-name').value = old.name || ''; $('gate-email').value = old.email || ''; }
      $('gate-err').textContent = 'Please clock in again: we now check it’s really your email.';
      return;
    }
  } catch {}
  const next = SUITS.find(x => !suitUnlocked(x.id, myProfile));
  $('home-stats').innerHTML = myProfile.games
    ? `<b>${myProfile.games}</b> moves · <b>${myProfile.wins}</b> wins · <b>${myProfile.loaded}</b> items loaded${next ? ` · next suit: ${next.label} (${next.games ? `${next.games} moves` : `${next.wins} wins`})` : ' · every suit unlocked ✨'}`
    : '';
  let trained = false; try { trained = localStorage.getItem('sm_trained') === '1'; } catch {}
  show('btn-train', !myProfile.games && !trained);
  renderBoard($('daily-board'), todayUTC(), 5);
}
async function renderBoard(el, day, n) {
  try {
    const j = await (await fetch(`${httpBase}/api/leaderboard?day=${day}`)).json();
    el.innerHTML = j.rows.length ? `🏆 Today's Daily House<ol>${j.rows.slice(0, n).map(r => `<li class="${r.name === gate?.name ? 'me' : ''}">${esc(r.name)} · ${r.score} pts</li>`).join('')}</ol>` : '<span class="fine">No Daily House scores yet today. Be the first!</span>';
  } catch { el.innerHTML = ''; }
}
const markDiff = (el, level) => { for (const b of el.children) b.classList.toggle('on', b.dataset.level === level); };
markDiff($('home-diff'), prefDiff);
$('home-diff').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  prefDiff = b.dataset.level; markDiff($('home-diff'), prefDiff);
  try { localStorage.setItem('sm_diff', prefDiff); } catch {}
  sfx('blip');
});
$('btn-join').onclick = () => { const c = parseCode($('join-code').value); if (c) { track('join_click'); connect(c); } };

// ---------- live demo game behind the menu ----------
let demoRoom = null, demoConnecting = false;
let energyTipRound = null;
// ---- tap battle: someone tried to steal (or keep) an end of a two-mover lift ----
let myDuel = null;
function renderDuel(s) {
  const d = (s.duels || []).find(x => x.a === myId || x.b === myId);
  myDuel = d ? d.item : null;
  input.mash = myDuel ? duelTap : null; // controller A mashes too
  show('duel', !!d);
  $('joyzone').style.pointerEvents = d ? 'none' : ''; // nobody walks in a tap battle; don't let the stick eat taps
  if (!d) return;
  const pa = s.players.find(p => p.id === d.a), pb = s.players.find(p => p.id === d.b);
  const mine = d.a === myId ? d.ca : d.cb, theirs = d.a === myId ? d.cb : d.ca;
  $('duel-t').textContent = Math.ceil(d.t);
  $('duel-na').textContent = `${d.a === myId ? 'You' : pa?.name || '?'} ${Math.round(d.ca)}`;
  $('duel-nb').textContent = `${Math.round(d.cb)} ${d.b === myId ? 'You' : pb?.name || '?'}`;
  $('duel-fill').style.width = `${Math.round(100 * (d.ca + 1) / (d.ca + d.cb + 2))}%`;
  $('duel-btn').textContent = mine > theirs ? 'TAP! 💪' : mine < theirs ? 'TAP!! 😤' : 'TAP!';
}
const duelTap = () => { if (!myDuel || !room) return; room.send('duelTap'); const b = $('duel-btn'); b.classList.add('hit'); setTimeout(() => b.classList.remove('hit'), 60); sfx('blip'); };
document.getElementById('duel-btn').addEventListener('pointerdown', (e) => { e.preventDefault(); duelTap(); });
addEventListener('keydown', (e) => { // action key / Space mash during a battle (and don't count as the normal action)
  if (!myDuel || e.repeat || !input.isAction(e.code, 'action')) return;
  e.preventDefault(); e.stopImmediatePropagation(); duelTap();
}, true);
// iOS Safari ignores user-scalable=no: block pinch-zoom gestures and double-tap zoom explicitly
for (const ev of ['gesturestart', 'gesturechange']) document.addEventListener(ev, (e) => e.preventDefault(), { passive: false });
document.addEventListener('dblclick', (e) => e.preventDefault(), { passive: false });
async function startDemo() {
  if (demoRoom || demoConnecting || room) return;
  demoConnecting = true;
  try {
    const d = await client.joinOrCreate('demo');
    if (room) { d.leave(true).catch(() => {}); return; }
    demoRoom = d;
    scene.demoMode = true;
    const demoCache = {};
    d.onMessage('snap', (s) => { mergeItems(s, demoCache); if (!room && s.phase !== 'lobby' && !s.itemsDelta) scene.apply(s, null); });
    d.onMessage('evt', (e) => {
      if (room) return;
      if (e.kind === 'driveoff') scene.startDriveOff(e.damaged.map(x => x.id));
      else if (e.kind === 'start') scene.resetDrive();
      else if (e.kind === 'crunch') scene.crunchFx();
      else if (e.kind === 'emote') scene.emote(e.id, e.e);
    });
    d.onMessage('chat', () => {});
    d.onLeave(() => { if (demoRoom === d) demoRoom = null; });
  } catch { /* the menu still works without the demo */ }
  finally { demoConnecting = false; }
}
function stopDemo() {
  scene.demoMode = false;
  const d = demoRoom; demoRoom = null;
  d?.leave(true).catch(() => {});
  scene.resetDrive();
}

// booking button: same link everywhere, counted per screen
document.addEventListener('click', (e) => { const a = e.target.closest('.book-cta'); if (a) track('book_click_' + (a.dataset.where || 'home')); });

function route() {
  show('joining', false);
  for (const s of ['gate', 'home', 'lobby', 'meeting', 'results']) show(s, false);
  startDemo();
  if (!gate?.token) { show('gate'); track('gate_view'); return; }
  const r = roomFromUrl();
  if (r && !room) { connect(r); return; }
  $('home-hi').textContent = `Welcome, ${gate.name}! Ready to load some trucks?`;
  show('home');
  loadHome();
  track('home_view');
}

/** connection problems in plain words (never a raw MatchMakeError) */
function friendlyConnectError(msg) {
  if (/not found|locked|full|expired/i.test(msg)) return 'That crew is full or no longer exists. Start a new one!';
  if (/429|too many/i.test(msg)) return 'Too many tries in a row. Wait a minute, then try again.';
  return 'Can’t reach the game right now. It may be updating to a new version (about a minute). Check your signal and try again shortly.';
}
/** a banner over the game while the connection is down, with a way out */
function netBox(text, canWait) {
  const el = $('netbox');
  if (!text) { show(el, false); return; }
  $('netbox-text').textContent = text;
  $('netbox').classList.toggle('waiting', !!canWait);
  show(el, true);
}
// pause menu tabs: one page at a time, so the menu fits the screen
document.querySelector('.gm-tabs').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-pane]'); if (!b) return;
  for (const t of document.querySelectorAll('.gm-tabs button')) t.classList.toggle('on', t === b);
  for (const p of document.querySelectorAll('.gm-pane')) p.classList.toggle('hidden', p.dataset.pane !== b.dataset.pane);
});
$('netbox-menu').addEventListener('click', () => {
  const r = room; room = null; snap = null; lastPhase = null; reconnecting = false;
  netBox(null);
  try { sessionStorage.removeItem('sm_rt'); } catch {}
  r?.leave(true).catch(() => {});
  history.replaceState(null, '', location.pathname);
  for (const s of ['hud', 'controls', 'joyzone', 'chat', 'chat-toggle', 'lobby', 'meeting', 'results', 'duel']) show(s, false);
  route();
});
let serverRestarting = false;

async function connect(roomId, extra = {}) {
  $('home-err').textContent = '';
  stopDemo();
  show('home', false); show('gate', false);
  $('joining-text').textContent = roomId ? 'Joining your crew…' : extra.quick ? 'Finding an open game…' : 'Setting up the house…';
  show('joining'); // loading state until the room answers (attach) or fails (route)
  const opts = { name: gate.name, email: gate.email, token: gate.token, char: prefChar, ...extra };
  try {
    // a page reload mid-round can rejoin the same mover
    let saved = null;
    try { saved = JSON.parse(sessionStorage.getItem('sm_rt') || 'null'); } catch {}
    if (roomId && saved?.roomId === roomId) { try { room = await client.reconnect(saved.token); } catch { room = null; } }
    if (!room) room = roomId ? await client.joinById(roomId, opts) : opts.quick ? await client.joinOrCreate('move', opts) : await client.create('move', opts);
  } catch (err) {
    room = null;
    const msg = String(err?.message || err);
    if (/gate/i.test(msg) || err?.code === 401) { try { localStorage.removeItem('sm_gate'); } catch {} gate = null; route(); $('gate-err').textContent = 'Please clock in again.'; return; }
    history.replaceState(null, '', location.pathname);
    route();
    $('home-err').textContent = friendlyConnectError(msg);
    return;
  }
  history.replaceState(null, '', `?room=${room.roomId}`);
  sfx('blip');
  attach(room);
}

function attach(r) {
  show('joining', false);
  room = r;
  autoStartSent = false;
  myId = r.sessionId;
  try { sessionStorage.setItem('sm_rt', JSON.stringify({ roomId: r.roomId, token: r.reconnectionToken })); } catch {}
  const itemCache = {}; // this connection's items: updates only carry what changed
  r.onMessage('snap', (s) => { mergeItems(s, itemCache); if (!s.itemsDelta) onSnap(s); });
  r.onMessage('evt', onEvent);
  r.onMessage('chat', onChat);
  // a dropped socket (phones switching apps, a signal blip): the SDK reconnects on its own into the same mover
  r.onDrop(() => { if (room !== r) return; reconnecting = true; netBox(serverRestarting ? '🔧 The game is updating to a new version. Hang on…' : '📡 Connection lost. Reconnecting…', true); });
  r.onReconnect(() => { if (room !== r) return; reconnecting = false; netBox(null); toast('✅ Reconnected!'); try { sessionStorage.setItem('sm_rt', JSON.stringify({ roomId: r.roomId, token: r.reconnectionToken })); } catch {} });
  r.onLeave((code) => { // gone for good: left on purpose, kicked, or reconnecting gave up
    reconnecting = false; netBox(null);
    if (room !== r) return; // we left on purpose (Main menu, Quit): not a disconnect
    const intentional = code === 1000 || code === 4000;
    room = null; snap = null; lastPhase = null;
    try { sessionStorage.removeItem('sm_rt'); } catch {}
    history.replaceState(null, '', location.pathname);
    for (const s of ['hud', 'controls', 'joyzone', 'chat', 'chat-toggle', 'lobby', 'meeting', 'results']) show(s, false);
    route();
    if (serverRestarting || code === 4001) $('home-err').textContent = 'The game just updated to a new version, so that round ended. Give it about a minute, then jump back in!';
    else if (!intentional) $('home-err').textContent = 'Lost the connection to the crew. Check your signal, then pick a game to jump back in.';
    serverRestarting = false;
  });
}

setInterval(() => {
  if (!room || !snap) return;
  const ws = room.connection?.transport?.ws; // a dropped socket: stop sending until reconnect/leave handling kicks in
  if (ws && ws.readyState !== 1) return;
  if (menuOpen) { room.send('input', { mx: 0, mz: 0, hold: false, tapN: 0, dashN: 0, rotN: 0 }); return; }
  const r = input.read(), yaw = scene.camYaw || 0, mine = meNow();
  if (mine?.loadMode && scene.truckYaw && Math.hypot(r.mx, r.mz) > 0.5) { // truck view turned: push the cursor the way it looks on screen
    const big = Math.abs(r.mx) > Math.abs(r.mz), st = scene.gridStepFor(big ? Math.sign(r.mx) : 0, big ? 0 : Math.sign(r.mz));
    room.send('input', { ...r, mx: -st.dgz, mz: st.dgx }); // server: +mz = gx+1, +mx = gz-1
  } else if (yaw && !mine?.loadMode) { // the camera is turned: "up" means away from the camera
    const c = Math.cos(yaw), sn = Math.sin(yaw);
    room.send('input', { ...r, mx: +(r.mx * c + r.mz * sn).toFixed(2), mz: +(-r.mx * sn + r.mz * c).toFixed(2) });
  } else room.send('input', r);
}, 50);

// ---------- snapshots ----------
function onSnap(s) {
  snap = s;
  scene.apply(s, myId);
  const me = s.players.find(p => p.id === myId);
  if (s.phase !== lastPhase) onPhase(s.phase, lastPhase);
  lastPhase = s.phase;
  musicMood(s.phase === 'meeting' ? 'tense' : s.phase === 'playing' && s.mode !== 'load' && s.timeLeft <= 20 && !s.level?.tutorial ? 'rush' : 'calm');
  if (s.phase === 'lobby' || s.phase === 'meeting') renderQuickChat(s);
  if (s.phase === 'lobby') renderLobby(s, me);
  if (s.phase === 'playing' || s.phase === 'meeting' || s.phase === 'countdown' || s.phase === 'driveoff') renderHud(s, me);
  if (s.phase === 'countdown') { $('countdown').innerHTML = `${s.countdown}<small>${esc(s.level?.name || '')}</small>`; }
  if (s.phase === 'meeting') renderMeeting(s, me);
  if (s.phase === 'results' && s.level?.tutorial) renderTrainingDone(s);
  else if (s.phase === 'results') renderResults(s, me);
}

function onPhase(phase, prev) {
  const playing = phase === 'playing' || phase === 'meeting' || phase === 'countdown' || phase === 'driveoff';
  show('countdown', phase === 'countdown');
  if (phase !== 'driveoff') show('drive', false);
  if (phase !== 'playing') show('coach', false);
  if (phase === 'lobby' || phase === 'countdown') scene.resetDrive();
  show('lobby', phase === 'lobby');
  show('hud', playing);
  show('controls', playing && isTouch);
  show('joyzone', playing && isTouch);
  show('meeting', phase === 'meeting');
  show('results', phase === 'results' && !snap?.level?.tutorial);
  show('train-done', phase === 'results' && !!snap?.level?.tutorial);
  const chatty = phase === 'lobby' || phase === 'meeting';
  show('chat', chatty);
  show('chat-toggle', chatty && isTouch);
  $('chat').classList.toggle('collapsed', isTouch && chatty); // phones: tap Chat to open (in a meeting it would cover the vote buttons)
  input.enabled = phase !== 'meeting' && !menuOpen;
  if (!['playing', 'countdown', 'meeting', 'driveoff'].includes(phase)) closeGameMenu();
  if (phase === 'meeting') { myVote = null; sfx('alarm'); }
  if (phase === 'lobby') $('lobby-tip').textContent = TIPS[Math.floor(Math.random() * TIPS.length)];
  if (phase === 'countdown') {
    $('toasts').innerHTML = '';
    const lv = snap?.level;
    if (lv) toast(`🏠 Today's job: ${lv.name} · ${lv.rooms} rooms · ${Math.round(lv.yard)} m from the truck`);
    toast(TIPS[Math.floor(Math.random() * TIPS.length)]);
    sfx('blip');
  }
}

// ---------- lobby ----------
/** Lobby choices as ◀ value ▶ steppers. The original buttons stay (hidden) and keep doing the work: an arrow clicks the
 *  next or previous button that's allowed, so every rule about who can change what still applies. */
const STEPPED = ['games', 'modes', 'teams', 'crew', 'floors', 'twists', 'lobby-diff'];
function stepperize() {
  for (const id of STEPPED) {
    const g = $(id); if (!g || g.dataset.stepper) continue;
    g.dataset.stepper = '1'; g.classList.add('stepped');
    const st = document.createElement('div');
    st.className = 'stepper'; st.dataset.for = id;
    st.innerHTML = `<button type="button" class="st-prev" aria-label="Previous">◀</button><span class="st-val" aria-live="polite"></span><button type="button" class="st-next" aria-label="Next">▶</button>`;
    g.after(st);
    st.addEventListener('click', (e) => {
      const b = e.target.closest('button'); if (!b || b.disabled) return;
      const all = [...g.querySelectorAll('button')], cur = all.findIndex(x => x.classList.contains('on')), dir = b.classList.contains('st-next') ? 1 : -1;
      for (let k = 1; k <= all.length; k++) { const n = all[(cur + dir * k + all.length * 2) % all.length]; if (!n.disabled) { n.click(); break; } }
    });
  }
  for (const st of document.querySelectorAll('.stepper')) {
    const g = $(st.dataset.for), all = [...g.querySelectorAll('button')], on = all.find(x => x.classList.contains('on'));
    st.querySelector('.st-val').textContent = on ? on.textContent : '—';
    const can = all.filter(x => !x.disabled).length > (on && !on.disabled ? 1 : 0);
    for (const a of st.querySelectorAll('button')) a.disabled = !can;
    st.classList.toggle('locked', !can);
  }
}

function renderLobby(s, me) {
  if (s.level?.tutorial && s.hostId === myId && !autoStartSent) { autoStartSent = true; room.send('start'); return; } // training starts right away
  $('lobby-code').textContent = room.roomId;
  $('quick-note').textContent = s.quick && s.autoStart ? `⚡ Quick Play: starting in ${s.autoStart}s. Friends who join take an AI's seat.` : s.daily ? `📅 Daily House ${s.daily}: best score today goes on the leaderboard.` : '';
  const link = `${location.origin}${location.pathname}?room=${room.roomId}`;
  if ($('share-link').value !== link) $('share-link').value = link;
  const host = s.hostId === myId;
  const lv = s.level;
  const key = JSON.stringify([s.players.map(p => [p.id, p.name, p.char, p.bot, p.suit, p.ready, p.setup, p.team]), s.hostId, s.mode, s.difficulty, s.level?.seed, s.game, s.twist, s.floors, s.crewSize, s.teamN]);
  if ($('lobby').dataset.key === key) return;
  $('lobby').dataset.key = key;
  renderCrewCarousel(s);
  for (const b of $('modes').children) { b.classList.toggle('on', b.dataset.mode === s.mode); b.disabled = !host; }
  for (const b of $('games').children) { b.classList.toggle('on', b.dataset.game === s.game); b.disabled = !host; }
  // house setup: everyone picks (your pick is highlighted); the crew chief's pick is the house shown; one pick is drawn at start
  const mine = me?.setup || (host ? { floors: s.level?.floors || 1, twist: s.twist } : null);
  for (const b of $('twists').children) { b.classList.toggle('on', b.dataset.twist === mine?.twist); b.disabled = !me || me.bot || !!s.daily; }
  for (const b of $('teams').children) { const n = Number(b.dataset.teams); b.classList.toggle('on', n === (s.teamN || 0)); b.disabled = !host || s.game === 'sabotage' || (n === 3 && (s.crewSize || 4) < 6) || !!s.level?.tutorial; }
  for (const b of $('crew').children) { b.classList.toggle('on', Number(b.dataset.crew) === (s.crewSize || 4)); b.disabled = !host || !!s.level?.tutorial; } // the crew chief's call
  for (const b of $('floors').children) { b.classList.toggle('on', Number(b.dataset.floors) === mine?.floors); b.disabled = !me || !!s.daily || !!s.level?.classic; }
  const TW = { none: 'no twist', zerog: 'Zero-G', mansion: 'Moon Mansion' };
  const picks = s.players.filter(p => !p.bot && !p.spectator).map(p => ({ p, x: p.setup || (p.id === s.hostId ? { floors: s.level?.floors || 1, twist: s.twist } : null) })).filter(o => o.x);
  $('setup-note').innerHTML = s.daily ? '' : picks.length > 1
    ? `House setup picks: ${picks.map(o => `<b>${esc(o.p.name)}</b> ${o.x.floors} floor${o.x.floors > 1 ? 's' : ''}, ${TW[o.x.twist]}`).join(' · ')}. One pick is drawn at random when the round starts.`
    : 'Pick floors and a twist. With friends, everyone picks and one pick is drawn at random when the round starts.';
  $('house-code').textContent = lv?.code || '';
  show('code-form', !!lv?.code && !s.daily);
  $('code-input').disabled = !host; $('code-form').querySelector('button').disabled = !host;
  $('code-input').placeholder = host ? 'Type a code' : 'Crew chief only';
  const mySuit = me?.suit || 'classic';
  $('suits').innerHTML = SUITS.map(x => {
    const open = suitUnlocked(x.id, myProfile);
    const col = x.color === null ? 'conic-gradient(#ff8a3d 0 25%,#2ec4b6 0 50%,#7bd84a 0 75%,#a66cff 0)' : '#' + x.color.toString(16).padStart(6, '0');
    const need = x.games ? `${x.games} moves` : `${x.wins} wins`;
    return `<button class="suit ${x.id === mySuit ? 'on' : ''} ${open ? '' : 'locked'}" data-suit="${x.id}" style="background:${col}" title="${x.label}${open ? '' : ` · unlocks after ${need}`}" aria-label="${x.label} suit${open ? '' : ', locked'}">${open ? '' : '<span class="lk">🔒</span>'}</button>`;
  }).join('');
  $('game-desc').textContent = s.game === 'sabotage'
    ? '🕵️ One mover is secretly a saboteur. Pack the truck perfectly before time runs out, or vote them out. Needs 3+ movers.'
    : s.mode === 'load' ? '🧩 Full load: the house holds exactly one truckload. Pack it perfectly. Hold the action on the ramp to pull pieces back out.'
    : s.teamN ? `🤝 ${s.teamN} teams, one truck. Every point you score counts for your team. Steal from the other team, never your own.`
    : '🏆 Everyone for themselves. Most points still on the truck wins.';
  const movers = s.players.filter(p => !p.spectator);
  const bots = s.players.filter(p => p.bot);
  // the crew as a list; status is words, not icons
  const row = (p) => {
    const st = p.id === s.hostId ? 'Crew chief' : p.bot ? 'AI mover' : p.spectator ? 'Watching' : p.ready ? 'Ready' : 'Not ready yet';
    return `<li class="${p.id === myId ? 'me' : ''}"><span class="cl-pic">${portrait(p.char)}</span><b>${esc(p.name)}${p.id === myId ? ' <small>(you)</small>' : ''}</b><span class="cl-st ${p.ready || p.id === s.hostId || p.bot ? 'ok' : ''} ${p.id === s.hostId ? 'host' : ''}">${st}</span></li>`;
  };
  if (s.teamN) { // a column per team, with a button to switch to it
    const cols = Array.from({ length: s.teamN }, (_, i) => i + 1).map(t => {
      const ms = movers.filter(p => p.team === t);
      const join = me && !me.spectator && me.team !== t ? `<button class="ghost small tjoin" data-team="${t}">Join ${TEAM_NAMES[t - 1]}</button>` : '';
      return `<div class="tcol" style="--tc:${TEAM_COLORS[t - 1]}"><h3>${teamChip(t)} <small>${ms.length}</small></h3><ul class="crew-list">${ms.map(row).join('')}</ul>${join}</div>`;
    }).join('');
    const watching = s.players.filter(p => p.spectator);
    $('lobby-players').innerHTML = `<h2>Crew <small>${movers.length} of ${s.crewSize || 4} movers · ${s.teamN} teams</small></h2><div class="tcols">${cols}</div>` + (watching.length ? `<ul class="crew-list">${watching.map(row).join('')}</ul>` : '');
  } else $('lobby-players').innerHTML = `<h2>Crew <small>${movers.length} of ${s.crewSize || 4} movers</small></h2><ul class="crew-list">` + s.players.map(row).join('') + '</ul>';
  const waitingOn = s.players.filter(p => !p.bot && !p.spectator && p.id !== s.hostId && !p.ready);
  const meReadyL = !!me?.ready;
  show('btn-ready-lobby', !host && !!me && !me.spectator);
  $('btn-ready-lobby').classList.toggle('on', meReadyL);
  $('btn-ready-lobby').textContent = meReadyL ? 'Ready (tap to undo)' : 'I\'m ready';
  $('lobby-house').innerHTML = lv ? `🏠 <b>${esc(lv.name)}</b> · ${lv.rooms} rooms${(lv.floors || 1) > 1 ? ` on ${lv.floors} floors` : ''} · ${Math.round(lv.yard)} m to the truck` : '';
  show('btn-reroll', host && lv && !lv.classic);
  show('bot-controls', host || bots.length > 0);
  markDiff($('lobby-diff'), s.difficulty);
  for (const b of $('lobby-diff').children) b.disabled = !host;
  show($('btn-addbot').parentElement, host);
  $('btn-addbot').disabled = movers.length >= (s.crewSize || 4);
  $('btn-rmbot').disabled = bots.length === 0;
  show('btn-start', host);
  $('btn-start').disabled = host && waitingOn.length > 0;
  if (host) $('btn-start').textContent = waitingOn.length ? `Waiting for ${waitingOn.length} to get ready` : 'Start the move';
  $('lobby-wait').textContent = !host ? (meReadyL ? 'You\'re ready. The crew chief 👑 starts when everyone is.' : 'Tap “I’m ready” when you are.')
    : waitingOn.length ? `Waiting on ${waitingOn.map(p => p.name).join(', ')}.`
    : s.game === 'sabotage' && movers.length < 3 ? 'Sabotage needs 3+ movers. Add AI movers or invite friends.'
    : movers.length === 1 ? 'Add AI movers, or share the invite so friends can join.' : 'Everyone ready? Hit start!';
  $('btn-start').disabled = host && (waitingOn.length > 0 || (s.game === 'sabotage' && movers.length < 3));
  if (me && !me.spectator) prefChar = me.char;
  stepperize();
}
// voxel look: a swipeable carousel of the whole crew; some movers unlock as you play
function renderCrewCarousel(s) {
  const el = $('chars');
  const prev = el.querySelector('.ctrack')?.scrollLeft ?? null;
  const mine = s.players.find(p => p.id === myId)?.char;
  el.classList.add('carousel');
  const cards = CREW_ORDER.map(k => {
    const c = charInfo(k), who = s.players.find(p => p.char === k), open = charUnlocked(k, myProfile);
    const cls = who?.id === myId ? 'mine' : who ? 'taken' : open ? '' : 'locked';
    const foot = who?.id === myId ? '<div class="cf on">✓ Your mover</div>'
      : who ? `<div class="cf">${who.bot ? '🤖 ' : ''}${esc(who.name)}</div>`
      : open ? '<div class="cf go">Pick</div>'
      : `<div class="cf lockf">🔒 ${unlockText(k)}<i style="--p:${Math.round(unlockProgress(k, myProfile) * 100)}%"></i></div>`;
    return `<button class="char ccard ${cls}" data-char="${k}" ${who && who.id !== myId ? 'disabled' : ''}>${portrait(k)}<div class="n">${esc(c.name)}</div><div class="k">${esc(c.kind)}</div><div class="bl">${esc(c.blurb || '')}</div>${foot}</button>`;
  }).join('');
  const unlocked = CREW_ORDER.filter(k => charUnlocked(k, myProfile)).length;
  el.innerHTML = `<button class="carr" data-dir="-1" aria-label="Previous movers">‹</button><div class="ctrack">${cards}</div><button class="carr" data-dir="1" aria-label="More movers">›</button><div class="ccount">${unlocked}/${CREW_ORDER.length} movers unlocked · swipe for more</div>`;
  const track = el.querySelector('.ctrack');
  if (prev !== null && el.dataset.mine === mine) track.scrollLeft = prev;
  else { const sel = track.querySelector('.mine'); if (sel) track.scrollLeft = sel.offsetLeft - track.clientWidth / 2 + sel.clientWidth / 2; }
  el.dataset.mine = mine || '';
}
$('chars').addEventListener('click', (e) => {
  const arr = e.target.closest('.carr');
  if (arr) { const t = $('chars').querySelector('.ctrack'); t.scrollBy({ left: Number(arr.dataset.dir) * t.clientWidth * 0.8, behavior: 'smooth' }); return; }
  const lk = e.target.closest('.char.locked');
  if (lk) { const c = charInfo(lk.dataset.char); toast(`🔒 ${c.name} unlocks when you ${unlockText(lk.dataset.char).toLowerCase()}.`); sfx('blip'); return; }
  const b = e.target.closest('.char');
  if (!b || !room) return;
  room.send('char', { id: b.dataset.char });
  try { localStorage.setItem('sm_char', b.dataset.char); } catch {}
  sfx('blip');
});
$('code-form').addEventListener('submit', (e) => { e.preventDefault(); const v = $('code-input').value.trim(); if (v && room) { room.send('seed', { code: v }); $('code-input').value = ''; } });
$('teams').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b && room) { room.send('teams', { n: Number(b.dataset.teams) }); sfx('blip'); } });
$('lobby-players').addEventListener('click', (e) => { const b = e.target.closest('.tjoin'); if (b && room) { room.send('team', { t: Number(b.dataset.team) }); sfx('blip'); } });
$('crew').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b && room) { room.send('crew', { size: Number(b.dataset.crew) }); sfx('blip'); } });
$('floors').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b && room) room.send('floors', { floors: Number(b.dataset.floors) }); });
$('twists').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b && room) room.send('twist', { twist: b.dataset.twist }); });
$('suits').addEventListener('click', (e) => {
  const b = e.target.closest('.suit');
  if (!b || !room) return;
  if (b.classList.contains('locked')) { toast(`🔒 ${b.title}`); return; }
  room.send('suit', { id: b.dataset.suit }); sfx('blip');
});
$('games').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b && room) room.send('game', { game: b.dataset.game }); });
$('modes').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b && room) room.send('mode', { mode: b.dataset.mode }); });
$('btn-start').onclick = () => room?.send('start');
$('btn-reroll').onclick = () => { room?.send('reroll'); sfx('blip'); };
$('btn-addbot').onclick = () => room?.send('addBot');
$('btn-rmbot').onclick = () => room?.send('removeBot');
$('lobby-diff').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b && room) { room.send('difficulty', { level: b.dataset.level }); try { localStorage.setItem('sm_diff', b.dataset.level); } catch {} } });
$('hud-help').onclick = () => room?.send('help');
$('btn-help').addEventListener('pointerdown', (e) => { e.preventDefault(); room?.send('help'); });
$('chat-toggle').onclick = () => { $('chat').classList.toggle('collapsed'); if (!$('chat').classList.contains('collapsed')) $('chat-input').focus(); };
const buzz = (pattern) => { try { navigator.vibrate?.(pattern); } catch {} };
const syncMusic = () => { $('hud-music').style.opacity = isMusicOn() ? '1' : '.4'; };
$('hud-music').onclick = () => { setMusic(!isMusicOn()); syncMusic(); };
syncMusic();
// quick chat: one-tap phrases for phones (meetings + lobby)
function renderQuickChat(s) {
  const others = (s?.players || []).filter(p => p.id !== myId && !p.spectator && !p.out);
  const phrases = s?.phase === 'meeting'
    ? [...others.slice(0, 3).map(p => `It was ${p.name}!`), 'Not me!', 'I saw it at the truck', 'Skip, no proof']
    : ['Ready!', 'Let\'s go! 🚚', 'Wait for me', 'GG 🎉'];
  const key = phrases.join('|');
  if ($('quickchat').dataset.key === key) return;
  $('quickchat').dataset.key = key;
  $('quickchat').innerHTML = phrases.map(t => `<button>${esc(t)}</button>`).join('');
}
$('quickchat').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b && room) { room.send('chat', { text: b.textContent }); buzz(10); } });
// installable app
let installPrompt = null;
addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installPrompt = e; show('btn-install'); });
$('btn-install').onclick = async () => { if (!installPrompt) return; installPrompt.prompt(); const r = await installPrompt.userChoice.catch(() => null); if (r?.outcome === 'accepted') track('install'); installPrompt = null; show('btn-install', false); };
if ('serviceWorker' in navigator && location.port !== '5173') addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
const syncSound = () => { $('hud-sound').textContent = isMuted() ? '🔇' : '🔊'; };
$('hud-sound').onclick = () => { setMuted(!isMuted()); syncSound(); };
syncSound();
$('hud-callout').onclick = () => room?.send('callout');
$('btn-copy').onclick = async () => {
  track('share_click');
  const link = $('share-link').value;
  try {
    if (navigator.share && isTouch) await navigator.share({ title: 'Let’s Move It', text: 'Join my moving crew in Let’s Move It!', url: link });
    else { await navigator.clipboard.writeText(link); $('btn-copy').textContent = 'Copied!'; setTimeout(() => ($('btn-copy').textContent = 'Copy invite'), 1500); }
  } catch { $('share-link').select(); }
};

// ---------- HUD ----------
const fmt = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
function renderHud(s, me) {
  setText('hud-timer', s.level?.tutorial ? 'Training' : s.mode === 'load' ? `Full load · ${fmt(s.timeLeft)}` : fmt(s.timeLeft));
  const tut = s.tutorial;
  show('coach', !!tut && s.phase === 'playing');
  if (tut) {
    const keys = isTouch ? { ACT: 'the big button', ROT: 'Rotate', HELP: 'Need a hand' }
      : input.pad.connected ? { ACT: 'A', ROT: 'X', HELP: 'Y' } : { ACT: keyName(input.binds.action), ROT: keyName(input.binds.rotate), HELP: keyName(input.binds.help) };
    setText('coach-text', (tut.text || '').replace(/Tap \{ROT\}/g, isTouch ? 'Use {ROT}' : 'Tap {ROT}').replace(/\{(ACT|ROT|HELP)\}/g, (_, k) => keys[k]));
    setHTML('coach-dots', Array.from({ length: tut.total || 0 }, (_, i) => `<i class="${i < tut.step ? 'done' : ''}"></i>`).join(''));
    setText('coach-step', tut.total ? `· step ${Math.min(tut.step + 1, tut.total)} of ${tut.total}` : '');
  }
  scene.tutorialTarget = tut?.target || null;
  $('hud-timer').classList.toggle('low', s.mode !== 'load' && s.timeLeft <= 20);
  if (me) {
    setText('hud-score', `${me.score} pts`);
    const sabotage = s.game === 'sabotage';
    setText('hud-strikes', me.out ? '🚪 OFF THE TRUCK' : sabotage ? (myRole ? '🕵️ Saboteur' : '🧰 Crew') : `Strikes ${me.strikes}/2`);
    $('hud-strikes').classList.toggle('role-sab', sabotage && !!myRole);
    show('hud-crew', sabotage);
    if (sabotage) { setText('hud-crew', s.overtime ? `⏰ Crew ${s.crewScore}` : `🧰 Crew ${s.crewScore}`); $('hud-crew').classList.toggle('drain', !!s.overtime); }
  }
  setText('hud-truck', `${s.loadedCount}/${s.totalItems} ${isTouch ? 'in truck' : 'in the truck'}`);
  const held = me?.carry ? s.items.find(i => i.id === me.carry) : null;
  const needHand = !!held && !me.loadMode && ITEM_TYPES[held.type].teamCarry && held.n === 1 && s.players.filter(p => !p.out && !p.spectator).length > 1 && s.phase === 'playing';
  show('hud-help', needHand && !isTouch);
  show('btn-help', needHand && isTouch);
  // phones: the stick also moves the aim in the truck; drag on the truck aims, a quick swipe turns the piece
  const aiming = !!me?.loadMode && s.phase === 'playing';
  document.body.classList.toggle('aiming', aiming);
  show('dpad', aiming && isTouch);                          // phones: aim with the D-pad (or drag on the truck)
  show('joyzone', !aiming && isTouch && s.phase !== 'meeting');
  const it0 = aiming && me.carry ? s.items.find(i => i.id === me.carry) : null, turns = !!it0 && orientations(it0.type).length > 1;
  show('btn-rot', turns); show('btn-flip', turns && new Set(orientations(it0.type).map(o => o.h)).size > 1);
  const canCall = s.phase === 'playing' && s.canCallOut && (s.openBreaks > 0 || s.game === 'sabotage') && me && !me.out && !me.spectator;
  show('hud-callout', canCall && !isTouch);
  show('btn-callout', canCall);
  setText('dash-label', me?.loadMode ? 'Back' : 'Dash');
  // energy: one friendly tip per round the first time you run low
  if (me && s.phase === 'playing' && (me.energy ?? 1) < 0.3 && !(me.injured > 0) && energyTipRound !== s.level?.seed) { energyTipRound = s.level?.seed; toast('⚡ Running out of energy! Slow down, or stop for a second to catch your breath, before you get hurt.'); }
  renderDuel(s);
  // compact: a strip of avatar + score chips (names only where there's room); you're highlighted, leader gets a crown
  const teamRow = s.teams ? [...s.teams].sort((a, b) => b.score - a.score).map((t, i) => `<div class="sb team" style="--tc:${TEAM_COLORS[t.t - 1]}">${i === 0 && t.score > 0 ? '<i class="crown">👑</i>' : ''}<span class="nm">${t.name}${me?.team === t.t ? ' (you)' : ''}</span><b>${t.score}</b></div>`).join('') : '';
  setHTML('scoreboard', teamRow + [...s.players].filter(p => !p.spectator).sort((a, b) => b.score - a.score)
    .map((p, i) => `<div class="sb ${p.out ? 'out' : ''} ${p.id === myId ? 'me' : ''} ${p.team ? 'tm' : ''}" ${p.team ? `style="--tc:${TEAM_COLORS[p.team - 1]}"` : ''} title="${esc(p.name)}">${i === 0 && p.score > 0 ? '<i class="crown">👑</i>' : ''}${portrait(p.char)}<span class="nm">${p.id === myId ? 'You' : esc(p.name)}</span><b>${p.score}</b>${p.strikes ? `<em>${'✖'.repeat(p.strikes)}</em>` : ''}</div>`).join(''));
  renderPrompt(s, me);
}

function nearest(s, me) {
  let best = null, bd = 1.7;
  for (const it of s.items) {
    const grab = !me.carry && ((it.state === 'carried' && !ITEM_TYPES[it.type].teamCarry && it.n === 1) || (it.state === 'pushed' && it.pusher && it.pusher !== myId)); // someone else's box or dolly
    const stealable = grab || (it.state === 'carried' && ITEM_TYPES[it.type].teamCarry && it.n === 2 && !me.carry);
    if (it.state !== 'floor' && !(it.state === 'carried' && ITEM_TYPES[it.type].teamCarry && it.n === 1) && !stealable) continue;
    if ((it.fl || 0) !== (me.fl || 0)) continue; // right above or below you is not within reach
    const d = Math.hypot(it.x - me.x, it.z - me.z) - (ITEM_TYPES[it.type].w > 1 ? 0.6 : 0);
    if (d < bd) { bd = d; best = it; }
  }
  return best;
}

/** what to press for the main action on this device */
const actKey = () => (isTouch ? 'the big button' : input.pad.connected ? 'A' : keyName(input.binds.action));
function renderPrompt(s, me) {
  let text = '', action = 'ACTION';
  if (!me) return;
  if (me.spectator) text = '👀 Spectating — you join next round';
  else if (me.out) text = '👻 You got kicked off the truck. Float around and watch!';
  else if (s.phase === 'meeting') text = '';
  else if (me.loadMode && me.unloading) {
    text = scene.pullTarget ? `↩️ ${isTouch ? 'Pull out takes' : actKey() + ' pulls'} the ${scene.pullTarget.toLowerCase()} off this stack · ${isTouch ? 'Back' : keyName(input.binds.dash)} to leave` : '↩️ Aim at a stack to pull its top piece';
    action = 'PULL';
  } else if (me.loadMode) {
    const it = s.items.find(i => i.id === me.carry);
    const f = it ? footprint(it.type, me.cursor?.rot || 0) : null;
    const turn = it && orientations(it.type).length > 1 ? ` · ${isTouch ? 'Rotate / Flip' : input.pad.connected ? 'X rotate · RB flip' : `${keyName(input.binds.rotate)} rotate · ${keyName(input.binds.flip)} flip`} (${ORIENT_LABEL(f)} ${f.w}×${f.d}×${f.h})` : '';
    text = scene.ghostOk === false ? '⛔ Doesn’t fit there, aim somewhere else' : scene.ghostIssue ? `⚠️ ${scene.ghostIssue.text}. Aim somewhere else${scene.ghostIssue.bad ? '!' : ' (or turn it)'}` : isTouch ? `D-pad or drag to aim · Place${f && orientations(it.type).length > 1 ? ` · ${ORIENT_LABEL(f)} ${f.w}×${f.d}×${f.h}` : ''}` : (input.pad.connected ? '🎯 Stick to aim · A drop · B back' : `🎯 Move or point to aim · ${keyName(input.binds.action)} or right click drop · ${keyName(input.binds.dash)} back`) + turn;
    action = 'DROP';
  } else if (!me.carry && !me.dolly && !s.level?.tutorial && s.loadedCount > 0 && Math.abs(me.z) < 2.4 && me.x > 9.4 && me.x < 13) {
    text = `🧩 Hold ${actKey()} to unload pieces from the truck and repack`;
    action = 'HOLD ↩️';
  } else if (me.flatDolly && !me.carry) {
    const d = s.items.find(i => i.id === me.flatDolly), pc = d?.piece && s.items.find(i => i.id === d.piece);
    const n = d?.stack?.length || 0;
    text = pc ? `🛞 ${ITEM_TYPES[pc.type].label} on the furniture dolly · push it to the 🚚 truck and place it yourself`
      : n >= 4 ? `🛞 4 boxes · full! Easy on the speed and the corners or one slides off (fragile breaks)`
      : n ? `🛞 ${n} box${n > 1 ? 'es' : ''} on the furniture dolly · tap ${actKey()} by a box to add one (up to 4) · push to the 🚚 truck`
      : `🛞 Furniture dolly · tap ${actKey()} by a piece of furniture, or by boxes (up to 4) · take desks/tables apart first`;
    action = pc || n >= 4 ? 'SET DOWN' : 'LOAD';
  } else if (me.dolly && !me.carry) {
    const d = s.items.find(i => i.id === me.dolly);
    const n = d?.stack?.length || 0;
    text = d?.strain > 0.25 ? '⚠️ A heavy box is crushing the box under it! Get to the truck or restack.'
      : n ? `🛒 Dolly ${n}/3 · ${n < 3 ? `tap ${actKey()} by a box to add it · ` : ''}push it to the truck to unload, top box first`
      : `🛒 Dolly 0/3 · tap ${actKey()} next to boxes to stack them (boxes only)`;
    action = n < 3 ? 'STACK' : 'SET DOWN';
  } else if (me.carry) {
    const it = s.items.find(i => i.id === me.carry);
    const t = it && ITEM_TYPES[it.type];
    if (t?.teamCarry && it.n === 1 && s.players.filter(p => !p.out && !p.spectator).length > 1) text = `💪 Need a crewmate on the other end of the ${t.label.toLowerCase()} · ${isTouch ? 'Need a hand' : input.pad.connected ? 'Y' : keyName(input.binds.help)} calls for help`;
    else if (t) text = `Carrying ${t.label}${t.heavy && !t.furniture ? ' (heavy = slow!)' : ''} → take it to the 🚚 LOAD ZONE`;
    action = 'SET DOWN';
  } else {
    const it = nearest(s, me);
    if (it) {
      const t = ITEM_TYPES[it.type];
      if (it.assembled) { text = `🔧 HOLD to disassemble the ${t.label.toLowerCase()}`; action = 'HOLD 🔧'; }
      else if (it.state === 'pushed') { text = `⚔️ TAP to fight for the ${t.label.toLowerCase()}${it.stack?.length || it.piece ? ' and its load' : ''}: a 5-second tap battle!`; action = 'STEAL'; }
      else if (it.state === 'carried' && !t.teamCarry) { text = `⚔️ TAP to fight for that ${t.label.toLowerCase()}: a 5-second tap battle!`; action = 'STEAL'; }
      else if (it.state === 'carried' && it.n === 2) { text = `⚔️ TAP to steal an end of the ${t.label.toLowerCase()}: a 5-second tap battle!`; action = 'STEAL'; }
      else if (it.state === 'carried') { text = `💪 TAP to grab the other end of the ${t.label.toLowerCase()}`; action = 'LIFT'; }
      else if (t.needsWrap && !it.wrapped) { text = `🧣 HOLD to pad-wrap the ${t.label.toLowerCase()} · TAP to grab as-is`; action = 'WRAP/GRAB'; }
      else { text = `TAP to pick up ${t.label}${t.teamCarry ? ' (2-mover lift)' : ''}`; action = 'GRAB'; }
      if (me.task) {
        const pct = Math.round(100 * (s.items.find(i => i.id === me.task.id)?.task?.p || 0));
        text = `${me.task.kind === 'wrap' ? '🧣 Wrapping' : '🔧 Taking it apart'}… keep holding! ${pct}% ${'▰'.repeat(Math.round(pct / 10))}${'▱'.repeat(10 - Math.round(pct / 10))}`;
      }
    }
  }
  if (myDuel) { text = ''; action = 'TAP'; } // tap battle: the panel explains; the big button mashes
  setText('prompt', text);
  show('prompt', !!text && !s.tutorial); // in training the Coach does the talking
  // the big button says what it will do right now
  const WORD = { 'ACTION': ['Grab', ''], 'GRAB': ['Grab', ''], 'SET DOWN': ['Drop', ''], 'DROP': ['Place', ''], 'PULL': ['Pull out', ''],
    'HOLD ↩️': ['Unload', 'hold'], 'STACK': ['Stack', ''], 'LOAD': ['Load', ''], 'LIFT': ['Lift', ''], 'STEAL': ['Steal', ''], 'TAP': ['Tap!', 'tap battle'],
    'WRAP/GRAB': ['Wrap', 'hold · tap grabs'], 'HOLD 🔧': ['Take apart', 'hold'] };
  const [w, sub] = WORD[action] || [action, ''];
  if ($('action-label').textContent !== w) setText('action-label', w);
  // nothing in reach (a plant, a built-in bookshelf, an empty corner): the button greys out, so it's clear what can be picked up
  const idle = action === 'ACTION' && !myDuel && !me.carry && !me.dolly && !me.flatDolly;
  if ($('btn-action').classList.contains('idle') !== idle) $('btn-action').classList.toggle('idle', idle);
  const taskP = me.task ? (s.items.find(i => i.id === me.task.id)?.task?.p || 0) : 0;
  setText('action-sub', me.task ? `keep holding · ${Math.round(taskP * 100)}%` : sub);
  $('btn-action').style.setProperty('--hold', me.task ? `${Math.round(taskP * 360)}deg` : '0deg'); // a ring fills round the button
  $('btn-action').classList.toggle('holding', !!me.task);
}

// ---------- events ----------
/** Little box labels at the top of the screen. At most two at once (an important one bumps an ordinary one), the same
 *  message never twice in a row, and a tip (a private hint from the server) only once per round. */
const toastSeen = new Map(); let toastRound = null;
function toast(text, cls = '', opts = {}) {
  const now = performance.now(), key = String(text).replace(/\d+/g, '#');
  if (snap?.level?.seed !== toastRound) { toastRound = snap?.level?.seed; toastSeen.clear(); }
  const last = toastSeen.get(key);
  if (last !== undefined && (opts.tip || now - last < 8000)) return; // seen it: tips once a round, anything else not within 8 s
  toastSeen.set(key, now);
  const box = $('toasts'), important = !!cls;
  if (box.children.length >= 2) {
    const plain = [...box.children].reverse().find(c => !c.classList.contains('crunch') && !c.classList.contains('help'));
    if (!important && !plain) return;
    (plain || box.lastChild).remove();
  }
  const el = document.createElement('div');
  el.className = 'toast ' + cls;
  el.textContent = text;
  box.prepend(el);
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 250); }, important ? 4500 : 2800);
}
function onEvent(e) {
  if (e.kind === 'restart') { serverRestarting = true; netBox('🔧 The game is updating to a new version. This round can’t continue. Back in about a minute!', false); return; }
  if (e.kind === 'toast') { if (!(e.private && snap?.tutorial)) toast(e.text, e.cls || '', { tip: !!e.private }); }
  else if (e.kind === 'emote') { scene.emote(e.id, e.e); if (e.e.startsWith('+')) sfx('coin'); else sfx('blip'); if (e.id === myId) buzz(e.e.startsWith('+') ? 25 : 12); }
  else if (e.kind === 'crunch') {
    toast(e.text, 'crunch'); scene.shake(); sfx('crunch'); scene.crunchFx(); buzz(200);
    $('flash').classList.add('on'); setTimeout(() => $('flash').classList.remove('on'), 80);
  } else if (e.kind === 'meeting') { toast(`📣 ${e.caller} called a crew meeting!`); buzz([100, 60, 100]); }
  else if (e.kind === 'verdict') {
    const v = $('verdict'); v.textContent = e.text; show(v);
    sfx(e.guilty ? 'coin' : 'buzz');
    setTimeout(() => show(v, false), 4500);
  } else if (e.kind === 'end') {
    sfx('fanfare');
    setTimeout(() => {
      const r = snap?.results, me = snap?.players.find(p => p.id === myId);
      const won = r && (r.teams ? !!r.winTeam && me?.team === r.winTeam : r.winnerId === myId || (r.game === 'sabotage' && ((r.winners === 'crew' && r.saboteurId !== myId) || (r.winners === 'saboteur' && r.saboteurId === myId))));
      if (won || /Perfect load|Training complete/.test(r?.reason || '')) { scene.confetti(me?.x ?? 11, me?.z ?? 0); buzz([30, 30, 30, 30, 80]); }
    }, 300);
  }
  else if (e.kind === 'role') {
    myRole = !!e.saboteur;
    const r = $('role');
    r.className = myRole ? 'sab' : 'crew';
    r.innerHTML = myRole
      ? '<div class="card"><div class="big-icon">🕵️</div><h2>You are the SABOTEUR</h2><p>Keep the crew from packing a perfect load. Hold the action on desks and tables to jam their bolts, and crush boxes when nobody is looking. Don’t get voted out.</p></div>'
      : '<div class="card"><div class="big-icon">🧰</div><h2>You are CREW</h2><p>Pack the truck perfectly before time runs out. Someone on this crew is a saboteur. Watch for crunches and call a meeting to vote them out.</p></div>';
    show(r); sfx(myRole ? 'buzz' : 'coin');
    setTimeout(() => show(r, false), 5000);
  }
  else if (e.kind === 'tutorial') {
    sfx(e.done ? 'fanfare' : 'coin');
    if (e.done) { try { localStorage.setItem('sm_trained', '1'); } catch {} track('tutorial_done'); }
  }
  else if (e.kind === 'driveoff') {
    scene.startDriveOff(e.damaged.map(d => d.id));
    const d = $('drive');
    $('drive-body').innerHTML = '<span class="fine">Closing the shutter…</span>';
    show(d);
    setTimeout(() => {
      $('drive-body').innerHTML = `<div class="safety" style="color:${e.safety >= 90 ? 'var(--accent2)' : e.safety >= 70 ? 'var(--warn)' : 'var(--danger)'}">${e.safety}% safe</div>`
        + (e.damaged.length ? e.damaged.map(x => `<div class="dmg">💥 ${esc(x.name)} ${esc(x.reason)}${x.by ? ` (−pts for ${esc(x.by)})` : ''}</div>`).join('') : '<div>Every piece arrived in one piece. Pro packing! ✨</div>');
      sfx(e.damaged.length ? 'crunch' : 'fanfare');
      if (e.damaged.length) { scene.shake(); try { navigator.vibrate?.(200); } catch {} }
    }, 2600);
  }
  else if (e.kind === 'go') { $('countdown').innerHTML = 'GO!'; show('countdown'); setTimeout(() => show('countdown', false), 600); sfx('fanfare'); }
  else if (e.kind === 'help') {
    const at = scene.project({ x: e.x, z: e.z }); // upstairs: drawn over the ground floor, at that floor's height
    scene.ping(at.x, at.z, at.y || 0, at.fl || 0);
    if (e.id !== myId) { toast(e.text + (at.fl ? ` (floor ${at.fl + 1})` : ''), 'help'); sfx('alarm'); buzz([60, 40, 60]); }
    else toast('🆘 Help request sent to the crew');
    helpPings.push({ x: at.x, z: at.z, fl: at.fl || 0, t: performance.now() });
  }
}
const helpPings = [];

// ---------- meeting ----------
function renderMeeting(s, me) {
  const m = s.meeting;
  if (!m) return;
  const caller = s.players.find(p => p.id === m.callerId);
  const locked = m.voted.includes(myId); // submitted: final
  const canVote = me && !me.out && !me.spectator && !locked;
  $('meeting-sub').textContent = s.game === 'sabotage'
    ? `${caller?.name || 'Someone'} called a meeting. Who is the saboteur? Pick a mover, then submit. Vote wrong and an innocent mover leaves the truck.`
    : `${caller?.name || 'Someone'} heard a crunch. Who broke it? Talk it out, pick a mover, then submit. Wrong call = the caller takes the hit.`;
  $('meeting-timer').textContent = m.timeLeft;
  // narrow screens: an open chat sits over the bottom of the screen, so keep the vote buttons above it
  const chatH = innerWidth < 760 && getComputedStyle($('chat')).display !== 'none' ? $('chat').offsetHeight : 0;
  const pad = chatH ? `${chatH + 16}px` : '';
  if ($('meeting').style.paddingBottom !== pad) $('meeting').style.paddingBottom = pad;
  const key = JSON.stringify([m.voted, myVote, canVote, s.players.map(p => p.id + p.out)]);
  if ($('vote-grid').dataset.key === key) return;
  $('vote-grid').dataset.key = key;
  $('vote-grid').innerHTML = s.players.filter(p => !p.spectator).map(p => `
    <button class="vote ${myVote === p.id ? 'picked' : ''} ${m.voted.includes(p.id) ? 'voted' : ''}" data-id="${p.id}" ${!canVote || p.out ? 'disabled' : ''} aria-pressed="${myVote === p.id}">
      ${portrait(p.char)}<div><div><b>${esc(p.name)}</b>${p.id === myId ? ' (you)' : ''}</div><div class="sub">${p.out ? 'off the truck' : `${p.score} pts · ${p.strikes} strike${p.strikes === 1 ? '' : 's'}`}</div></div>
      <span class="vst">${myVote === p.id ? (locked ? 'Your vote' : 'Picked') : m.voted.includes(p.id) ? 'Has voted' : ''}</span>
    </button>`).join('');
  const skip = $('btn-skip'), go = $('btn-vote'), name = s.players.find(p => p.id === myVote)?.name;
  skip.disabled = !canVote; skip.setAttribute('aria-pressed', String(myVote === 'skip'));
  go.disabled = !canVote || !myVote;
  go.textContent = locked ? (myVote === 'skip' ? 'Skipped. Waiting for the crew' : `Voted ${name || ''}. Waiting for the crew`)
    : !canVote ? 'You can’t vote' : !myVote ? 'Pick someone' : myVote === 'skip' ? 'Submit: skip' : `Submit vote: ${name}`;
}
// tap a mover (or Skip) to pick; tap again to un-pick; change your mind as often as you like until you press Submit
function pickVote(id) { myVote = myVote === id ? null : id; sfx('blip'); if (snap) renderMeeting(snap, meNow()); }
$('vote-grid').addEventListener('click', (e) => {
  const b = e.target.closest('.vote');
  if (!b || b.disabled || !room) return;
  pickVote(b.dataset.id);
});
$('btn-skip').onclick = () => { if (room && !$('btn-skip').disabled) pickVote('skip'); };
$('btn-vote').onclick = () => { if (room && myVote && !$('btn-vote').disabled) { room.send('vote', { target: myVote }); sfx('tick'); } };

// ---------- chat ----------
function onChat(c) {
  const el = document.createElement('div');
  el.innerHTML = c.system ? `<span class="sys">${esc(c.text)}</span>` : `<b>${esc(c.from)}${c.bot ? ' 🤖' : ''}:</b> ${esc(c.text)}`;
  $('chat-log').append(el);
  while ($('chat-log').children.length > 40) $('chat-log').firstChild.remove();
  $('chat-log').scrollTop = 1e9;
  if (snap?.phase === 'playing' || snap?.phase === 'countdown' || snap?.phase === 'results') toast(c.system ? c.text : `💬 ${c.from}: ${c.text}`);
}
function focusChat() { if (!$('chat').classList.contains('hidden')) $('chat-input').focus(); }
$('chat-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const v = $('chat-input').value.trim();
  if (v && room) room.send('chat', { text: v });
  $('chat-input').value = '';
  $('chat-input').blur();
});

// ---------- results ----------
function renderResults(s, me) {
  const r = s.results;
  if (!r) return;
  const key = JSON.stringify(r) + s.hostId + s.players.map(p => p.id + p.ready).join();
  if ($('results').dataset.key === key) return;
  $('results').dataset.key = key;
  $('res-reason').textContent = r.reason;
  if (r.game === 'sabotage') myRole = null;
  const w = r.players.find(p => p.id === r.winnerId), live0 = new Map(s.players.map(p => [p.id, p]));
  if (r.game === 'sabotage') {
    const sp = r.players.find(p => p.id === r.saboteurId);
    $('res-winner').innerHTML = `<div class="outcome ${r.winners}">${r.winners === 'crew' ? '🧰 CREW WINS' : '🕵️ SABOTEUR WINS'}</div>`
      + (sp ? `${portrait(sp.char)}<div class="w">The saboteur was ${esc(sp.name)}${sp.id === myId ? ' (you!)' : ''}</div>` : '')
      + `<div class="team">Final crew score: ${r.crewScore}</div>`;
  } else if (r.teams) {
    const mine = live0.get(myId)?.team;
    $('res-winner').innerHTML = (r.winTeam ? `<div class="outcome team-win" style="--tc:${TEAM_COLORS[r.winTeam - 1]}">${TEAM_NAMES[r.winTeam - 1].toUpperCase()} TEAM WINS${mine === r.winTeam ? ' 🎉' : ''}</div>` : '<div class="outcome">IT’S A TIE</div>')
      + `<div class="team">${r.teams.map(t => `${teamChip(t.t)} <b>${t.score}</b>`).join(' · ')}</div>`
      + (w ? `<div class="w">Top mover: ${esc(w.name)}${w.id === myId ? ' (you)' : ''}</div>` : '');
  } else
  $('res-winner').innerHTML = w ? `<div class="w">${esc(w.name)}${w.id === myId ? ' (you)' : ''} is Mover of the Day</div>` : '<div class="w">Nobody stayed on the truck.</div>';
  // podium: every mover with name on top, place, points, crown for the winner, ✅ when ready to restart
  const live = new Map(s.players.map(p => [p.id, p]));
  const ordinal = (n) => n + (['th', 'st', 'nd', 'rd'][(n % 100 > 10 && n % 100 < 14) ? 0 : n % 10] || 'th');
  // ranked list: place, mover, what they did, points; status in words
  $('res-podium').innerHTML = '<ol class="rank-list">' + r.players.map((p, i) => {
    const t = r.tally?.[p.id], rd = live.get(p.id)?.ready;
    const what = [t ? `${t.pieces} piece${t.pieces === 1 ? '' : 's'} loaded` : null, t?.placement ? `packing ${t.placement > 0 ? '+' : ''}${t.placement}` : null, p.out ? 'off the truck' : null, rd ? 'ready to restart' : null].filter(Boolean).join(' · ');
    return `<li class="${p.id === myId ? 'me' : ''} ${p.out ? 'out' : ''} ${p.id === r.winnerId ? 'win' : ''}">
      <span class="rk">${ordinal(i + 1)}</span><span class="rk-pic">${portrait(p.char)}</span>
      <span class="rk-who"><b>${esc(p.name)}${p.id === myId ? ' <small>(you)</small>' : ''}${p.bot ? ' <small>AI</small>' : ''} ${teamChip(live.get(p.id)?.team)}</b>${what ? `<small>${what}</small>` : ''}</span>
      <span class="rk-pts"><b>${p.score}</b><small>points</small></span></li>`;
  }).join('') + '</ol>';
  const humans = s.players.filter(p => !p.bot);
  const readyN = humans.filter(p => p.ready).length;
  const meReady = !!live.get(myId)?.ready;
  $('btn-ready').textContent = meReady ? `Ready (${readyN} of ${humans.length})` : `Play again${humans.length > 1 ? ` (${readyN} of ${humans.length} ready)` : ''}`;
  $('btn-ready').classList.toggle('on', meReady);
  $('res-table') && ($('res-table').innerHTML = r.players.map((p, i) => `
    <div class="res-row ${p.out ? 'out' : ''} ${p.id === myId ? 'me' : ''}"><span>#${i + 1}</span>${portrait(p.char)}<span><b>${esc(p.name)}</b>${p.id === myId ? ' (you)' : ''}${p.bot ? '<span class="tag-bot">AI</span>' : ''}${p.out ? ' · off the truck' : ''}<br><small>${p.loaded} loaded · ${p.breaks} broken · ${p.strikes} strike${p.strikes === 1 ? '' : 's'}</small></span><span class="s">${p.score}</span><span></span></div>`).join('') +
    `<div class="team">🚚 Team truck value: ${r.teamTotal} pts · ${r.loadedCount}/${r.totalItems} items loaded · ${r.broken} broken${r.difficulty ? ` · AI: ${r.difficulty}` : ''}</div>`);
  $('res-awards').innerHTML = (r.awards || []).filter(a => a.value > 0).map(a => `<div class="award">${a.title}: <b>${esc(a.name)}</b> (${a.value})</div>`).join('');
  $('res-drive').innerHTML = (r.driveoff ? `Drive-off safety <b>${r.driveoff.safety}%</b> <small>(how much of the load arrived without shifting)</small>${r.driveoff.lost.length ? ' · ' + r.driveoff.lost.map(l => `${esc(l.name)} −${l.amt}`).join(', ') : ''}` : '')
    + (r.tally?.[myId] ? (() => { const t = r.tally[myId]; const ln = (lbl, v, cls = '') => `<div class="ln ${v < 0 ? 'neg' : ''} ${cls}"><span>${lbl}</span><span>${v > 0 && cls !== 'tot' ? '+' : ''}${v}</span></div>`;
        return `<div class="tally"><h4>Your load report</h4>${ln(`${t.pieces} piece${t.pieces === 1 ? '' : 's'} in the truck`, t.base)}${t.condition ? ln('Condition (rot, scuffs)', t.condition) : ''}${t.placement ? ln('Placement (support, heavy low, fragile on top)', t.placement) : ''}${t.damage ? ln('Damaged on the drive', t.damage) : ''}${ln('Load total', t.final, 'tot')}</div>`; })() : '');
  $('res-board').innerHTML = '';
  if (s.daily) renderBoard($('res-board'), s.daily, 10);
  const training = s.level?.tutorial;
  $('btn-again').textContent = 'Play a real move against AI movers';
  $('res-truth').innerHTML = r.unresolved.length ? '🕵️ <b>The truth comes out…</b><br>' + r.unresolved.map(u => `${esc(u.culprits)} broke a ${esc(u.type.toLowerCase())} and got away with it.`).join('<br>') : '';
  // training: declared above
  show('btn-again', training);
  show($('btn-ready').parentElement, !training);
  $('res-wait').textContent = training ? '' : s.quick ? 'Quick Play heads back to the lobby on its own in a few seconds.' : humans.length > 1 ? 'The next round starts when everyone taps Restart.' : '';
}
$('btn-again').onclick = async () => {
  if (snap?.level?.tutorial) { const r = room; room = null; await r?.leave(true); connect(null, { solo: true, difficulty: 'easy' }); return; }
  room?.send('start');
};
$('btn-ready').onclick = () => { room?.send('ready'); sfx('blip'); };
$('btn-ready-lobby').onclick = () => { room?.send('ready'); sfx('blip'); };
// settings: newsletter on/off
$('btn-settings').onclick = async () => {
  const el = $('settings'); show(el, el.classList.contains('hidden'));
  if (el.classList.contains('hidden') || !gate?.token) return;
  let known = true;
  try { const j = await (await fetch(`${httpBase}/api/prefs`, { headers: authHeaders() })).json(); known = j.marketing !== null; $('set-news').checked = !!j.marketing; } catch {}
  $('set-note').textContent = known ? 'Turning this off stops all Starside Movers emails. You can still play.'
    : 'Signed in on a new device: you can turn emails off here; turning them on sends a confirm link to your inbox.';
};
$('set-news').onchange = async () => {
  const on = $('set-news').checked;
  try {
    const r = await fetch(`${httpBase}/api/prefs`, { method: 'POST', headers: { 'content-type': 'application/json', ...authHeaders() }, body: JSON.stringify({ marketing: on }) });
    const j = await r.json().catch(() => ({}));
    if (r.status === 202) { $('set-news').checked = false; $('set-note').textContent = '📬 Check your inbox: tap the confirm link to turn emails back on.'; return; }
    if (!r.ok && j.error) { $('set-news').checked = !on; $('set-note').textContent = j.error; return; }
    $('set-note').textContent = r.ok ? (on ? '✅ You’ll get newsletters and offers.' : '✅ Unsubscribed. No more emails.') : 'Could not save. Try again.';
  } catch { $('set-note').textContent = 'Could not save. Try again.'; }
};
$('btn-newgame').onclick = () => leaveToMenu(true);
async function leaveToMenu(askFeedback) {
  closeGameMenu();
  const r = room; room = null;
  try { sessionStorage.removeItem('sm_rt'); } catch {}
  await r?.leave(true).catch(() => {});
  snap = null; lastPhase = null;
  history.replaceState(null, '', location.pathname);
  for (const id of ['hud', 'controls', 'joyzone', 'chat', 'chat-toggle', 'lobby', 'meeting', 'results', 'drive', 'coach', 'train-done']) show(id, false);
  $('train-done').dataset.done = '';
  scene.resetDrive();
  route();
  if (!askFeedback) return;
  let asked = null; try { asked = localStorage.getItem('sm_fb_day'); } catch {}
  if (asked !== todayUTC()) show('feedback');
}

// ---------- in-game menu: resume, settings, quit ----------
let menuOpen = false;
const pref = (k, d) => { try { return localStorage.getItem('sm_' + k) ?? d; } catch { return d; } };
const savePref = (k, v) => { try { localStorage.setItem('sm_' + k, v); } catch {} };
function applyPrefs() {
  scene.camZoom = { close: 0.8, normal: 1, far: 1.45 }[pref('cam', 'normal')] || 1;
  scene.noShake = pref('shake', matchMedia('(prefers-reduced-motion: reduce)').matches ? 'off' : 'on') === 'off'; // reduced motion: no shake unless asked
  scene.showArrow = pref('arrow', 'on') !== 'off';
  if (scene.quality !== pref('gfx', 'auto')) scene.setQuality(pref('gfx', 'auto'));
}
function syncGameMenu() {
  const val = { sound: isMuted() ? 'off' : 'on', music: isMusicOn() ? 'on' : 'off', cam: pref('cam', 'normal'), shake: pref('shake', matchMedia('(prefers-reduced-motion: reduce)').matches ? 'off' : 'on'), gfx: pref('gfx', 'auto'), arrow: pref('arrow', 'on') };
  for (const seg of document.querySelectorAll('.gm-seg')) for (const b of seg.children) b.setAttribute('aria-pressed', String(b.dataset.v === val[seg.dataset.set]));
}
function openGameMenu() {
  if (menuOpen) return;
  menuOpen = true; input.enabled = false;
  syncGameMenu(); show('gm-confirm', false); show('game-menu');
  $('hud-menu').setAttribute('aria-expanded', 'true');
  $('gm-resume').focus();
}
function closeGameMenu() {
  if (!menuOpen) return;
  input.capture = null;
  menuOpen = false; input.enabled = snap?.phase !== 'meeting';
  show('game-menu', false);
  $('hud-menu').setAttribute('aria-expanded', 'false');
}
$('hud-menu').onclick = () => (menuOpen ? closeGameMenu() : openGameMenu());
$('gm-resume').onclick = closeGameMenu;
$('game-menu').addEventListener('click', (e) => { if (e.target.id === 'game-menu') closeGameMenu(); }); // tap outside the sheet
for (const seg of document.querySelectorAll('.gm-seg')) seg.addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  const k = seg.dataset.set, v = b.dataset.v;
  if (k === 'sound') { setMuted(v === 'off'); syncSound(); }
  else if (k === 'music') { setMusic(v === 'on'); syncMusic(); }
  else { savePref(k, v); applyPrefs(); }
  syncGameMenu();
});
$('gm-quit').onclick = () => { show('gm-confirm'); $('gm-quit-no').focus(); };
$('gm-quit-no').onclick = () => { show('gm-confirm', false); $('gm-quit').focus(); };
$('gm-quit-yes').onclick = () => leaveToMenu(false);
addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || $('hud').classList.contains('hidden') || input.capture) return;
  if (document.activeElement?.tagName === 'INPUT') return; // chat box handles its own Escape
  e.preventDefault();
  menuOpen ? closeGameMenu() : openGameMenu();
});
applyPrefs(); syncGameMenu();

// ---------- controls: keyboard keys (movement is always W A S D / arrows) + controller ----------
function renderKeyHelp() {
  const k = (id) => `<kbd>${esc(keyName(input.binds[id]))}</kbd>`;
  $('keyhelp').innerHTML = input.pad.connected
    ? '🎮 Left stick move · <kbd>A</kbd> tap = grab/drop, hold = wrap/disassemble · <kbd>B</kbd> dash/back · <kbd>X</kbd> rotate · <kbd>RB</kbd> flip · <kbd>Y</kbd> call for help · <kbd>LB</kbd> call out · <kbd>Start</kbd> menu'
    : `<kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> move · ${k('action')} or <kbd>Left click</kbd> grab/drop, hold = wrap/disassemble · <kbd>Right click</kbd> place in truck · <kbd>Wheel drag</kbd> turn camera · ${k('dash')} dash/back · ${k('rotate')} rotate · ${k('flip')} flip · ${k('help')} call for help · ${k('callout')} call out · ${k('chat')} chat · <kbd>Esc</kbd> menu`;
  $('hud-callout').innerHTML = `📣 CALL OUT <kbd>${esc(keyName(input.binds.callout))}</kbd>`;
  $('hud-help').innerHTML = `🆘 NEED A HAND <kbd>${esc(keyName(input.binds.help))}</kbd>`;
  $('gm-keys').innerHTML = ACTIONS.map(a => `<li><span>${a.label}</span><span class="gm-key"><kbd>${esc(keyName(input.binds[a.id]))}</kbd>${PAD_LABEL[a.id] ? `<small>🎮 ${PAD_LABEL[a.id]}</small>` : ''}<button class="gm-change" data-act="${a.id}">Change</button></span></li>`).join('');
}
$('gm-keys').addEventListener('click', (e) => {
  const b = e.target.closest('.gm-change'); if (!b) return;
  const id = b.dataset.act;
  b.textContent = 'Press a key…'; b.setAttribute('aria-pressed', 'true');
  $('gm-keynote').textContent = 'Press the key you want (Esc to cancel).';
  input.capture = (code) => {
    if (code === 'Escape') { input.capture = null; $('gm-keynote').textContent = 'Kept the old key.'; renderKeyHelp(); return; }
    const r = input.rebind(id, code);
    if (!r.ok) { $('gm-keynote').textContent = r.why; return; } // keep listening
    input.capture = null;
    const lbl = ACTIONS.find(a => a.id === id).label;
    $('gm-keynote').textContent = r.swapped ? `${lbl}: ${keyName(code)}. ${ACTIONS.find(a => a.id === r.swapped).label} moved to ${keyName(input.binds[r.swapped])}.` : `${lbl}: ${keyName(code)}.`;
    renderKeyHelp();
  };
});
$('gm-keys-reset').onclick = () => { input.resetBinds(); input.capture = null; $('gm-keynote').textContent = 'Keys back to the defaults.'; renderKeyHelp(); };
renderKeyHelp();
const answerFeedback = (v) => {
  if (v) { track(v); toast(v === 'feedback_up' ? '🙌 Thanks! Noted.' : '🙏 Thanks for the honesty!'); }
  try { localStorage.setItem('sm_fb_day', todayUTC()); } catch {}
  show('feedback', false);
};
$('fb-up').onclick = () => answerFeedback('feedback_up');
$('fb-down').onclick = () => answerFeedback('feedback_down');
$('fb-skip').onclick = () => answerFeedback(null);

// ---------- truck aiming: D-pad + drag (drop still happens on ACTION) ----------
const meNow = () => snap?.players.find(p => p.id === myId);
function aimStep(dir) {
  const me = meNow();
  if (!room || !me?.loadMode || !me.cursor) return;
  const [sx, sy] = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] }[dir];
  const st = scene.gridStepFor(sx, sy);
  room.send('aim', { gx: me.cursor.gx + st.dgx, gz: me.cursor.gz + st.dgz });
  sfx('tick');
}
let dpadRepeat = null;
$('dpad').addEventListener('pointerdown', (e) => {
  const b = e.target.closest('button[data-dir]');
  if (!b) return;
  e.preventDefault();
  b.classList.add('down');
  aimStep(b.dataset.dir);
  clearInterval(dpadRepeat);
  dpadRepeat = setInterval(() => aimStep(b.dataset.dir), 220);
  const up = () => { clearInterval(dpadRepeat); b.classList.remove('down'); };
  b.addEventListener('pointerup', up, { once: true });
  b.addEventListener('pointerleave', up, { once: true });
  b.addEventListener('pointercancel', up, { once: true });
});
let lastAim = '';
function dragAim(e) {
  const me = meNow();
  if (!room || !me?.loadMode) return;
  if (e.pointerType === 'touch' && e.type === 'pointerdown' && touches.size > 0) return; // second finger: turning the camera
  if (e.pointerType === 'touch' && e.type === 'pointermove') { const g = touches.get(e.pointerId); if (g && (g.cam || performance.now() - g.t < 160)) return; } // turning the camera, or might be a swipe
  if (e.pointerType !== 'mouse' && e.type === 'pointermove' && !e.buttons && e.pressure === 0) return;
  const cell = scene.pickGrid(e.clientX, e.clientY);
  if (!cell) return;
  const key = cell.gx + ',' + cell.gz;
  if (key === lastAim) return;
  lastAim = key;
  room.send('aim', cell);
}
scene.renderer.domElement.addEventListener('pointerdown', dragAim);
scene.renderer.domElement.addEventListener('pointermove', dragAim);
// mouse: left click = grab/drop, hold left = wrap / take apart; right click = place in the truck (or the same action anywhere)
let mouseAct = false;
const mouseInPlay = () => room && !menuOpen && input.enabled && !$('hud').classList.contains('hidden') && snap?.phase === 'playing';
scene.renderer.domElement.addEventListener('pointerdown', (e) => {
  if (e.pointerType !== 'mouse' || !mouseInPlay()) return;
  const me = meNow();
  if (myDuel && (e.button === 0 || e.button === 2)) { duelTap(); return; }
  if (e.button === 0 && !me?.loadMode) { mouseAct = true; input.actionDown(); }
  else if (e.button === 2) { if (me?.loadMode) dragAim(e); input.s.tapN++; }
});
addEventListener('pointerup', (e) => { if (e.pointerType === 'mouse' && e.button === 0 && mouseAct) { mouseAct = false; input.actionUp(); } });
scene.renderer.domElement.addEventListener('contextmenu', (e) => e.preventDefault());
// touch gestures on the game view (anywhere that isn't the stick or a button; a second finger works while you steer):
// walking around, drag to turn the camera; in the truck, drag on the truck floor to aim, drag off it (or with a second finger) to turn the camera
const touches = new Map();
const cv = scene.renderer.domElement;
cv.addEventListener('pointerdown', (e) => {
  if (e.pointerType !== 'touch') return;
  // in the truck one finger on the truck floor aims; a finger that lands off it, or a second finger, turns the camera
  const cam = !meNow()?.loadMode || touches.size > 0 || !scene.pickGrid(e.clientX, e.clientY);
  touches.set(e.pointerId, { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, t: performance.now(), cam });
});
cv.addEventListener('pointermove', (e) => {
  const g = touches.get(e.pointerId); if (!g) return;
  if (g.cam) turnCam(-(e.clientX - g.x) * 0.008);
  g.x = e.clientX; g.y = e.clientY;
});
const touchEnd = (e) => {
  const g = touches.get(e.pointerId); if (!g) return;
  touches.delete(e.pointerId);
  const me = meNow(), dt = performance.now() - g.t, dist = Math.hypot(e.clientX - g.sx, e.clientY - g.sy);
  void me; void dt; void dist; // (turning a piece is the Rotate / Flip buttons now)
};
cv.addEventListener('pointerup', touchEnd); cv.addEventListener('pointercancel', touchEnd);
/** Turn the camera all the way round, walking about or loading the truck. */
function turnCam(d) {
  if (meNow()?.loadMode) scene.truckYaw = ((scene.truckYaw || 0) + d) % (Math.PI * 2); // all the way round: the wall nearest the camera steps aside
  else scene.camYaw = ((scene.camYaw || 0) + d) % (Math.PI * 2);
}
// hold the wheel (middle button) and move the mouse to turn the camera; double-click the wheel to put it back
let camDrag = null;
scene.renderer.domElement.addEventListener('pointerdown', (e) => {
  if (e.pointerType !== 'mouse' || e.button !== 1) return;
  e.preventDefault(); // no auto-scroll
  const now = performance.now();
  if (now - (camDrag?.up || 0) < 300) { scene.camYaw = 0; scene.truckYaw = 0; camDrag = null; return; }
  camDrag = { x: e.clientX, id: e.pointerId };
  scene.renderer.domElement.setPointerCapture(e.pointerId);
});
scene.renderer.domElement.addEventListener('pointermove', (e) => {
  if (!camDrag?.id || e.pointerId !== camDrag.id) return;
  turnCam((e.clientX - camDrag.x) * 0.008);
  camDrag.x = e.clientX;
});
addEventListener('pointerup', (e) => { if (e.button === 1 && camDrag?.id) camDrag = { up: performance.now() }; });
scene.renderer.domElement.addEventListener('auxclick', (e) => { if (e.button === 1) e.preventDefault(); });

// ---------- training complete ----------
function renderTrainingDone(s) {
  if ($('train-done').dataset.done === '1') return;
  $('train-done').dataset.done = '1';
  const me = s.players.find(p => p.id === myId);
  $('td-portrait').innerHTML = portrait(me?.char || 'nova');
  scene.setBanner(myId, '✅ TRAINING COMPLETE');
}
$('td-menu').onclick = () => leaveToMenu(false);
$('td-play').onclick = async () => { await leaveToMenu(); connect(null, { solo: true, difficulty: 'easy' }); };

// ---------- loop ----------
let last = performance.now(), lastMap = 0;
function loop(now) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  if (input.pad.cam && snap?.phase === 'playing' && !menuOpen) turnCam(-input.pad.cam * dt * 2.4);
  scene.frame(dt);
  const inPlay = snap && !$('hud').classList.contains('hidden');
  if (inPlay) scene.adapt(dt);
  if (inPlay && now - lastMap > 100) { lastMap = now; drawMinimap($('minimap'), scene.level, snap, myId, helpPings, scene.objectivePos()); } // 10 Hz is plenty
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);
route();

// expose for automated smoke checks
window.__sm = { get snap() { return snap; }, get myId() { return myId; }, get room() { return room; }, inRamp, send: (t, m) => room?.send(t, m), scene };
