// Tiny synth sound effects — no audio files to download.
let ctx = null;
let muted = false;
try { muted = localStorage.getItem('sm_mute') === '1'; } catch {}
export const isMuted = () => muted;
export function setMuted(m) { muted = !!m; try { localStorage.setItem('sm_mute', muted ? '1' : '0'); } catch {} }
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
  if (muted) return;
  if (name === 'tick') return tone(880, 0.04, 'triangle', 0.05);
  if (name === 'blip') tone(660, 0.08, 'triangle', 0.08, 220);
  else if (name === 'coin') { tone(880, 0.08, 'square', 0.05); tone(1320, 0.12, 'square', 0.05, 0, 0.07); }
  else if (name === 'crunch') { noise(0.35, 0.5); tone(120, 0.3, 'sawtooth', 0.12, -60); }
  else if (name === 'alarm') { for (let i = 0; i < 3; i++) { tone(740, 0.18, 'square', 0.07, 0, i * 0.4); tone(520, 0.18, 'square', 0.07, 0, i * 0.4 + 0.2); } }
  else if (name === 'buzz') tone(140, 0.4, 'sawtooth', 0.1, -40);
  else if (name === 'fanfare') [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.25, 'triangle', 0.1, 0, i * 0.12));
}

// ---------- background music: a tiny procedural loop (no files) ----------
let musicOn = true, mood = 'calm', musicTimer = null, nextNote = 0, step = 0, musicGain = null;
try { musicOn = localStorage.getItem('sm_music') !== '0'; } catch {}
export const isMusicOn = () => musicOn;
export function setMusic(on) { musicOn = !!on; try { localStorage.setItem('sm_music', musicOn ? '1' : '0'); } catch {} if (!musicOn) stopMusic(); else startMusic(); }
export function musicMood(m) { mood = m; }
const midi = (n) => 440 * 2 ** ((n - 69) / 12);
const SONGS = {
  calm:  { bpm: 112, chords: [[48, 55, 64, 67], [45, 52, 60, 64], [41, 48, 57, 60], [43, 50, 59, 62]] }, // C  Am  F  G
  tense: { bpm: 84,  chords: [[45, 52, 60, 63], [41, 48, 56, 60], [44, 51, 59, 62], [40, 47, 56, 59]] }, // spooky minor
  rush:  { bpm: 140, chords: [[48, 55, 64, 67], [43, 50, 59, 62], [45, 52, 60, 64], [41, 48, 57, 60]] },
};
function voice(freq, t, dur, type, vol) {
  const c = ac(); if (!c) return;
  const o = c.createOscillator(), g = c.createGain();
  o.type = type; o.frequency.setValueAtTime(freq, t);
  g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(vol, t + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(musicGain); o.start(t); o.stop(t + dur + 0.02);
}
function schedule() {
  const c = ac(); if (!c || !musicOn || muted) return;
  const song = SONGS[mood] || SONGS.calm, sixteenth = 60 / song.bpm / 4;
  if (nextNote < c.currentTime) nextNote = c.currentTime + 0.05;
  while (nextNote < c.currentTime + 0.25) {
    const bar = Math.floor(step / 16) % song.chords.length, s = step % 16, ch = song.chords[bar];
    if (s % 8 === 0) voice(midi(ch[0] - 12), nextNote, sixteenth * 7, 'triangle', 0.09);           // bass
    if (s % 2 === 0) voice(midi(ch[(s / 2) % 4] + 12), nextNote, sixteenth * 1.6, 'square', 0.018); // arpeggio
    if (mood !== 'tense' && s % 4 === 2) voice(9000, nextNote, 0.02, 'square', 0.004);                // hat tick
    nextNote += sixteenth; step++;
  }
}
export function startMusic() {
  if (musicTimer || !musicOn) return;
  const c = ac(); if (!c) return;
  if (!musicGain) { musicGain = c.createGain(); musicGain.gain.value = 0.8; musicGain.connect(c.destination); }
  musicTimer = setInterval(schedule, 100);
}
export function stopMusic() { clearInterval(musicTimer); musicTimer = null; }
addEventListener('pointerdown', () => startMusic(), { once: true });
addEventListener('keydown', () => startMusic(), { once: true });
