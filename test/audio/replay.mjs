// Fake microphone for score-sets: plays a recorded raw file (REPLAY_RAW, 16 kHz mono s16le) in
// real time, then 2 s of silence, then ends.
import { readFileSync } from 'node:fs';
const pcm = Buffer.concat([readFileSync(/** @type {string} */ (process.env.REPLAY_RAW)), Buffer.alloc(16000 * 2 * 2)]);
const chunk = 16000 * 2 / 50;                         // 20 ms
let at = 0;
const t = setInterval(() => {
  if (at >= pcm.length) { clearInterval(t); process.stdout.end(); return; }
  process.stdout.write(pcm.subarray(at, at + chunk));
  at += chunk;
}, 20);
