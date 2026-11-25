// JSON-lines logger. Records event types, durations and decisions; never message text
// unless debug is on (NFR privacy). Logging must never throw.
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { dataDir } from './paths.mjs';

/**
 * @typedef {{ info(ev: string, f?: object): void, warn(ev: string, f?: object): void,
 *             debug(ev: string, f?: object): void, setDebug(on: boolean): void }} Logger
 */

/** @param {{ file?: string, debug?: boolean }} [opts] @returns {Logger} */
export function createLogger(opts = {}) {
  const file = opts.file ?? join(dataDir(), 'readback.log');
  let debugOn = !!opts.debug;
  let ready = false;
  /** @param {string} level @param {string} ev @param {object} [fields] */
  const write = (level, ev, fields = {}) => {
    try {
      if (!ready) { mkdirSync(join(file, '..'), { recursive: true }); ready = true; }
      appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), level, ev, ...fields }) + '\n');
    } catch { /* logging is best-effort */ }
  };
  return {
    info: (ev, f) => write('info', ev, f),
    warn: (ev, f) => write('warn', ev, f),
    debug: (ev, f) => { if (debugOn) write('debug', ev, f); },
    setDebug: (on) => { debugOn = on; },
  };
}

/** A logger that discards everything (tests). @returns {Logger} */
export function nullLogger() {
  const noop = () => {};
  return { info: noop, warn: noop, debug: noop, setDebug: noop };
}
