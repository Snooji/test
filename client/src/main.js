import { Client } from 'colyseus.js';
import { GameScene } from './scene.js';
import { Input } from './input.js';
import { PORTRAITS, CHARACTERS } from './portraits.js';
import { ITEM_TYPES, TIPS } from '../../shared/logic.js';
import { inRamp } from '../../shared/world.js';
import { sfx } from './audio.js';

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
let prefChar = localStorage.getItem('sm_char') || null;

const scene = new GameScene($('app'));
const input = new Input({ onCallout: () => room?.send('callout'), onChatKey: () => focusChat() });

// ---------- gate ----------
$('gate-crew').innerHTML = Object.keys(PORTRAITS).map(k => PORTRAITS[k]).join('');
$('gate-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('gate-err').textContent = '';
  const name = $('gate-name').value.trim(), email = $('gate-email').value.trim();
  try {
    const r = await fetch(httpBase + '/api/signup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, email }) });
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
$('btn-create').onclick = () => connect(null);
$('btn-join').onclick = () => { const c = parseCode($('join-code').value); if (c) connect(c); };

function route() {
  for (const s of ['gate', 'home', 'lobby', 'meeting', 'results']) show(s, false);
  if (!gate?.token) { show('gate'); return; }
  const r = roomFromUrl();
  if (r && !room) { connect(r); return; }
  $('home-hi').textContent = `Welcome, ${gate.name}! Ready to load some trucks?`;
  show('home');
}

async function connect(roomId) {
  $('home-err').textContent = '';
  show('home', false); show('gate', false);
  const opts = { name: gate.name, email: gate.email, token: gate.token, char: prefChar };
  try {
    room = roomId ? await client.joinById(roomId, opts) : await client.create('move', opts);
  } catch (err) {
    room = null;
    const msg = String(err?.message || err);
    if (/gate/i.test(msg) || err?.code === 401) { try { localStorage.removeItem('sm_gate'); } catch {} gate = null; route(); $('gate-err').textContent = 'Please clock in again.'; return; }
    history.replaceState(null, '', location.pathname);
    route();
    $('home-err').textContent = /not found|locked|full/i.test(msg) ? 'That crew is full or no longer exists. Start a new one!' : 'Could not connect: ' + msg;
    return;
  }
  myId = room.sessionId;
  history.replaceState(null, '', `?room=${room.roomId}`);
  sfx('blip');
  room.onMessage('snap', onSnap);
  room.onMessage('evt', onEvent);
  room.onMessage('chat', onChat);
  room.onLeave(() => {
    room = null; snap = null; lastPhase = null;
    history.replaceState(null, '', location.pathname);
    for (const s of ['hud', 'controls', 'joyzone', 'chat', 'lobby', 'meeting', 'results']) show(s, false);
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
  if (s.phase === 'lobby') renderLobby(s, me);
  if (s.phase === 'playing' || s.phase === 'meeting') renderHud(s, me);
  if (s.phase === 'meeting') renderMeeting(s, me);
  if (s.phase === 'results') renderResults(s, me);
}

function onPhase(phase, prev) {
  const playing = phase === 'playing' || phase === 'meeting';
  show('lobby', phase === 'lobby');
  show('hud', playing);
  show('controls', playing && isTouch);
  show('joyzone', playing && isTouch);
  show('meeting', phase === 'meeting');
  show('results', phase === 'results');
  show('chat', phase === 'lobby' || phase === 'meeting');
  input.enabled = phase !== 'meeting';
  if (phase === 'meeting') { myVote = null; sfx('alarm'); }
  if (phase === 'lobby') $('lobby-tip').textContent = TIPS[Math.floor(Math.random() * TIPS.length)];
  if (phase === 'playing' && prev === 'lobby') { $('toasts').innerHTML = ''; toast('🚚 Move day! Grab boxes from the house and load the truck.'); toast(TIPS[Math.floor(Math.random() * TIPS.length)]); }
}

// ---------- lobby ----------
function renderLobby(s, me) {
  $('lobby-code').textContent = room.roomId;
  const link = `${location.origin}${location.pathname}?room=${room.roomId}`;
  if ($('share-link').value !== link) $('share-link').value = link;
  const host = s.hostId === myId;
  const key = JSON.stringify([s.players.map(p => [p.id, p.name, p.char]), s.hostId, s.mode]);
  if ($('lobby').dataset.key === key) return;
  $('lobby').dataset.key = key;
  $('chars').innerHTML = Object.entries(CHARACTERS).map(([k, c]) => {
    const who = s.players.find(p => p.char === k);
    const cls = who?.id === myId ? 'mine' : who ? 'taken' : '';
    return `<button class="char ${cls}" data-char="${k}">${who ? `<div class="who">${esc(who.name)}</div>` : ''}${PORTRAITS[k]}<div class="n">${c.name}</div><div class="k">${c.kind}</div></button>`;
  }).join('');
  for (const b of $('modes').children) { b.classList.toggle('on', b.dataset.mode === s.mode); b.disabled = !host; }
  $('lobby-players').innerHTML = `Crew (${s.players.length}/4): ` + s.players.map(p => `<b>${esc(p.name)}</b>${p.id === s.hostId ? ' 👑' : ''}`).join(', ');
  show('btn-start', host);
  $('lobby-wait').textContent = host ? (s.players.length === 1 ? 'Solo works too — but moving is better with friends. Share the invite!' : 'Everyone ready? Hit start!') : 'Waiting for the crew chief 👑 to start…';
  if (me && !me.spectator) prefChar = me.char;
}
$('chars').addEventListener('click', (e) => {
  const b = e.target.closest('.char');
  if (!b || !room) return;
  room.send('char', { id: b.dataset.char });
  try { localStorage.setItem('sm_char', b.dataset.char); } catch {}
  sfx('blip');
});
$('modes').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b && room) room.send('mode', { mode: b.dataset.mode }); });
$('btn-start').onclick = () => room?.send('start');
$('hud-callout').onclick = () => room?.send('callout');
$('btn-copy').onclick = async () => {
  const link = $('share-link').value;
  try {
    if (navigator.share && isTouch) await navigator.share({ title: 'Starside Movers', text: 'Join my moving crew!', url: link });
    else { await navigator.clipboard.writeText(link); $('btn-copy').textContent = 'Copied!'; setTimeout(() => ($('btn-copy').textContent = 'Copy invite'), 1500); }
  } catch { $('share-link').select(); }
};

// ---------- HUD ----------
const fmt = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
function renderHud(s, me) {
  $('hud-timer').textContent = s.mode === 'load' ? `🚚 ${fmt(s.timeLeft)}` : fmt(s.timeLeft);
  $('hud-timer').classList.toggle('low', s.mode !== 'load' && s.timeLeft <= 20);
  if (me) {
    $('hud-score').textContent = `${me.score} pts`;
    $('hud-strikes').textContent = me.out ? '🚪 OFF THE TRUCK' : '♥'.repeat(2 - me.strikes) + '♡'.repeat(me.strikes);
  }
  const loaded = s.items.filter(i => i.state === 'loaded').length;
  $('hud-truck').textContent = `🚚 ${loaded} loaded`;
  const canCall = s.phase === 'playing' && s.openBreaks > 0 && me && !me.out && !me.spectator;
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
  else if (me.loadMode) {
    text = scene.ghostOk === false ? '⛔ That column is full — aim somewhere else' : '🎯 Move to aim · ACTION drop · R/ROTATE turn · Shift/BACK leave';
    action = 'DROP';
  } else if (me.carry) {
    const it = s.items.find(i => i.id === me.carry);
    const t = it && ITEM_TYPES[it.type];
    if (t?.teamCarry && it.n === 1 && s.players.filter(p => !p.out && !p.spectator).length > 1) text = `💪 Waiting for a crewmate to lift the other end of the ${t.label.toLowerCase()}…`;
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
  show('prompt', !!text);
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
  if (e.kind === 'toast') toast(e.text);
  else if (e.kind === 'emote') { scene.emote(e.id, e.e); if (e.e.startsWith('+')) sfx('coin'); else sfx('blip'); }
  else if (e.kind === 'crunch') {
    toast(e.text, 'crunch'); scene.shake(); sfx('crunch');
    $('flash').classList.add('on'); setTimeout(() => $('flash').classList.remove('on'), 80);
  } else if (e.kind === 'meeting') toast(`📣 ${e.caller} called a crew meeting!`);
  else if (e.kind === 'verdict') {
    const v = $('verdict'); v.textContent = e.text; show(v);
    sfx(e.guilty ? 'coin' : 'buzz');
    setTimeout(() => show(v, false), 4500);
  } else if (e.kind === 'end') sfx('fanfare');
}

// ---------- meeting ----------
function renderMeeting(s, me) {
  const m = s.meeting;
  if (!m) return;
  const caller = s.players.find(p => p.id === m.callerId);
  const canVote = me && !me.out && !me.spectator && !m.voted.includes(myId);
  $('meeting-sub').textContent = `${caller?.name || 'Someone'} heard a crunch. Who broke it? Talk it out, then vote. Wrong call = the caller takes the hit.`;
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
  el.innerHTML = `<b>${esc(c.from)}:</b> ${esc(c.text)}`;
  $('chat-log').append(el);
  while ($('chat-log').children.length > 40) $('chat-log').firstChild.remove();
  $('chat-log').scrollTop = 1e9;
  if (snap?.phase === 'playing') toast(`💬 ${c.from}: ${c.text}`);
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
  const key = JSON.stringify(r) + s.hostId;
  if ($('results').dataset.key === key) return;
  $('results').dataset.key = key;
  $('res-reason').textContent = r.reason;
  const w = r.players.find(p => p.id === r.winnerId);
  $('res-winner').innerHTML = w ? `<span class="crown">👑</span>${PORTRAITS[w.char]}<div class="w">${esc(w.name)} is Mover of the Day!</div>` : '<div class="w">Nobody stayed on the truck… 🙃</div>';
  $('res-table').innerHTML = r.players.map((p, i) => `
    <div class="res-row ${p.out ? 'out' : ''}"><span>#${i + 1}</span>${PORTRAITS[p.char]}<span><b>${esc(p.name)}</b>${p.out ? ' · off the truck' : ''}<br><small>${p.loaded} loaded · ${p.strikes} strike${p.strikes === 1 ? '' : 's'}</small></span><span class="s">${p.score}</span><span></span></div>`).join('') +
    `<div class="team">🚚 Team truck value: ${r.teamTotal} pts · ${r.loadedCount}/${r.totalItems} items loaded · ${r.broken} broken</div>`;
  $('res-truth').innerHTML = r.unresolved.length ? '🕵️ <b>The truth comes out…</b><br>' + r.unresolved.map(u => `${esc(u.culprits)} broke a ${esc(u.type.toLowerCase())} and got away with it.`).join('<br>') : '';
  const host = s.hostId === myId;
  show('btn-again', host); show('btn-tolobby', host);
  $('res-wait').textContent = host ? '' : 'Waiting for the crew chief to start the next move…';
}
$('btn-again').onclick = () => room?.send('start');
$('btn-tolobby').onclick = () => room?.send('lobby');

// ---------- loop ----------
let last = performance.now();
function loop(now) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  scene.frame(dt);
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);
route();

// expose for automated smoke checks
window.__sm = { get snap() { return snap; }, get myId() { return myId; }, inRamp, send: (t, m) => room?.send(t, m) };
