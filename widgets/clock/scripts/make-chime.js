// Builds the clock's default alarm sound, sounds/chime.wav (#130): a four-note bell arpeggio (C6 E6 G6 C7, MIT like the rest of the project) made from sine waves
// here, so it has no outside source to credit; covered by this repository's LICENSE. Run: node scripts/make-chime.js
// The file ends with a short silence so "repeat" leaves a gap between rings.
const fs = require('fs');
const path = require('path');

const RATE = 22050;
const LENGTH = 2.0; // seconds, including the silent tail
const NOTES = [
  { at: 0, freq: 1046.5 }, // C6
  { at: 0.16, freq: 1318.5 }, // E6
  { at: 0.32, freq: 1568.0 }, // G6
  { at: 0.48, freq: 2093.0 }, // C7
];
const DECAY = 4.2; // per second
const PEAK = 0.32;

function sample(t) {
  let v = 0;
  for (const n of NOTES) {
    const dt = t - n.at;
    if (dt < 0) continue;
    const attack = Math.min(1, dt / 0.005);
    const env = attack * Math.exp(-DECAY * dt);
    // A bell: the note, a softer octave and a faint inharmonic partial.
    v += env * (Math.sin(2 * Math.PI * n.freq * dt) + 0.3 * Math.sin(2 * Math.PI * n.freq * 2 * dt) + 0.08 * Math.sin(2 * Math.PI * n.freq * 2.76 * dt));
  }
  // Fade the last 0.1 s of sound to zero before the tail.
  const end = 1.6;
  const fade = t > end - 0.1 ? Math.max(0, (end - t) / 0.1) : 1;
  return v * PEAK * fade;
}

const count = Math.round(RATE * LENGTH);
const data = Buffer.alloc(count * 2);
for (let i = 0; i < count; i++) {
  const v = Math.max(-1, Math.min(1, sample(i / RATE)));
  data.writeInt16LE(Math.round(v * 32767), i * 2);
}
const head = Buffer.alloc(44);
head.write('RIFF', 0);
head.writeUInt32LE(36 + data.length, 4);
head.write('WAVE', 8);
head.write('fmt ', 12);
head.writeUInt32LE(16, 16);
head.writeUInt16LE(1, 20); // PCM
head.writeUInt16LE(1, 22); // mono
head.writeUInt32LE(RATE, 24);
head.writeUInt32LE(RATE * 2, 28);
head.writeUInt16LE(2, 32);
head.writeUInt16LE(16, 34);
head.write('data', 36);
head.writeUInt32LE(data.length, 40);

const out = path.join(__dirname, '..', 'sounds', 'chime.wav');
fs.writeFileSync(out, Buffer.concat([head, data]));
console.log(`${out} ${head.length + data.length} bytes`);
