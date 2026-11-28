// TTS engines. Every engine: speak(text, {voice, rate}) → { done, cancel }.
// Text goes to the engine on stdin or via argv arrays, never through a shell.
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { dataDir } from '../../shared/paths.mjs';
import { which } from '../util.mjs';

/** @typedef {import('../queue.mjs').Engine} Engine */
/** @typedef {{ cmd: string, args: string[] }} Step */

export const ENGINES = ['auto', 'say', 'piper', 'espeak'];

/**
 * Run one process, or a pipeline (stdout of each step feeds the next), each in its own
 * process group so cancel() kills everything any step started.
 * @param {Step[]} steps @param {string} [stdinText]
 * @returns {{ done: Promise<void>, cancel(): void }}
 */
export function runPipeline(steps, stdinText) {
  let cancelled = false;
  const children = steps.map((s, i) => spawn(s.cmd, s.args, {
    detached: true,
    stdio: ['pipe', i < steps.length - 1 ? 'pipe' : 'ignore', 'ignore'],
  }));
  for (let i = 0; i < children.length - 1; i++) {
    const out = /** @type {import('node:stream').Readable} */ (children[i].stdout);
    out.pipe(children[i + 1].stdin);
  }
  for (const c of children) c.stdin.on('error', () => {});
  const done = Promise.all(children.map((child, i) => new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (cancelled || code === 0) resolve(undefined);
      else reject(new Error(`${steps[i].cmd} exited ${code ?? signal}`));
    });
  }))).then(() => {});
  children[0].stdin.end(stdinText ?? '');
  return {
    done,
    cancel() {
      if (cancelled || children.every((c) => c.exitCode !== null)) return;
      cancelled = true;
      const kill = (sig) => {
        for (const c of children) { try { process.kill(-(/** @type {number} */ (c.pid)), sig); } catch { /* gone */ } }
      };
      kill('SIGTERM');
      setTimeout(() => kill('SIGKILL'), 100).unref();
    },
  };
}

/** One process. @param {string} cmd @param {string[]} args @param {string} [stdinText] */
export function runSpeaker(cmd, args, stdinText) {
  return runPipeline([{ cmd, args }], stdinText);
}

/** macOS `say`. @returns {Engine} */
export function sayEngine() {
  return {
    speak(text, opts = {}) {
      const args = ['-r', String(opts.rate ?? 190)];
      if (opts.voice) args.push('-v', opts.voice);
      args.push('-f', '-');
      return runSpeaker('say', args, text);
    },
  };
}

/** espeak-ng (Linux fallback; robotic but everywhere). `rate` is words per minute, as in espeak. @returns {Engine} */
export function espeakEngine(bin = 'espeak-ng') {
  return {
    speak(text, opts = {}) {
      const args = ['-s', String(opts.rate ?? 190)];
      if (opts.voice) args.push('-v', opts.voice);
      args.push('--stdin');
      return runSpeaker(bin, args, text);
    },
  };
}

/** Where Piper voices live: <data>/voices/*.onnx (each with its .onnx.json). */
export function voicesDir() { return join(dataDir(), 'voices'); }

/**
 * Resolve a Piper voice: an absolute .onnx path, a name in voicesDir(), or (empty) the first
 * voice found there. @param {string} [voice] @returns {string|null}
 */
export function findPiperVoice(voice) {
  if (voice && isAbsolute(voice)) return existsSync(voice) ? voice : null;
  const dir = voicesDir();
  if (voice) {
    const p = join(dir, voice.endsWith('.onnx') ? voice : `${voice}.onnx`);
    return existsSync(p) ? p : null;
  }
  try {
    const first = readdirSync(dir).filter((f) => f.endsWith('.onnx')).sort()[0];
    return first ? join(dir, first) : null;
  } catch { return null; }
}

/** Sample rate from the voice's .onnx.json; Piper's medium voices are 22050 Hz. */
function sampleRate(model) {
  try { return Number(JSON.parse(readFileSync(`${model}.json`, 'utf8')).audio?.sample_rate) || 22050; } catch { return 22050; }
}

