// Segmenter (listener VAD): pre-roll kept, ends on silence, capped, flushable.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Segmenter, rms, wav } from '../src/daemon/listener/segmenter.mjs';

const RATE = 16000;
/** ms of a 440 Hz tone at `amp` (fraction of full scale), or silence when amp is 0. */
function pcm(ms, amp = 0) {
  const n = Math.round((RATE * ms) / 1000);
  const b = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(amp * 32767 * Math.sin((2 * Math.PI * 440 * i) / RATE)), i * 2);
  return b;
}
const ms = (buf) => Math.round((buf.length / 2 / RATE) * 1000);

test('silence and short clicks never start an utterance', () => {
  const s = new Segmenter();
  assert.deepEqual(s.push(pcm(2000)), []);
  assert.deepEqual(s.push(Buffer.concat([pcm(40, 0.5), pcm(1000)])), []);   // 40 ms < 60 ms start
  assert.equal(s.active, false);
});

test('an utterance keeps the pre-roll before the trigger and ends after 600 ms of quiet', () => {
  const s = new Segmenter();
  // A soft onset under the trigger level (like the "A" of "Allow"), then the loud part.
  const out = s.push(Buffer.concat([pcm(1000), pcm(200, 0.005), pcm(500, 0.3), pcm(700)]));
  assert.equal(out.length, 1);
  const len = ms(out[0]);
  // 300 ms pre-roll (+60 ms start window) + 500 ms speech + 150 ms tail, give or take a frame.
  assert.ok(len >= 900 && len <= 1100, `${len} ms`);
  // The pre-roll reaches back past the soft onset: 100 ms of silence, then the onset.
  const at = (from, to) => rms(out[0].subarray((from * RATE * 2) / 1000, (to * RATE * 2) / 1000));
  assert.equal(at(0, 90), 0);
  assert.ok(at(110, 290) > 0, 'soft onset kept');
});

test('long speech is cut at the maximum length', () => {
  const s = new Segmenter({ maxMs: 1000 });
  const out = s.push(pcm(2500, 0.3));
  assert.equal(out.length, 2);
  assert.ok(ms(out[0]) <= 1000);
});

test('flush() ends an utterance when the source stops sending', () => {
  const s = new Segmenter();
  assert.deepEqual(s.push(pcm(400, 0.3)), []);
  assert.equal(s.active, true);
  const u = s.flush();
  assert.ok(u && ms(u) >= 300);
  assert.equal(s.active, false);
  assert.equal(s.flush(), null);
});

test('chunk boundaries do not matter', () => {
  const audio = Buffer.concat([pcm(500), pcm(400, 0.3), pcm(800)]);
  const whole = new Segmenter().push(audio);
  const s = new Segmenter();
  const parts = [];
  for (let i = 0; i < audio.length; i += 333 * 2 + 1) parts.push(...s.push(audio.subarray(i, i + 333 * 2 + 1)));
  assert.equal(parts.length, 1);
  assert.equal(parts[0].length, whole[0].length);
});

test('wav() writes a valid 16-bit mono header', () => {
  const w = wav(pcm(100), RATE);
  assert.equal(w.toString('ascii', 0, 4), 'RIFF');
  assert.equal(w.readUInt32LE(24), RATE);
  assert.equal(w.readUInt16LE(34), 16);
  assert.equal(w.readUInt32LE(40), 3200);
});

test('quiet speech in a quiet room triggers; steady noise raises the floor so it does not', () => {
  // Quiet room (-69 dBFS RMS), quiet speech (-45 dBFS RMS): above the 0.004 minimum.
  const quiet = new Segmenter({ threshold: 0.004 });
  assert.equal(quiet.push(Buffer.concat([pcm(1000, 0.0005), pcm(400, 0.008), pcm(800, 0.0005)])).length, 1);

  // Steady noise at -40 dBFS: the floor learns it, so the noise alone stops triggering and
  // speech must be 3x above it.
  const noisy = new Segmenter({ threshold: 0.004 });
  noisy.push(pcm(6000, 0.01));
  noisy.flush();
  assert.ok(noisy.level >= 0.018 * 32768, `level ${noisy.level}`);
  assert.equal(noisy.push(pcm(3000, 0.01)).length, 0);
  assert.equal(noisy.active, false);
  assert.equal(noisy.push(Buffer.concat([pcm(400, 0.1), pcm(800, 0.01)])).length, 1);
});
