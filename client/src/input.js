// Keyboard, touch and controller → {mx, mz, hold, tapN, dashN, rotN}
// Movement is always W A S D (or the arrow keys, or a stick). Every action has its own key, changeable in Menu → Controls;
// movement keys can't be given to an action.
const HOLD_MS = 250;

export const MOVE_CODES = ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'];
export const ACTIONS = [
  { id: 'action',  label: 'Grab / drop (hold: wrap, take apart)', def: 'KeyE' },
  { id: 'dash',    label: 'Dash (in the truck: back out)',        def: 'ShiftLeft' },
  { id: 'rotate',  label: 'Rotate (in the truck)',                def: 'KeyR' },
  { id: 'flip',    label: 'Flip onto another side (in the truck)', def: 'KeyT' },
  { id: 'help',    label: 'Call for help',                        def: 'KeyH' },
  { id: 'callout', label: 'Call out a crunch',                    def: 'KeyQ' },
  { id: 'chat',    label: 'Chat',                                 def: 'Enter' },
];
const RESERVED = [...MOVE_CODES, 'Escape', 'Tab', 'MetaLeft', 'MetaRight'];
/** controller (standard mapping) */
export const PAD = { action: 0, dash: 1, rotate: 2, help: 3, callout: 4, flip: 5, menu: 9 };
export const PAD_LABEL = { action: 'A', dash: 'B', rotate: 'X', flip: 'RB', help: 'Y', callout: 'LB', chat: '', menu: 'Start' };

/** "KeyE" → "E", "ShiftLeft" → "Shift", "Space" → "Space" */
export function keyName(code) {
  if (!code) return '—';
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (/^(Shift|Control|Alt)(Left|Right)$/.test(code)) return code.replace(/(Left|Right)$/, '').replace('Control', 'Ctrl');
  return { Space: 'Space', Enter: 'Enter', Backquote: '`', Slash: '/', Period: '.', Comma: ',', Semicolon: ';', Quote: "'", BracketLeft: '[', BracketRight: ']', Backslash: '\\', Minus: '-', Equal: '=' }[code] || code;
}

function loadBinds() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem('sm_keys') || '{}') || {}; } catch {}
  const b = {};
  for (const a of ACTIONS) b[a.id] = typeof saved[a.id] === 'string' && !RESERVED.includes(saved[a.id]) ? saved[a.id] : a.def;
  return b;
}

export class Input {
  constructor({ onCallout, onChatKey, onHelp, onMenu, onPad }) {
    this.s = { mx: 0, mz: 0, hold: false, tapN: 0, dashN: 0, rotN: 0, flipN: 0 };
    this.keys = new Set();
    this.joy = { x: 0, z: 0 };
    this.pad = { x: 0, z: 0, prev: [], connected: false };
    this.enabled = true;
    Object.assign(this, { onCallout, onChatKey, onHelp, onMenu, onPad });
    this.actDown = 0; this.actTimer = null;
    this.binds = loadBinds();
    this.capture = null; // waiting for a key to bind (Menu → Controls)

    addEventListener('keydown', (e) => {
      if (this.capture) { e.preventDefault(); e.stopImmediatePropagation(); this.capture(e.code); return; }
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
      const a = this.actionFor(e.code), mash = e.code === 'Space';
      if (e.repeat) { if (a === 'action' || mash) e.preventDefault(); return; }
      if (a === 'chat') { this.onChatKey?.(); return; }
      if (!this.enabled) return;
      this.keys.add(e.code);
      if (a === 'action' || mash) { e.preventDefault(); this.actionDown(); }
      if (a === 'dash') this.s.dashN++;
      if (a === 'rotate') this.s.rotN++;
      if (a === 'flip') this.s.flipN++;
      if (a === 'callout') this.onCallout?.();
      if (a === 'help') this.onHelp?.();
    });
    addEventListener('keyup', (e) => {
      this.keys.delete(e.code);
      if (this.actionFor(e.code) === 'action' || e.code === 'Space') this.actionUp();
    });
    addEventListener('blur', () => { this.keys.clear(); this.actionUp(true); });
    addEventListener('gamepadconnected', () => { this.pad.connected = true; this.onPad?.(true); this.pollPad(); });
    addEventListener('gamepaddisconnected', () => { this.pad.connected = !!this.firstPad(); if (!this.pad.connected) { this.pad.x = this.pad.z = 0; this.onPad?.(false); } });
    this.setupTouch();
  }

  actionFor(code) { for (const [id, c] of Object.entries(this.binds)) if (c === code) return id; return null; }
  isAction(code, id) { return this.binds[id] === code || (id === 'action' && code === 'Space'); }

  /** Give an action a new key. Movement keys and Escape stay as they are; taking a key from another action swaps them. */
  rebind(id, code) {
    if (RESERVED.includes(code)) return { ok: false, why: MOVE_CODES.includes(code) ? 'W A S D and the arrow keys are for moving. Pick another key.' : 'Esc opens the menu. Pick another key.' };
    const other = this.actionFor(code);
    if (other && other !== id) this.binds[other] = this.binds[id];
    this.binds[id] = code;
    try { localStorage.setItem('sm_keys', JSON.stringify(this.binds)); } catch {}
    return { ok: true, swapped: other && other !== id ? other : null };
  }
  resetBinds() { for (const a of ACTIONS) this.binds[a.id] = a.def; try { localStorage.removeItem('sm_keys'); } catch {} }

