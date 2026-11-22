import { Client } from 'colyseus.js';
import { GameScene } from './scene.js';
import { Input } from './input.js';
import { PORTRAITS, CHARACTERS } from './portraits.js';
import { ITEM_TYPES, TIPS, footprint, orientations, ORIENT_LABEL, SUITS, suitUnlocked } from '../../shared/logic.js';
import { inRamp } from '../../shared/world.js';
import { sfx, setMuted, isMuted, setMusic, isMusicOn, musicMood } from './audio.js';
import { drawMinimap } from './minimap.js';

const $ = (id) => document.getElementById(id);
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
const input = new Input({ onCallout: () => room?.send('callout'), onChatKey: () => focusChat(), onHelp: () => room?.send('help') });

// ---------- gate ----------
$('gate-crew').innerHTML = Object.keys(PORTRAITS).map(k => PORTRAITS[k]).join('');
$('gate-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('gate-err').textContent = '';
  const name = $('gate-name').value.trim(), email = $('gate-email').value.trim();
  try {
    const marketing = true; // agreed by playing (see the note under the button)
    const r = await fetch(httpBase + '/api/signup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, email, marketing }) });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || 'Signup failed');
    gate = j;
    try { localStorage.setItem('sm_gate', JSON.stringify(j)); } catch {}
    sfx('blip');
    route();
  } catch (err) { $('gate-err').textContent = err.message; }
});
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
    const r = await fetch(`${httpBase}/api/profile?email=${encodeURIComponent(gate.email)}&token=${gate.token}`);
    if (r.ok) myProfile = await r.json();
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
async function startDemo() {
  if (demoRoom || demoConnecting || room) return;
  demoConnecting = true;
  try {
    const d = await client.joinOrCreate('demo');
    if (room) { d.leave(true).catch(() => {}); return; }
    demoRoom = d;
    scene.demoMode = true;
    d.onMessage('snap', (s) => { if (!room && s.phase !== 'lobby') scene.apply(s, null); });
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

async function connect(roomId, extra = {}) {
  $('home-err').textContent = '';
  stopDemo();
  show('home', false); show('gate', false);
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
    $('home-err').textContent = /not found|locked|full/i.test(msg) ? 'That crew is full or no longer exists. Start a new one!' : 'Could not connect: ' + msg;
    return;
  }
  history.replaceState(null, '', `?room=${room.roomId}`);
  sfx('blip');
  attach(room);
}

function attach(r) {
  room = r;
  autoStartSent = false;
  myId = r.sessionId;
  try { sessionStorage.setItem('sm_rt', JSON.stringify({ roomId: r.roomId, token: r.reconnectionToken })); } catch {}
  r.onMessage('snap', onSnap);
  r.onMessage('evt', onEvent);
  r.onMessage('chat', onChat);
  r.onLeave(async (code) => {
    const intentional = code === 1000 || code === 4000;
    if (!intentional && snap && (snap.phase === 'playing' || snap.phase === 'meeting' || snap.phase === 'countdown')) {
      // phones drop the socket when you switch apps: try to slip back into the same mover
      reconnecting = true;
      toast('📡 Connection lost, reconnecting…', 'crunch');
      for (let i = 0; i < 12; i++) {
        try { const back = await client.reconnect(r.reconnectionToken); reconnecting = false; toast('✅ Reconnected!'); attach(back); return; }
        catch { await new Promise(res => setTimeout(res, 2000)); }
      }
      reconnecting = false;
    }
    room = null; snap = null; lastPhase = null;
    try { sessionStorage.removeItem('sm_rt'); } catch {}
    history.replaceState(null, '', location.pathname);
    for (const s of ['hud', 'controls', 'joyzone', 'dpad', 'chat', 'chat-toggle', 'lobby', 'meeting', 'results']) show(s, false);
    route();
    $('home-err').textContent = 'Disconnected from the crew.';
  });
}

setInterval(() => {
  if (!room || !snap) return;
  room.send('input', input.read());
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
  $('chat').classList.toggle('collapsed', isTouch && phase === 'lobby'); // phones: tap 💬 to open
  input.enabled = phase !== 'meeting';
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
function renderLobby(s, me) {
  if (s.level?.tutorial && s.hostId === myId && !autoStartSent) { autoStartSent = true; room.send('start'); return; } // training starts right away
  $('lobby-code').textContent = room.roomId;
  $('quick-note').textContent = s.quick && s.autoStart ? `⚡ Quick Play: starting in ${s.autoStart}s. Friends who join take an AI's seat.` : s.daily ? `📅 Daily House ${s.daily}: best score today goes on the leaderboard.` : '';
  const link = `${location.origin}${location.pathname}?room=${room.roomId}`;
  if ($('share-link').value !== link) $('share-link').value = link;
  const host = s.hostId === myId;
  const key = JSON.stringify([s.players.map(p => [p.id, p.name, p.char, p.bot, p.suit, p.ready]), s.hostId, s.mode, s.difficulty, s.level?.seed, s.game, s.twist]);
  if ($('lobby').dataset.key === key) return;
  $('lobby').dataset.key = key;
  $('chars').innerHTML = Object.entries(CHARACTERS).map(([k, c]) => {
    const who = s.players.find(p => p.char === k);
    const cls = who?.id === myId ? 'mine' : who ? 'taken' : '';
    return `<button class="char ${cls}" data-char="${k}" ${who?.bot ? 'disabled' : ''}>${who ? `<div class="who">${esc(who.name)}</div>` : ''}${who?.bot ? '<span class="bot" title="AI mover">🤖</span>' : ''}${PORTRAITS[k]}<div class="n">${c.name}</div><div class="k">${c.kind}</div></button>`;
  }).join('');
  for (const b of $('modes').children) { b.classList.toggle('on', b.dataset.mode === s.mode); b.disabled = !host; }
  for (const b of $('games').children) { b.classList.toggle('on', b.dataset.game === s.game); b.disabled = !host; }
  for (const b of $('twists').children) { b.classList.toggle('on', b.dataset.twist === s.twist); b.disabled = !host || !!s.daily; }
  const mySuit = me?.suit || 'classic';
  $('suits').innerHTML = SUITS.map(x => {
    const open = suitUnlocked(x.id, myProfile);
    const col = x.color === null ? 'conic-gradient(#ff8a3d 0 25%,#2ec4b6 0 50%,#7bd84a 0 75%,#a66cff 0)' : '#' + x.color.toString(16).padStart(6, '0');
    const need = x.games ? `${x.games} moves` : `${x.wins} wins`;
    return `<button class="suit ${x.id === mySuit ? 'on' : ''} ${open ? '' : 'locked'}" data-suit="${x.id}" style="background:${col}" title="${x.label}${open ? '' : ` · unlocks after ${need}`}" aria-label="${x.label} suit${open ? '' : ', locked'}">${open ? '' : '<span class="lk">🔒</span>'}</button>`;
  }).join('');
  $('game-desc').textContent = s.game === 'sabotage'
    ? '🕵️ One mover is secretly a saboteur. Pack the truck perfectly before time runs out, or vote them out. Needs 3+ movers.'
    : s.mode === 'load' ? '🧩 Full load: the house holds exactly one truckload. Pack it perfectly. Hold ✋ on the ramp to pull pieces back out.'
    : '🏆 Everyone for themselves. Most points still on the truck wins.';
  const movers = s.players.filter(p => !p.spectator);
  const bots = s.players.filter(p => p.bot);
  $('lobby-players').innerHTML = `Crew (${movers.length}/4): ` + s.players.map(p => `<b>${esc(p.name)}</b>${p.bot ? '<span class="tag-bot">AI</span>' : ''}${p.id === s.hostId ? ' 👑' : p.bot ? '' : p.ready ? ' ✅' : ' ⏳'}`).join(', ');
  const waitingOn = s.players.filter(p => !p.bot && !p.spectator && p.id !== s.hostId && !p.ready);
  const meReadyL = !!me?.ready;
  show('btn-ready-lobby', !host && !!me && !me.spectator);
  $('btn-ready-lobby').classList.toggle('on', meReadyL);
  $('btn-ready-lobby').textContent = meReadyL ? '✅ Ready! (tap to undo)' : '✋ I\'m ready';
  const lv = s.level;
  $('lobby-house').innerHTML = lv ? `🏠 <b>${esc(lv.name)}</b> · ${lv.rooms} rooms · ${Math.round(lv.yard)} m to the truck` : '';
  show('btn-reroll', host && lv && !lv.classic);
  show('bot-controls', host || bots.length > 0);
  markDiff($('lobby-diff'), s.difficulty);
  for (const b of $('lobby-diff').children) b.disabled = !host;
  show($('btn-addbot').parentElement, host);
  $('btn-addbot').disabled = movers.length >= 4;
  $('btn-rmbot').disabled = bots.length === 0;
  show('btn-start', host);
  $('btn-start').disabled = host && waitingOn.length > 0;
  if (host) $('btn-start').textContent = waitingOn.length ? `Waiting for ${waitingOn.length} to ready up…` : 'Start the move ▶';
  $('lobby-wait').textContent = !host ? (meReadyL ? 'You\'re ready. The crew chief 👑 starts when everyone is.' : 'Tap “I’m ready” when you are.')
    : waitingOn.length ? `Waiting on ${waitingOn.map(p => p.name).join(', ')}.`
    : s.game === 'sabotage' && movers.length < 3 ? 'Sabotage needs 3+ movers. Add AI movers or invite friends.'
    : movers.length === 1 ? 'Add AI movers, or share the invite so friends can join.' : 'Everyone ready? Hit start!';
  $('btn-start').disabled = host && (waitingOn.length > 0 || (s.game === 'sabotage' && movers.length < 3));
  if (me && !me.spectator) prefChar = me.char;
}
$('chars').addEventListener('click', (e) => {
  const b = e.target.closest('.char');
  if (!b || !room) return;
  room.send('char', { id: b.dataset.char });
  try { localStorage.setItem('sm_char', b.dataset.char); } catch {}
  sfx('blip');
});
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
  $('hud-timer').textContent = s.level?.tutorial ? '🎓 Training' : s.mode === 'load' ? `🚚 ${fmt(s.timeLeft)}` : fmt(s.timeLeft);
  const tut = s.tutorial;
  show('coach', !!tut && s.phase === 'playing');
  if (tut) {
    const keys = isTouch ? { ACT: '✋', ROT: '⟳', HELP: '🆘' } : { ACT: 'E', ROT: 'R', HELP: 'H' };
    $('coach-text').textContent = (tut.text || '').replace(/\{(ACT|ROT|HELP)\}/g, (_, k) => keys[k]);
    $('coach-dots').innerHTML = Array.from({ length: tut.total || 0 }, (_, i) => `<i class="${i < tut.step ? 'done' : ''}"></i>`).join('');
  }
  scene.tutorialTarget = tut?.target || null;
  $('hud-timer').classList.toggle('low', s.mode !== 'load' && s.timeLeft <= 20);
  if (me) {
    $('hud-score').textContent = `${me.score} pts`;
    const sabotage = s.game === 'sabotage';
    $('hud-strikes').textContent = me.out ? '🚪 OFF THE TRUCK' : sabotage ? (myRole ? '🕵️ Saboteur' : '🧰 Crew') : `Strikes ${me.strikes}/2`;
    $('hud-strikes').classList.toggle('role-sab', sabotage && !!myRole);
    show('hud-crew', sabotage);
    if (sabotage) { $('hud-crew').textContent = s.overtime ? `⏰ Crew ${s.crewScore}` : `🧰 Crew ${s.crewScore}`; $('hud-crew').classList.toggle('drain', !!s.overtime); }
  }
  $('hud-truck').textContent = `🚚 ${s.loadedCount}/${s.totalItems}${isTouch ? '' : ' loaded'}`;
  const held = me?.carry ? s.items.find(i => i.id === me.carry) : null;
  const needHand = !!held && !me.loadMode && ITEM_TYPES[held.type].teamCarry && held.n === 1 && s.players.filter(p => !p.out && !p.spectator).length > 1 && s.phase === 'playing';
  show('hud-help', needHand && !isTouch);
  show('btn-help', needHand && isTouch);
  // phones: D-pad + drag replace the joystick while aiming in the truck
  const aiming = !!me?.loadMode && s.phase === 'playing';
  show('dpad', aiming && isTouch);
  document.body.classList.toggle('aiming', aiming);
  show('joyzone', !aiming && isTouch && s.phase !== 'meeting');
  const canCall = s.phase === 'playing' && s.canCallOut && (s.openBreaks > 0 || s.game === 'sabotage') && me && !me.out && !me.spectator;
  show('hud-callout', canCall && !isTouch);
  show('btn-callout', canCall);
  show('btn-rot', !!me?.loadMode);
  $('dash-label').textContent = me?.loadMode ? 'BACK' : 'DASH';
  $('scoreboard').innerHTML = [...s.players].filter(p => !p.spectator).sort((a, b) => b.score - a.score)
    .map(p => `<div class="sb ${p.out ? 'out' : ''}">${PORTRAITS[p.char]}<span>${esc(p.name)}${p.id === myId ? ' (you)' : ''}</span><b>${p.score}</b>${'✖'.repeat(p.strikes)}</div>`).join('');
  renderPrompt(s, me);
}

function nearest(s, me) {
  let best = null, bd = 1.7;
  for (const it of s.items) {
    if (it.state !== 'floor' && !(it.state === 'carried' && ITEM_TYPES[it.type].teamCarry && it.n === 1)) continue;
    const d = Math.hypot(it.x - me.x, it.z - me.z) - (ITEM_TYPES[it.type].w > 1 ? 0.6 : 0);
    if (d < bd) { bd = d; best = it; }
  }
  return best;
}

function renderPrompt(s, me) {
  let text = '', action = 'ACTION';
  if (!me) return;
  if (me.spectator) text = '👀 Spectating — you join next round';
  else if (me.out) text = '👻 You got kicked off the truck. Float around and watch!';
  else if (s.phase === 'meeting') text = '';
  else if (me.loadMode && me.unloading) {
    text = scene.pullTarget ? `↩️ ${isTouch ? '✋ PULL' : 'E pulls'} the ${scene.pullTarget.toLowerCase()} off this stack · ${isTouch ? 'BACK' : 'Shift'} to leave` : '↩️ Aim at a stack to pull its top piece';
    action = 'PULL';
  } else if (me.loadMode) {
    const it = s.items.find(i => i.id === me.carry);
    const f = it ? footprint(it.type, me.cursor?.rot || 0) : null;
    const turn = it && orientations(it.type).length > 1 ? ` · ${isTouch ? 'ROTATE' : 'R'} turn/flip (${ORIENT_LABEL(f)} ${f.w}×${f.d}×${f.h})` : '';
    text = scene.ghostOk === false ? '⛔ Doesn’t fit there, aim somewhere else' : isTouch ? `🎯 D-pad or drag to aim · ✋ DROP${f && orientations(it.type).length > 1 ? ` · ${ORIENT_LABEL(f)} ${f.w}×${f.d}×${f.h}` : ''}` : '🎯 Move or point to aim · E drop · Shift back' + turn;
    action = 'DROP';
  } else if (!me.carry && !me.dolly && !s.level?.tutorial && s.loadedCount > 0 && Math.abs(me.z) < 2.4 && me.x > 9.4 && me.x < 13) {
    text = `🧩 Hold ${isTouch ? '✋' : 'E'} to unload pieces from the truck and repack`;
    action = 'HOLD ↩️';
  } else if (me.dolly && !me.carry) {
    const d = s.items.find(i => i.id === me.dolly);
    const n = d?.stack?.length || 0;
    text = d?.strain > 0.25 ? '⚠️ A heavy box is crushing the box under it! Get to the truck or restack.'
      : n ? `🛒 Dolly ${n}/3 · ${n < 3 ? `tap ${isTouch ? '✋' : 'E'} by a box to add it · ` : ''}push it to the truck to unload, top box first`
      : `🛒 Dolly 0/3 · tap ${isTouch ? '✋' : 'E'} next to boxes to stack them (boxes only)`;
    action = n < 3 ? 'STACK' : 'SET DOWN';
  } else if (me.carry) {
    const it = s.items.find(i => i.id === me.carry);
    const t = it && ITEM_TYPES[it.type];
    if (t?.teamCarry && it.n === 1 && s.players.filter(p => !p.out && !p.spectator).length > 1) text = `💪 Need a crewmate on the other end of the ${t.label.toLowerCase()} · ${isTouch ? '🆘' : 'H'} calls for help`;
    else if (t) text = `Carrying ${t.label}${t.heavy && !t.furniture ? ' (heavy = slow!)' : ''} → take it to the 🚚 LOAD ZONE`;
    action = 'SET DOWN';
  } else {
    const it = nearest(s, me);
    if (it) {
      const t = ITEM_TYPES[it.type];
      if (it.assembled) { text = `🔧 HOLD to disassemble the ${t.label.toLowerCase()}`; action = 'HOLD 🔧'; }
      else if (it.state === 'carried') { text = `💪 TAP to grab the other end of the ${t.label.toLowerCase()}`; action = 'LIFT'; }
      else if (t.needsWrap && !it.wrapped) { text = `🧣 HOLD to pad-wrap the ${t.label.toLowerCase()} · TAP to grab as-is`; action = 'WRAP/GRAB'; }
      else { text = `TAP to pick up ${t.label}${t.teamCarry ? ' (2-mover lift)' : ''}`; action = 'GRAB'; }
      if (me.task) text = me.task.kind === 'wrap' ? '🧣 Wrapping… keep holding!' : '🔧 Disassembling… keep holding!';
    }
  }
  $('prompt').textContent = text;
  show('prompt', !!text && !s.tutorial); // in training the Coach does the talking
  $('action-label').textContent = action;
}

// ---------- events ----------
function toast(text, cls = '') {
  const el = document.createElement('div');
  el.className = 'toast ' + cls;
  el.textContent = text;
  $('toasts').prepend(el);
  while ($('toasts').children.length > 4) $('toasts').lastChild.remove();
  setTimeout(() => el.remove(), cls ? 7000 : 4500);
}
function onEvent(e) {
  if (e.kind === 'toast') { if (!(e.private && snap?.tutorial)) toast(e.text); }
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
      const won = r && (r.winnerId === myId || (r.game === 'sabotage' && ((r.winners === 'crew' && r.saboteurId !== myId) || (r.winners === 'saboteur' && r.saboteurId === myId))));
      if (won || /Perfect load|Training complete/.test(r?.reason || '')) { scene.confetti(me?.x ?? 11, me?.z ?? 0); buzz([30, 30, 30, 30, 80]); }
    }, 300);
  }
  else if (e.kind === 'role') {
    myRole = !!e.saboteur;
    const r = $('role');
    r.className = myRole ? 'sab' : 'crew';
    r.innerHTML = myRole
      ? '<div class="card"><div class="big-icon">🕵️</div><h2>You are the SABOTEUR</h2><p>Keep the crew from packing a perfect load. Hold ✋ on desks and tables to jam their bolts, and crush boxes when nobody is looking. Don’t get voted out.</p></div>'
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
    scene.ping(e.x, e.z);
    if (e.id !== myId) { toast(e.text, 'help'); sfx('alarm'); buzz([60, 40, 60]); }
    else toast('🆘 Help request sent to the crew');
    helpPings.push({ x: e.x, z: e.z, t: performance.now() });
  }
}
const helpPings = [];