/**
 * A raw-PCM player for this machine: PulseAudio (also PipeWire's pulse server), PipeWire, ALSA.
 * @param {number} rate @returns {Step|null}
 */
export function rawPlayer(rate) {
  if (which('paplay')) return { cmd: 'paplay', args: ['--raw', `--rate=${rate}`, '--format=s16le', '--channels=1'] };
  if (which('pw-cat')) return { cmd: 'pw-cat', args: ['--playback', '--rate', String(rate), '--format', 's16', '--channels', '1', '-'] };
  if (which('aplay')) return { cmd: 'aplay', args: ['-q', '-r', String(rate), '-f', 'S16_LE', '-c', '1', '-t', 'raw', '-'] };
  return null;
}

/**
 * Piper neural TTS piped into a raw player. Rate maps to Piper's length scale
 * (about 170 words per minute at 1.0).
 * @param {string} model the .onnx voice @param {Step} player @returns {Engine}
 */
export function piperEngine(model, player, bin = 'piper') {
  return {
    speak(text, opts = {}) {
      const voice = opts.voice ? findPiperVoice(opts.voice) ?? model : model;
      const scale = Math.min(2, Math.max(0.4, 170 / (opts.rate ?? 190))).toFixed(2);
      const piper = { cmd: bin, args: ['--model', voice, '--output-raw', '--length_scale', scale] };
      // Piper reads one utterance per line.
      return runPipeline([piper, player], `${text.replace(/\s*\n\s*/g, ' ')}\n`);
    },
  };
}

/**
 * Test engine: appends each utterance to a file and "plays" for `ms` milliseconds.
 * Selected with READBACK_ENGINE=record:<file>[:ms].
 * @param {string} file @param {number} ms @returns {Engine}
 */
export function recordEngine(file, ms = 50) {
  return {
    speak(text, opts = {}) {
      appendFileSync(file, JSON.stringify({ ts: Date.now(), text, ...opts }) + '\n');
      let timer;
      let finish = /** @type {(v?: unknown) => void} */ (() => {});
      const done = new Promise((resolve) => { finish = resolve; timer = setTimeout(resolve, ms); });
      return { done, cancel() { clearTimeout(timer); finish(); } };
    },
  };
}

/**
 * Pick an engine. `auto` = the first available local engine for this platform:
 * macOS `say`; on Linux Piper (when a voice is installed), then espeak-ng.
 * @param {string} name @param {{ voice?: string }} [opts]
 * @returns {{ name: string, engine: Engine } | null}
 */
export function createEngine(name = 'auto', opts = {}) {
  const override = process.env.READBACK_ENGINE;
  if (override?.startsWith('record:')) {
    const [, file, ms] = override.split(':');
    return { name: 'record', engine: recordEngine(file, Number(ms ?? 50)) };
  }
  const want = override || name;
  const auto = want === 'auto';
  if ((auto || want === 'say') && process.platform === 'darwin' && which('say')) {
    return { name: 'say', engine: sayEngine() };
  }
  if (auto || want === 'piper') {
    const model = which('piper') ? findPiperVoice(want === 'piper' ? opts.voice : '') : null;
    const player = model ? rawPlayer(sampleRate(model)) : null;
    if (model && player) return { name: 'piper', engine: piperEngine(model, player) };
  }
  if (auto || want === 'espeak') {
    const bin = which('espeak-ng') ? 'espeak-ng' : which('espeak') ? 'espeak' : null;
    if (bin) return { name: 'espeak', engine: espeakEngine(bin) };
  }
  // kokoro and cloud engines: M3.
  return null;
}

/** Short confirmation tone after an accepted voice answer (FR-27). */
export function playTone(kind) {
  if (process.env.READBACK_ENGINE?.startsWith('record:')) return;
  if (process.platform === 'darwin' && which('afplay')) {
    runSpeaker('afplay', [`/System/Library/Sounds/${kind === 'allow' ? 'Glass' : 'Basso'}.aiff`]);
    return;
  }
  const file = `/usr/share/sounds/freedesktop/stereo/${kind === 'allow' ? 'complete' : 'dialog-warning'}.oga`;
  if (which('paplay') && existsSync(file)) runSpeaker('paplay', [file]);
}
