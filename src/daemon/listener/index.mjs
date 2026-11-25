// Answer listener (detailed design §8): sox captures one utterance at a time (sox's own
// silence detection is the VAD), whisper.cpp recognises it, and only an exact, confident
// vocabulary match counts. Everything else is "unclear" and the listener keeps waiting.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dataDir } from '../../shared/paths.mjs';
import { which } from '../util.mjs';
import { matchAnswer } from './vocabulary.mjs';

/** Pinned model (security §5): Hugging Face ggerganov/whisper.cpp at a fixed revision. */
export const MODEL = {
  file: 'ggml-tiny.en.bin',
  url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-tiny.en.bin',
  sha256: '921e4cf8686fdd993dcd081a5da5b6c365bfde1162e72b08d75ac75289920b1f',
};

const MAX_UTTERANCE_S = 4;
// Tuned on real mic loopback (M1): 2% missed quiet speech; 0.8% fired on room noise.
const START_SECONDS = '0.05';
const THRESHOLD = '1%';
// Vocabulary hint for whisper, written the way whisper writes the answers (capitalised
// sentences). Without it tiny.en hears "deny" as "Tonight" and scores "Allow" at 0.37; with
// it, answers score 0.89–0.99 and noise or unrelated speech still fails to match (M1).
// Never add "okay" to the vocabulary: with this hint, pink noise transcribes as "Okay".
const VOCAB_PROMPT = 'Allow. Deny. Yes. No. Approve. Reject. Show me.';

/** @typedef {{ answer: import('./vocabulary.mjs').Answer|null, heard: string, confidence: number }} Heard */

export class Listener {
  /** @param {{ log?: import('../../shared/log.mjs').Logger, modelPath?: string }} [opts] */
  constructor(opts = {}) {
    this.log = opts.log;
    this.modelPath = process.env.READBACK_MODEL || opts.modelPath || join(dataDir(), 'models', MODEL.file);
    /** @type {boolean|null} */ this.modelVerified = null;
    /** @type {Promise<boolean>|null} */ this.downloading = null;
  }

  /** What is missing, if anything. @returns {string[]} */
  missing() {
    const out = [];
    if (!which('rec')) out.push('sox');
    if (!which('whisper-cli')) out.push('whisper-cpp');
    if (!existsSync(this.modelPath)) out.push('model');
    else if (this.modelVerified === false) out.push('model (checksum mismatch)');
    return out;
  }

  /** Ready to listen: binaries present and the model verified against its pinned hash. */
  async ready() {
    if (!which('rec') || !which('whisper-cli') || !existsSync(this.modelPath)) return false;
    if (this.modelVerified === null) this.modelVerified = await sha256(this.modelPath) === MODEL.sha256;
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
   * Listen until a confident vocabulary answer, the timeout, or abort.
   * @param {{ timeoutMs: number, minConfidence: number, signal?: AbortSignal,
   *           onHeard?: (h: Heard) => void }} opts
   * @returns {Promise<Heard|null>} the accepted answer, or null
   */
  async listen({ timeoutMs, minConfidence, signal, onHeard }) {
    const work = mkdtempSync(join(tmpdir(), 'readback-'));
    const deadline = Date.now() + timeoutMs;
    const timeout = AbortSignal.timeout(Math.max(0, timeoutMs));
    const stop = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let n = 0;
    try {
      while (!stop.aborted && Date.now() < deadline) {
        const wav = join(work, `u${n++}.wav`);
        const captured = await this.capture(wav, stop);
        if (stop.aborted || !captured) break;
        const heard = await this.recognise(wav, stop);
        if (stop.aborted) break;
        if (!heard) continue;
        onHeard?.(heard);
        this.log?.info('listener.heard', { answer: heard.answer, confidence: round(heard.confidence) });
        if (heard.answer && heard.confidence >= minConfidence) return heard;
      }
      return null;
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }

  /**
   * Record one utterance: wait for sound, stop after 0.6 s of silence, cap at 4 s.
   * @private @param {string} wav @param {AbortSignal} stop @returns {Promise<boolean>}
   */
  capture(wav, stop) {
    const args = ['-q', '-c', '1', '-r', '16000', '-b', '16', wav,
      'silence', '1', START_SECONDS, THRESHOLD, '1', '0.6', THRESHOLD, 'trim', '0', String(MAX_UTTERANCE_S)];
    return run(/** @type {string} */ (which('rec')), args, stop).then((code) => code === 0 && existsSync(wav));
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
