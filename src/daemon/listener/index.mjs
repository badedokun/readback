// Answer listener (detailed design §8): sox captures one utterance at a time (sox's own
// silence detection is the VAD), whisper.cpp recognises it, and only an exact, confident
// vocabulary match counts. Everything else is "unclear" and the listener keeps waiting.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dataDir } from '../../shared/paths.mjs';
import { which } from '../util.mjs';
import { matchAnswer } from './vocabulary.mjs';
import { Segmenter, wav } from './segmenter.mjs';

/** Pinned models (security §5): Hugging Face ggerganov/whisper.cpp at a fixed revision. */
const HF = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1';
// minConfidence: the default bar for "allow" with this model. base.en scores short words lower
// than tiny.en ("Yes." at 0.59–0.85 where tiny.en gives 0.97); in the 28-speaker set, 0.5 kept
// 327 of 369 heard allows against 309 at 0.6, and let through no extra wrong one (test plan §4).
export const MODELS = {
  'tiny.en': { file: 'ggml-tiny.en.bin', url: `${HF}/ggml-tiny.en.bin`, sha256: '921e4cf8686fdd993dcd081a5da5b6c365bfde1162e72b08d75ac75289920b1f', minConfidence: 0.6 },
  'base.en': { file: 'ggml-base.en.bin', url: `${HF}/ggml-base.en.bin`, sha256: 'a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002', minConfidence: 0.5 },
};
/**
 * The model this machine downloads. macOS: base.en (0 false allows in the 28-speaker audio set,
 * where tiny.en had one; 0.65 s per answer with Metal). Linux: tiny.en, because base.en takes
 * about 10 s per answer on a 4-thread CPU (test plan §4).
 */
export const MODEL = process.platform === 'darwin' ? MODELS['base.en'] : MODELS['tiny.en'];
const PINNED = new Map(Object.values(MODELS).map((m) => [m.sha256, m]));

const MAX_UTTERANCE_S = 4;
// Minimum RMS trigger as a fraction of full scale (-48 dBFS); the segmenter also stays 3x
// above the learned background level. M2: at 1% the mic missed every quiet trial (speech
// peaking at -37 dBFS) in a room at -62 dBFS.
const THRESHOLD = 0.004;
const END_SILENCE_MS = 600;
// An "allow" counts only if the speaker then stays quiet this long. Otherwise a pause inside
// "yes … but wait" ends the first utterance and "Yes" alone would approve (M2 noise set).
export const SETTLE_MS = 800;
// Vocabulary hint for whisper, written the way whisper writes the answers (capitalised
// sentences). Without it tiny.en hears "deny" as "Tonight" and scores "Allow" at 0.37; with
// it, answers score 0.89–0.99 and noise or unrelated speech still fails to match (M1).
// Never add "okay" to the vocabulary: with this hint, pink noise transcribes as "Okay".
// M2: every answer phrase is in the hint. Without "Wait", "Don't" and "Keyboard" here, tiny.en
// wrote them as "We", "Done" and "People".
const VOCAB_PROMPT = 'Allow. Deny. Yes. No. Approve. Reject. Go ahead. Stop. Don\'t. Show me. Wait. Hold on. Keyboard.';
// Deny and defer only hand the decision back (keyboard); they may accept a less certain
// hearing than allow, which always needs the configured confidence.
export const SAFE_MIN_CONFIDENCE = 0.4;

/** @typedef {{ answer: import('./vocabulary.mjs').Answer|null, heard: string, confidence: number }} Heard */

export class Listener {
  /** @param {{ log?: import('../../shared/log.mjs').Logger, modelPath?: string }} [opts] */
  constructor(opts = {}) {
    this.log = opts.log;
    this.modelPath = process.env.READBACK_MODEL || opts.modelPath || join(dataDir(), 'models', MODEL.file);
    /** @type {boolean|null} */ this.modelVerified = null;
    /** The pinned model in use, once verified. */ this.model = MODEL;
    /** @type {Promise<boolean>|null} */ this.downloading = null;
  }

  /** What is missing, if anything. @returns {string[]} */
  missing() {
    const out = [];
    if (!hasCapture()) out.push('sox');
    if (!which('whisper-cli')) out.push('whisper-cpp');
    if (!existsSync(this.modelPath)) out.push('model');
    else if (this.modelVerified === false) out.push('model (checksum mismatch)');
    return out;
  }

  /** Ready to listen: binaries present and the model verified against a pinned hash. */
  async ready() {
    if (!hasCapture() || !which('whisper-cli') || !existsSync(this.modelPath)) return false;
    if (this.modelVerified === null) {
      const m = PINNED.get(await sha256(this.modelPath));
      this.modelVerified = Boolean(m);
      if (m) this.model = m;
    }
    return this.modelVerified;
  }

