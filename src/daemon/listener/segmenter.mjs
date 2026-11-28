// Energy voice-activity segmenter for 16-bit mono PCM. Replaces sox's `silence` effect, which
// discards everything before its trigger and so clipped the start of words ("Allow" lost its
// "A"; "deny" came out as "Good night"). This keeps a pre-roll from before the trigger.

/**
 * @typedef {{ rate?: number, frameMs?: number, threshold?: number, startMs?: number,
 *             endMs?: number, preRollMs?: number, maxMs?: number, floorRatio?: number }} SegmenterOptions
 *
 * `threshold` is the minimum trigger level (RMS as a fraction of full scale). The segmenter
 * also tracks the background level and triggers only `floorRatio` times above it, so a quiet
 * room hears quiet speech and a noisy one does not fire on the noise.
 */

export class Segmenter {
  /** @param {SegmenterOptions} [o] */
  constructor(o = {}) {
    this.rate = o.rate ?? 16000;
    this.frameBytes = Math.round((this.rate * (o.frameMs ?? 20)) / 1000) * 2;
    this.min = (o.threshold ?? 0.01) * 32768;            // RMS, as a fraction of full scale
    this.ratio = o.floorRatio ?? 3;
    this.floor = this.min / this.ratio;                  // background RMS, learned
    const frames = (ms) => Math.max(1, Math.round(ms / (o.frameMs ?? 20)));
    this.startFrames = frames(o.startMs ?? 60);
    this.endFrames = frames(o.endMs ?? 600);
    this.preFrames = frames(o.preRollMs ?? 300);
    this.maxFrames = frames(o.maxMs ?? 4000);
    this.pending = Buffer.alloc(0);
    /** @type {Buffer[]} */ this.pre = [];             // recent frames before speech
    /** @type {Buffer[]|null} */ this.speech = null;    // frames of the current utterance
    this.loud = 0;
    this.quiet = 0;
  }

  /**
   * Feed raw PCM. @param {Buffer} chunk
   * @returns {Buffer[]} utterances completed by this chunk (with pre-roll, without the trailing silence)
   */
  push(chunk) {
    const out = [];
    this.pending = Buffer.concat([this.pending, chunk]);
    while (this.pending.length >= this.frameBytes) {
      const frame = this.pending.subarray(0, this.frameBytes);
      this.pending = this.pending.subarray(this.frameBytes);
      const u = this.frame(Buffer.from(frame));
      if (u) out.push(u);
    }
    return out;
  }

  /**
   * End the current utterance now (the source went quiet without sending silence, or stopped).
   * @returns {Buffer|null}
   */
  flush() {
    if (!this.speech) return null;
    const u = Buffer.concat(this.speech);
    this.speech = null;
    this.loud = 0;
    this.quiet = 0;
    return u;
  }

  /** The current trigger level (RMS, 16-bit units). */
  get level() { return Math.max(this.min, this.floor * this.ratio); }

  /** In an utterance right now. */
  get active() { return this.speech !== null; }

  /** @private @param {Buffer} f @returns {Buffer|null} */
  frame(f) {
    const r = rms(f);
    const loud = r >= this.level;
    // Learn the background: between utterances it falls fast and rises slowly (so the start of
    // a word barely moves it); inside one it rises very slowly (steady noise that holds an
    // utterance open still raises it).
    const a = this.speech ? 0.005 : r < this.floor ? 0.05 : 0.01;
    this.floor += a * (r - this.floor);
    if (!this.speech) {
      this.pre.push(f);
      if (this.pre.length > this.preFrames + this.startFrames) this.pre.shift();
      this.loud = loud ? this.loud + 1 : 0;
      if (this.loud >= this.startFrames) {
        this.speech = this.pre;
        this.pre = [];
        this.quiet = 0;
      }
      return null;
    }
    this.speech.push(f);
    this.quiet = loud ? 0 : this.quiet + 1;
    if (this.quiet >= this.endFrames || this.speech.length >= this.maxFrames) {
      const keep = this.quiet >= this.endFrames ? this.speech.length - this.quiet + Math.round(this.preFrames / 2) : this.speech.length;
      const u = Buffer.concat(this.speech.slice(0, keep));
      this.speech = null;
      this.loud = 0;
      return u;
    }
    return null;
  }
}

/** @param {Buffer} f */
export function rms(f) {
  let sum = 0;
  const n = f.length >> 1;
  for (let i = 0; i < n; i++) { const s = f.readInt16LE(i * 2); sum += s * s; }
  return n ? Math.sqrt(sum / n) : 0;
}

/** A 16-bit mono WAV file around raw PCM. @param {Buffer} pcm @param {number} rate */
export function wav(pcm, rate = 16000) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}
