// TTS engines. Every engine: speak(text, {voice, rate}) → { done, cancel }.
// Text goes to the engine on stdin or via argv arrays, never through a shell.
import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { which } from '../util.mjs';

/** @typedef {import('../queue.mjs').Engine} Engine */

/**
 * Run a process in its own process group so cancel() can kill everything it started.
 * @param {string} cmd @param {string[]} args @param {string} [stdinText]
 * @returns {{ done: Promise<void>, cancel(): void }}
 */
export function runSpeaker(cmd, args, stdinText) {
  const child = spawn(cmd, args, { detached: true, stdio: ['pipe', 'ignore', 'ignore'] });
  let cancelled = false;
  const done = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (cancelled || code === 0) resolve();
      else reject(new Error(`${cmd} exited ${code ?? signal}`));
    });
  });
  child.stdin.on('error', () => {});
  child.stdin.end(stdinText ?? '');
  return {
    done,
    cancel() {
      if (cancelled || child.exitCode !== null) return;
      cancelled = true;
      const kill = (sig) => { try { process.kill(-(/** @type {number} */ (child.pid)), sig); } catch { /* gone */ } };
      kill('SIGTERM');
      setTimeout(() => kill('SIGKILL'), 100).unref();
    },
  };
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
 * Pick an engine. `auto` = the first available local engine for this platform.
 * @param {string} name @returns {{ name: string, engine: Engine } | null}
 */
export function createEngine(name = 'auto') {
  const override = process.env.READBACK_ENGINE;
  if (override?.startsWith('record:')) {
    const [, file, ms] = override.split(':');
    return { name: 'record', engine: recordEngine(file, Number(ms ?? 50)) };
  }
  const want = override || name;
  if ((want === 'auto' || want === 'say') && process.platform === 'darwin' && which('say')) {
    return { name: 'say', engine: sayEngine() };
  }
  // piper, kokoro, espeak, cloud engines: M2/M3.
  return null;
}

/** Short confirmation tone after an accepted voice answer (FR-27). */
export function playTone(kind) {
  if (process.env.READBACK_ENGINE?.startsWith('record:')) return;
  if (process.platform !== 'darwin' || !which('afplay')) return;
  const sound = kind === 'allow' ? 'Glass' : 'Basso';
  runSpeaker('afplay', [`/System/Library/Sounds/${sound}.aiff`]);
}
