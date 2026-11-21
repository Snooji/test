// Tiny synth sound effects — no audio files to download.
let ctx = null;
const ac = () => {
  if (!ctx) { try { ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch { return null; } }
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
};
addEventListener('pointerdown', () => ac(), { once: true });
addEventListener('keydown', () => ac(), { once: true });

function tone(freq, dur, type = 'sine', vol = 0.15, slide = 0, delay = 0) {
  const c = ac(); if (!c) return;
  const t = c.currentTime + delay;
  const o = c.createOscillator(), g = c.createGain();
  o.type = type; o.frequency.setValueAtTime(freq, t);
  if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(30, freq + slide), t + dur);
  g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
  o.connect(g).connect(c.destination); o.start(t); o.stop(t + dur);
}
function noise(dur, vol = 0.3) {
  const c = ac(); if (!c) return;
  const b = c.createBuffer(1, c.sampleRate * dur, c.sampleRate);
  const d = b.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length) ** 2;
  const s = c.createBufferSource(), g = c.createGain(), f = c.createBiquadFilter();
  f.type = 'lowpass'; f.frequency.value = 1800;
  s.buffer = b; g.gain.value = vol; s.connect(f).connect(g).connect(c.destination); s.start();
}

export function sfx(name) {
  if (name === 'blip') tone(660, 0.08, 'triangle', 0.08, 220);
  else if (name === 'coin') { tone(880, 0.08, 'square', 0.05); tone(1320, 0.12, 'square', 0.05, 0, 0.07); }
  else if (name === 'crunch') { noise(0.35, 0.5); tone(120, 0.3, 'sawtooth', 0.12, -60); }
  else if (name === 'alarm') { for (let i = 0; i < 3; i++) { tone(740, 0.18, 'square', 0.07, 0, i * 0.4); tone(520, 0.18, 'square', 0.07, 0, i * 0.4 + 0.2); } }
  else if (name === 'buzz') tone(140, 0.4, 'sawtooth', 0.1, -40);
  else if (name === 'fanfare') [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.25, 'triangle', 0.1, 0, i * 0.12));
}
