import { accessSync, constants } from 'node:fs';
import { delimiter, join } from 'node:path';

const cache = new Map();

/** Find an executable on PATH (cached). @param {string} bin @returns {string|null} */
export function which(bin) {
  if (cache.has(bin)) return cache.get(bin);
  let found = null;
  const dirs = (process.env.PATH ?? '').split(delimiter);
  // Hook processes may get a minimal PATH; also look where Homebrew installs.
  for (const d of [...dirs, '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin']) {
    if (!d) continue;
    const p = join(d, bin);
    try { accessSync(p, constants.X_OK); found = p; break; } catch { /* next */ }
  }
  cache.set(bin, found);
  return found;
}

/** @param {number} ms @param {AbortSignal} [signal] */
export function sleep(ms, signal) {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); resolve(undefined); }, { once: true });
  });
}

/** Basename of a cwd, for "In <project>: …". @param {string} cwd */
export function projectName(cwd) {
  return String(cwd ?? '').replace(/\/+$/, '').split('/').pop() || 'your project';
}