  /** Download the pinned model if it is missing. A hash mismatch disables voice approval. */
  ensureModel() {
    if (existsSync(this.modelPath)) return Promise.resolve(true);
    if (process.env.READBACK_MODEL) return Promise.resolve(false);
    this.downloading ??= (async () => {
      const dir = join(this.modelPath, '..');
      mkdirSync(dir, { recursive: true });
      const tmp = `${this.modelPath}.part`;
      try {
        this.log?.info('model.download.start');
        const res = await fetch(MODEL.url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const buf = Buffer.from(await res.arrayBuffer());
        const digest = createHash('sha256').update(buf).digest('hex');
        if (digest !== MODEL.sha256) throw new Error('checksum mismatch');
        await writeFile(tmp, buf, { mode: 0o644 });
        renameSync(tmp, this.modelPath);
        this.modelVerified = true;
        this.log?.info('model.download.ok');
        return true;
      } catch (e) {
        rmSync(tmp, { force: true });
        this.log?.warn('model.download.fail', { error: String(e) });
        return false;
      } finally {
        this.downloading = null;
      }
    })();
    return this.downloading;
  }

  /**
   * Listen until a confident vocabulary answer, the timeout, or abort. One `rec` stream runs for
   * the whole window; the segmenter cuts it into utterances, recognised one at a time.
   * @param {{ timeoutMs: number, minConfidence: number, signal?: AbortSignal,
   *           onHeard?: (h: Heard) => void }} opts
   * @returns {Promise<Heard|null>} the accepted answer, or null
   */
  async listen({ timeoutMs, minConfidence: configured, signal, onHeard }) {
    // 0 (the config default) means the model's own default bar.
    const minConfidence = configured || this.model.minConfidence;
    const work = mkdtempSync(join(tmpdir(), 'readback-'));
    // A plain timer and listener, not AbortSignal.any(AbortSignal.timeout()): on Node 20 the
    // timeout signal inside any() can be garbage-collected and never fire.
    const ac = new AbortController();
    const stop = ac.signal;
    const deadline = setTimeout(() => ac.abort(), Math.max(0, timeoutMs));
    const onOuter = () => ac.abort();
    if (signal?.aborted) ac.abort(); else signal?.addEventListener('abort', onOuter, { once: true });
    const src = captureCommand();
    const rec = spawn(src.cmd, src.args, { stdio: ['ignore', 'pipe', 'ignore'], env: src.env });
    const killRec = () => { try { rec.kill('SIGTERM'); } catch { /* gone */ } };
    stop.addEventListener('abort', killRec, { once: true });
    const seg = new Segmenter({ threshold: THRESHOLD, endMs: END_SILENCE_MS, maxMs: MAX_UTTERANCE_S * 1000 });
    /** @type {Buffer[]} */ const queue = [];
    let wake = () => {};
    let ended = false;
    const take = (/** @type {Buffer|null} */ u) => { if (u) { queue.push(u); wake(); } };
    // Some sources (PipeWire, a Pulse monitor) send nothing during silence; end the utterance
    // if data stops arriving for as long as the end-of-speech silence.
    let lastData = Date.now();
    const idle = setInterval(() => { if (seg.active && Date.now() - lastData > END_SILENCE_MS) take(seg.flush()); }, 100);
    rec.stdout.on('data', (d) => { lastData = Date.now(); for (const u of seg.push(d)) take(u); });
    const onEnd = () => { clearInterval(idle); take(seg.flush()); ended = true; wake(); };
    rec.once('exit', onEnd);
    rec.once('error', onEnd);
    stop.addEventListener('abort', () => wake(), { once: true });
    let n = 0;
    let unclear = false;     // other speech heard earlier in this window
    try {
      while (!stop.aborted) {
        if (!queue.length) {
          if (ended) break;
          await new Promise((r) => { wake = () => r(undefined); });
          continue;
        }
        const file = join(work, `u${n++}.wav`);
        writeFileSync(file, wav(/** @type {Buffer} */ (queue.shift())));
        const heard = await this.recognise(file, stop);
        if (stop.aborted) break;
        if (!heard) continue;
        onHeard?.(heard);
        this.log?.info('listener.heard', { answer: heard.answer, confidence: round(heard.confidence) });
        if (heard.answer && heard.answer !== 'allow' && heard.confidence >= Math.min(minConfidence, SAFE_MIN_CONFIDENCE)) return heard;
        if (heard.answer !== 'allow' || heard.confidence < minConfidence) { unclear = true; continue; }
        // Fail closed: an allow must be the only thing said in the window. Unclear speech
        // before it ("The build is green…" heard as junk, then "Yes.") means it is not an answer.
        if (unclear) { this.log?.info('listener.unclear_before_allow'); continue; }
        // Fail closed: more speech right after "yes" means the answer was not finished.
        const settled = await new Promise((resolve) => {
          const check = () => queue.length > 0 || seg.active || seg.loud > 0;
          if (check()) { resolve(false); return; }
          const t0 = Date.now();
          const poll = setInterval(() => {
            if (stop.aborted || check()) { clearInterval(poll); resolve(false); }
            else if (Date.now() - t0 >= SETTLE_MS) { clearInterval(poll); resolve(true); }
          }, 20);
        });
        if (stop.aborted) break;
        if (settled) return heard;
        this.log?.info('listener.unsettled', { heard: heard.answer });
      }
      return null;
    } finally {
      clearTimeout(deadline);
      signal?.removeEventListener('abort', onOuter);
      clearInterval(idle);
      ac.abort();
      killRec();
      rmSync(work, { recursive: true, force: true });
    }
  }

  /** @private @param {string} wav @param {AbortSignal} stop @returns {Promise<Heard|null>} */
  async recognise(wav, stop) {
    const base = wav.replace(/\.wav$/, '');
    const args = ['-m', this.modelPath, '-f', wav, '-l', 'en', '-np', '-nt', '--prompt', VOCAB_PROMPT,
      '-oj', '-ojf', '-of', base];
    const code = await run(/** @type {string} */ (which('whisper-cli')), args, stop);
    if (code !== 0 || !existsSync(`${base}.json`)) return null;
    return parseWhisperJson(readFileSync(`${base}.json`, 'utf8'));
  }
}

/** Something that can record: sox `rec`, or on Linux `parec` / `pw-record`. */
function hasCapture() {
  return Boolean(which('rec') || (process.platform === 'linux' && (which('parec') || which('pw-record'))));
}

/**
 * The raw 16 kHz mono s16le capture command for this machine. On Linux prefer the sound
 * server's own recorder: sox defaults to ALSA (blocks forever with no ALSA device) and its
 * Pulse driver buffers its output.
 * @returns {{ cmd: string, args: string[], env: NodeJS.ProcessEnv }}
 */
export function captureCommand() {
  const env = process.env;
  // Tests: a program that writes raw 16 kHz mono s16le to stdout.
  if (env.READBACK_CAPTURE_CMD) return { cmd: process.execPath, args: [env.READBACK_CAPTURE_CMD], env };
  if (process.platform === 'linux') {
    if (which('parec')) return { cmd: 'parec', args: ['--raw', '--format=s16le', '--rate=16000', '--channels=1', '--latency-msec=50'], env };
    if (which('pw-record')) return { cmd: 'pw-record', args: ['--rate', '16000', '--channels', '1', '--format', 's16', '-'], env };
  }
  return { cmd: /** @type {string} */ (which('rec')),
    args: ['-q', '--buffer', '2048', '-t', 'raw', '-r', '16000', '-c', '1', '-b', '16', '-e', 'signed-integer', '-'], env };
}

/** @param {string} json @returns {Heard|null} */
export function parseWhisperJson(json) {
  let d;
  try { d = JSON.parse(json); } catch { return null; }
  const segs = Array.isArray(d?.transcription) ? d.transcription : [];
  const heard = segs.map((s) => String(s.text ?? '')).join(' ').trim();
  // Confidence = mean probability of word tokens only: special tokens (<|endoftext|>, [_BEG_])
  // and punctuation would otherwise inflate or dilute it.
  const tokens = segs.flatMap((s) => (Array.isArray(s.tokens) ? s.tokens : []))
    .filter((t) => typeof t?.p === 'number' && /\p{L}/u.test(String(t.text ?? '')) && !/^\s*(?:<\|.*\|>|\[.*\]?)\s*$/u.test(String(t.text ?? '')));
  const confidence = tokens.length ? tokens.reduce((a, t) => a + t.p, 0) / tokens.length : 0;
  if (!heard || /^\[.*\]$/.test(heard)) return null;   // [BLANK_AUDIO] and friends
  return { answer: matchAnswer(heard), heard, confidence };
}

/** @param {string} cmd @param {string[]} args @param {AbortSignal} stop @returns {Promise<number|null>} */
function run(cmd, args, stop) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: 'ignore' });
    const onAbort = () => { try { child.kill('SIGTERM'); } catch { /* gone */ } };
    stop.addEventListener('abort', onAbort, { once: true });
    child.once('error', () => resolve(null));
    child.once('exit', (code) => { stop.removeEventListener('abort', onAbort); resolve(code); });
  });
}

/** @param {string} file */
function sha256(file) {
  return new Promise((resolve) => {
    const h = createHash('sha256');
    createReadStream(file).on('data', (d) => h.update(d)).on('end', () => resolve(h.digest('hex'))).on('error', () => resolve(''));
  });
}

const round = (n) => Math.round(n * 100) / 100;