  actionDown() {
    if (this.actDown) return;
    this.actDown = performance.now();
    this.actTimer = setTimeout(() => { this.s.hold = true; }, HOLD_MS);
  }
  actionUp(cancel = false) {
    if (!this.actDown) return;
    clearTimeout(this.actTimer);
    if (!this.s.hold && !cancel) this.s.tapN++;
    this.s.hold = false;
    this.actDown = 0;
  }

  // ---------- controller (Gamepad API, standard mapping) ----------
  firstPad() { return [...(navigator.getGamepads?.() || [])].find(p => p && p.connected) || null; }
  pollPad() {
    if (this.padLoop) return;
    const step = () => {
      const gp = this.firstPad();
      if (!gp) { this.padLoop = null; this.pad.x = this.pad.z = this.pad.cam = 0; return; }
      const dead = (v) => (Math.abs(v) < 0.25 ? 0 : (v - Math.sign(v) * 0.25) / 0.75);
      let x = dead(gp.axes[0] || 0), z = dead(gp.axes[1] || 0);
      const b = (i) => !!gp.buttons[i]?.pressed;
      if (b(14)) x = -1; if (b(15)) x = 1; if (b(12)) z = -1; if (b(13)) z = 1; // d-pad
      this.pad.x = x; this.pad.z = z; this.pad.cam = dead(gp.axes[2] || 0); // right stick: turn the camera
      const was = (i) => !!this.pad.prev[i], edge = (i) => b(i) && !was(i);
      if (edge(PAD.menu)) this.onMenu?.();
      if (this.mash) { if (edge(PAD.action)) this.mash(); } // tap battle: A mashes
      else if (this.enabled) {
        if (edge(PAD.action)) this.actionDown();
        if (!b(PAD.action) && was(PAD.action)) this.actionUp();
        if (edge(PAD.dash)) this.s.dashN++;
        if (edge(PAD.rotate)) this.s.rotN++;
        if (edge(PAD.flip)) this.s.flipN++;
        if (edge(PAD.help)) this.onHelp?.();
        if (edge(PAD.callout)) this.onCallout?.();
      } else if (was(PAD.action)) this.actionUp(true);
      this.pad.prev = gp.buttons.map(x => x.pressed);
      this.padLoop = requestAnimationFrame(step);
    };
    this.padLoop = requestAnimationFrame(step);
  }
  /** A pressed this frame on the controller (for the tap battle) */
  padPressed(i) { return !!this.firstPad()?.buttons[i]?.pressed; }

  setupTouch() {
    const zone = document.getElementById('joyzone');
    const base = document.getElementById('joybase');
    const knob = document.getElementById('joyknob');
    let id = null, ox = 0, oy = 0;
    const R = 50;
    const place = () => { const r = zone.getBoundingClientRect(); base.style.left = (ox - r.left) + 'px'; base.style.top = (oy - r.top) + 'px'; }; // zone-relative
    zone.addEventListener('pointerdown', (e) => { // the stick appears wherever your thumb lands
      if (id !== null) return;
      id = e.pointerId; ox = e.clientX; oy = e.clientY;
      base.style.display = 'block'; place();
      knob.style.transform = 'translate(-50%,-50%)';
      try { zone.setPointerCapture(id); } catch {} // some browsers refuse; the stick still works without it
    });
    zone.addEventListener('pointermove', (e) => {
      if (e.pointerId !== id) return;
      let dx = e.clientX - ox, dy = e.clientY - oy;
      const d = Math.hypot(dx, dy);
      if (d > R) { ox += dx / d * (d - R); oy += dy / d * (d - R); place(); dx = dx / d * R; dy = dy / d * R; } // and follows it past the rim
      knob.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
      this.joy.x = dx / R; this.joy.z = dy / R;
    });
    const end = (e) => {
      if (e.pointerId !== id) return;
      id = null; this.joy.x = this.joy.z = 0; base.style.display = 'none';
    };
    zone.addEventListener('pointerup', end);
    zone.addEventListener('pointercancel', end);

    const btn = (elId, down, up) => {
      const b = document.getElementById(elId);
      b.addEventListener('pointerdown', (e) => { e.preventDefault(); b.classList.add('down'); down(); });
      const u = (e) => { e.preventDefault(); b.classList.remove('down'); up?.(); };
      b.addEventListener('pointerup', u); b.addEventListener('pointerleave', u); b.addEventListener('pointercancel', u);
    };
    btn('btn-action', () => (this.mash ? this.mash() : this.actionDown()), () => this.actionUp()); // in a tap battle it mashes too
    btn('btn-dash', () => this.s.dashN++);
    btn('btn-callout', () => this.onCallout?.());
    btn('btn-rot', () => this.s.rotN++);
    btn('btn-flip', () => this.s.flipN++);
  }

  read() {
    let mx = this.joy.x + this.pad.x, mz = this.joy.z + this.pad.z;
    if (this.enabled) {
      const k = this.keys;
      if (k.has('KeyA') || k.has('ArrowLeft')) mx -= 1;
      if (k.has('KeyD') || k.has('ArrowRight')) mx += 1;
      if (k.has('KeyW') || k.has('ArrowUp')) mz -= 1;
      if (k.has('KeyS') || k.has('ArrowDown')) mz += 1;
    } else { mx = 0; mz = 0; }
    const l = Math.hypot(mx, mz);
    if (l > 1) { mx /= l; mz /= l; }
    this.s.mx = +mx.toFixed(2); this.s.mz = +mz.toFixed(2);
    return this.s;
  }
}
