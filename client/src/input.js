// Keyboard + touch controls → {mx, mz, hold, tapN, dashN, rotN}
const HOLD_MS = 250;

export class Input {
  constructor({ onCallout, onChatKey }) {
    this.s = { mx: 0, mz: 0, hold: false, tapN: 0, dashN: 0, rotN: 0 };
    this.keys = new Set();
    this.joy = { x: 0, z: 0 };
    this.enabled = true;
    this.onCallout = onCallout;
    this.onChatKey = onChatKey;
    this.actDown = 0; this.actTimer = null;

    addEventListener('keydown', (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
      const k = e.key.toLowerCase();
      if (e.repeat) { if (['e', ' '].includes(k)) e.preventDefault(); return; }
      if (k === 'enter') { this.onChatKey?.(); return; }
      if (!this.enabled) return;
      this.keys.add(k);
      if (k === 'e' || k === ' ') { e.preventDefault(); this.actionDown(); }
      if (k === 'shift') this.s.dashN++;
      if (k === 'r') this.s.rotN++;
      if (k === 'q' || k === 'c') this.onCallout?.();
    });
    addEventListener('keyup', (e) => {
      const k = e.key.toLowerCase();
      this.keys.delete(k);
      if (k === 'e' || k === ' ') this.actionUp();
    });
    addEventListener('blur', () => { this.keys.clear(); this.actionUp(true); });
    this.setupTouch();
  }

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

  setupTouch() {
    const zone = document.getElementById('joyzone');
    const base = document.getElementById('joybase');
    const knob = document.getElementById('joyknob');
    let id = null, ox = 0, oy = 0;
    const R = 50;
    zone.addEventListener('pointerdown', (e) => {
      if (id !== null) return;
      id = e.pointerId; ox = e.clientX; oy = e.clientY;
      base.style.display = 'block';
      base.style.left = ox + 'px'; base.style.top = oy + 'px';
      knob.style.transform = 'translate(-50%,-50%)';
      zone.setPointerCapture(id);
    });
    zone.addEventListener('pointermove', (e) => {
      if (e.pointerId !== id) return;
      let dx = e.clientX - ox, dy = e.clientY - oy;
      const d = Math.hypot(dx, dy);
      if (d > R) { dx = dx / d * R; dy = dy / d * R; }
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
    btn('btn-action', () => this.actionDown(), () => this.actionUp());
    btn('btn-dash', () => this.s.dashN++);
    btn('btn-rot', () => this.s.rotN++);
    btn('btn-callout', () => this.onCallout?.());
  }

  read() {
    let mx = this.joy.x, mz = this.joy.z;
    if (this.enabled) {
      const k = this.keys;
      if (k.has('a') || k.has('arrowleft')) mx -= 1;
      if (k.has('d') || k.has('arrowright')) mx += 1;
      if (k.has('w') || k.has('arrowup')) mz -= 1;
      if (k.has('s') || k.has('arrowdown')) mz += 1;
    } else { mx = 0; mz = 0; }
    const l = Math.hypot(mx, mz);
    if (l > 1) { mx /= l; mz /= l; }
    this.s.mx = +mx.toFixed(2); this.s.mz = +mz.toFixed(2);
    return this.s;
  }
}