// ---------- meeting ----------
function renderMeeting(s, me) {
  const m = s.meeting;
  if (!m) return;
  const caller = s.players.find(p => p.id === m.callerId);
  const canVote = me && !me.out && !me.spectator && !m.voted.includes(myId);
  $('meeting-sub').textContent = s.game === 'sabotage'
    ? `${caller?.name || 'Someone'} called a meeting. Who is the saboteur? Vote them off. Vote wrong and an innocent mover leaves the truck.`
    : `${caller?.name || 'Someone'} heard a crunch. Who broke it? Talk it out, then vote. Wrong call = the caller takes the hit.`;
  $('meeting-timer').textContent = m.timeLeft;
  const key = JSON.stringify([m.voted, myVote, canVote, s.players.map(p => p.id + p.out)]);
  if ($('vote-grid').dataset.key !== key) {
    $('vote-grid').dataset.key = key;
    $('vote-grid').innerHTML = s.players.filter(p => !p.spectator).map(p => `
      <button class="vote ${myVote === p.id ? 'picked' : ''} ${m.voted.includes(p.id) ? 'voted' : ''}" data-id="${p.id}" ${!canVote || p.out ? 'disabled' : ''}>
        ${PORTRAITS[p.char]}<div><div><b>${esc(p.name)}</b>${p.id === myId ? ' (you)' : ''}</div><div class="sub">${p.out ? 'off the truck' : `${p.score} pts · ${p.strikes} strike${p.strikes === 1 ? '' : 's'}`}</div></div>
      </button>`).join('');
  }
  $('btn-skip').disabled = !canVote;
}
$('vote-grid').addEventListener('click', (e) => {
  const b = e.target.closest('.vote');
  if (!b || b.disabled || !room) return;
  myVote = b.dataset.id; room.send('vote', { target: myVote }); sfx('blip');
});
$('btn-skip').onclick = () => { if (room) { myVote = 'skip'; room.send('vote', { target: 'skip' }); } };

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
  const w = r.players.find(p => p.id === r.winnerId);
  if (r.game === 'sabotage') {
    const sp = r.players.find(p => p.id === r.saboteurId);
    $('res-winner').innerHTML = `<div class="outcome ${r.winners}">${r.winners === 'crew' ? '🧰 CREW WINS' : '🕵️ SABOTEUR WINS'}</div>`
      + (sp ? `${PORTRAITS[sp.char]}<div class="w">The saboteur was ${esc(sp.name)}${sp.id === myId ? ' (you!)' : ''}</div>` : '')
      + `<div class="team">Final crew score: ${r.crewScore}</div>`;
  } else
  $('res-winner').innerHTML = w ? `<div class="w">👑 ${esc(w.name)}${w.id === myId ? ' (you!)' : ''} is Mover of the Day!</div>` : '<div class="w">Nobody stayed on the truck… 🙃</div>';
  // podium: every mover with name on top, place, points, crown for the winner, ✅ when ready to restart
  const live = new Map(s.players.map(p => [p.id, p]));
  const ordinal = (n) => n + (['th', 'st', 'nd', 'rd'][(n % 100 > 10 && n % 100 < 14) ? 0 : n % 10] || 'th');
  $('res-podium').innerHTML = r.players.map((p, i) => `
    <div class="pod ${i === 0 && !p.out ? 'p1' : ''} ${p.id === myId ? 'me' : ''} ${p.out ? 'out' : ''}">
      ${p.id === r.winnerId ? '<span class="crown">👑</span>' : ''}${live.get(p.id)?.ready ? '<span class="rd" title="Ready to restart">✅</span>' : ''}
      <div class="nm">${esc(p.name)}${p.bot ? ' 🤖' : ''}</div>
      ${PORTRAITS[p.char]}
      <div class="place">${ordinal(i + 1)}${p.out ? ' · off the truck' : ''}</div>
      <div class="pts">${p.score}</div>${r.tally?.[p.id] ? `<div class="tl">${r.tally[p.id].pieces} pcs${r.tally[p.id].placement ? ` · packing ${r.tally[p.id].placement}` : ''}</div>` : ''}
    </div>`).join('');
  const humans = s.players.filter(p => !p.bot);
  const readyN = humans.filter(p => p.ready).length;
  const meReady = !!live.get(myId)?.ready;
  $('btn-ready').textContent = meReady ? `✅ Ready (${readyN}/${humans.length})` : `🔁 Restart game${humans.length > 1 ? ` (${readyN}/${humans.length} ready)` : ''}`;
  $('btn-ready').classList.toggle('on', meReady);
  $('res-table') && ($('res-table').innerHTML = r.players.map((p, i) => `
    <div class="res-row ${p.out ? 'out' : ''} ${p.id === myId ? 'me' : ''}"><span>#${i + 1}</span>${PORTRAITS[p.char]}<span><b>${esc(p.name)}</b>${p.id === myId ? ' (you)' : ''}${p.bot ? '<span class="tag-bot">AI</span>' : ''}${p.out ? ' · off the truck' : ''}<br><small>${p.loaded} loaded · ${p.breaks} broken · ${p.strikes} strike${p.strikes === 1 ? '' : 's'}</small></span><span class="s">${p.score}</span><span></span></div>`).join('') +
    `<div class="team">🚚 Team truck value: ${r.teamTotal} pts · ${r.loadedCount}/${r.totalItems} items loaded · ${r.broken} broken${r.difficulty ? ` · AI: ${r.difficulty}` : ''}</div>`);
  $('res-awards').innerHTML = (r.awards || []).filter(a => a.value > 0).map(a => `<div class="award">${a.title}: <b>${esc(a.name)}</b> (${a.value})</div>`).join('');
  $('res-drive').innerHTML = (r.driveoff ? `🚚 Drive-off safety: <b>${r.driveoff.safety}%</b>${r.driveoff.lost.length ? ' · ' + r.driveoff.lost.map(l => `${esc(l.name)} −${l.amt}`).join(', ') : ''}` : '')
    + (r.tally?.[myId] ? (() => { const t = r.tally[myId]; const ln = (lbl, v, cls = '') => `<div class="ln ${v < 0 ? 'neg' : ''} ${cls}"><span>${lbl}</span><span>${v > 0 && cls !== 'tot' ? '+' : ''}${v}</span></div>`;
        return `<div class="tally"><h4>📋 Your load report</h4>${ln(`${t.pieces} piece${t.pieces === 1 ? '' : 's'} in the truck`, t.base)}${t.condition ? ln('Condition (rot, scuffs)', t.condition) : ''}${t.placement ? ln('Placement (support, heavy low, fragile on top)', t.placement) : ''}${t.damage ? ln('Damaged on the drive', t.damage) : ''}${ln('Load total', t.final, 'tot')}</div>`; })() : '');
  $('res-board').innerHTML = '';
  if (s.daily) renderBoard($('res-board'), s.daily, 10);
  const training = s.level?.tutorial;
  $('btn-again').textContent = '🤖 Play a real move vs AI ▶';
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
  try { const j = await (await fetch(`${httpBase}/api/prefs?email=${encodeURIComponent(gate.email)}&token=${gate.token}`)).json(); $('set-news').checked = !!j.marketing; } catch {}
  $('set-note').textContent = 'Turning this off stops all Starside Movers emails. You can still play.';
};
$('set-news').onchange = async () => {
  const on = $('set-news').checked;
  try {
    const r = await fetch(`${httpBase}/api/prefs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: gate.email, token: gate.token, marketing: on }) });
    $('set-note').textContent = r.ok ? (on ? '✅ You’ll get newsletters and offers.' : '✅ Unsubscribed. No more emails.') : 'Could not save. Try again.';
  } catch { $('set-note').textContent = 'Could not save. Try again.'; }
};
$('btn-newgame').onclick = async () => {
  const r = room; room = null;
  try { sessionStorage.removeItem('sm_rt'); } catch {}
  await r?.leave(true).catch(() => {});
  snap = null; lastPhase = null;
  history.replaceState(null, '', location.pathname);
  for (const id of ['hud', 'controls', 'joyzone', 'dpad', 'chat', 'chat-toggle', 'lobby', 'meeting', 'results', 'drive', 'coach']) show(id, false);
  scene.resetDrive();
  route();
  let asked = null; try { asked = localStorage.getItem('sm_fb_day'); } catch {}
  if (asked !== todayUTC()) show('feedback');
};
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

// ---------- training complete ----------
function renderTrainingDone(s) {
  if ($('train-done').dataset.done === '1') return;
  $('train-done').dataset.done = '1';
  const me = s.players.find(p => p.id === myId);
  $('td-portrait').innerHTML = PORTRAITS[me?.char || 'nova'];
  scene.setBanner(myId, '✅ TRAINING COMPLETE');
}
const leaveToMenu = async () => {
  const r = room; room = null;
  try { sessionStorage.removeItem('sm_rt'); } catch {}
  await r?.leave(true).catch(() => {});
  snap = null; lastPhase = null;
  history.replaceState(null, '', location.pathname);
  for (const id of ['hud', 'controls', 'joyzone', 'dpad', 'chat', 'chat-toggle', 'lobby', 'meeting', 'results', 'drive', 'coach', 'train-done']) show(id, false);
  $('train-done').dataset.done = '';
  scene.resetDrive();
  route();
};
$('td-menu').onclick = leaveToMenu;
$('td-play').onclick = async () => { await leaveToMenu(); connect(null, { solo: true, difficulty: 'easy' }); };

// ---------- loop ----------
let last = performance.now();
function loop(now) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  scene.frame(dt);
  if (snap && !$('hud').classList.contains('hidden')) drawMinimap($('minimap'), scene.level, snap, myId, helpPings, scene.objectivePos());
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);
route();

// expose for automated smoke checks
window.__sm = { get snap() { return snap; }, get myId() { return myId; }, inRamp, send: (t, m) => room?.send(t, m), scene };
