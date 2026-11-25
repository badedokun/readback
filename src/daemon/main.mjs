#!/usr/bin/env node
// Daemon entry: lock, socket, lifecycle. Started detached by the first hook shim that
// cannot connect; exits when idle.
import net from 'node:net';
import { closeSync, existsSync, openSync, readFileSync, unlinkSync, writeSync, chmodSync } from 'node:fs';
import { createLogger } from '../shared/log.mjs';
import { lockPath, socketPath } from '../shared/paths.mjs';
import { Daemon, REQUEST_TYPES } from './daemon.mjs';
import { Listener } from './listener/index.mjs';
import { createEngine, playTone } from './tts/index.mjs';
import { loadConfig } from './config.mjs';

const IDLE_EXIT_MS = Number(process.env.READBACK_IDLE_EXIT_MS ?? 10 * 60_000);
const STALE_SESSION_MS = 2 * 60 * 60_000;   // only for sessions with no known process
const MAX_LINE = 1 << 20;

const log = createLogger({ debug: loadConfig().debug });

if (!acquireLock()) process.exit(0);          // another daemon owns the socket

const engine = createEngine(loadConfig().engine);
const listener = new Listener({ log });
const daemon = new Daemon({ engine, listener, tone: playTone, log });

const sock = socketPath();
try { if (existsSync(sock)) unlinkSync(sock); } catch { /* stale */ }
const oldMask = process.umask(0o177);          // socket is created 0600
const server = net.createServer(onConnection);
server.on('error', (e) => { log.warn('daemon.socket.error', { error: String(e) }); shutdown(1); });
server.listen(sock, () => {
  process.umask(oldMask);
  try { chmodSync(sock, 0o600); } catch { /* best effort */ }
  log.info('daemon.start', { pid: process.pid, engine: engine?.name ?? 'none', listener_missing: listener.missing() });
});

const idleTimer = setInterval(() => {
  const now = Date.now();
  daemon.prune(STALE_SESSION_MS, alive);
  const idle = daemon.sessions.size === 0 && !daemon.queue.busy && !daemon.broker.open
    && now - daemon.lastActivity > IDLE_EXIT_MS;
  if (idle) shutdown(0);
}, Math.min(60_000, IDLE_EXIT_MS));
idleTimer.unref();

process.on('SIGTERM', () => shutdown(0));
process.on('SIGINT', () => shutdown(0));
process.on('uncaughtException', (e) => { log.warn('daemon.crash', { error: String(e?.stack ?? e) }); shutdown(1); });

/** @param {net.Socket} conn */
function onConnection(conn) {
  const ac = new AbortController();
  conn.on('close', () => ac.abort());          // e.g. Claude Code killed the hook (FR-24b)
  conn.on('error', () => {});
  conn.setEncoding('utf8');
  let buf = '';
  conn.on('data', (d) => {
    buf += d;
    if (buf.length > MAX_LINE) { conn.destroy(); return; }
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      dispatch(line, conn, ac.signal);
    }
  });
}

/** @param {string} line @param {net.Socket} conn @param {AbortSignal} signal */
async function dispatch(line, conn, signal) {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (!msg || typeof msg !== 'object' || !REQUEST_TYPES.has(msg.type)) return;   // never execute anything else
  let reply;
  try {
    reply = { id: msg.id, ok: true, ...(await daemon.handle(msg, signal)) };
  } catch (e) {
    log.warn('daemon.handle.error', { type: msg.type, error: String(e) });
    reply = { id: msg.id, ok: false, decision: null };
  }
  // A decision is only delivered to a connection that is still open (FR-24b).
  if (!signal.aborted && !conn.destroyed && conn.writable) conn.write(JSON.stringify(reply) + '\n');
}

function acquireLock() {
  const path = lockPath();
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, 'wx', 0o600);
      writeSync(fd, String(process.pid));
      closeSync(fd);
      return true;
    } catch (e) {
      if (/** @type {any} */ (e).code !== 'EEXIST') return false;
      const pid = Number(readFileSync(path, 'utf8').trim());
      if (pid && pid !== process.pid && alive(pid)) return false;
      try { unlinkSync(path); } catch { /* raced */ }
    }
  }
  return false;
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return /** @type {any} */ (e).code === 'EPERM'; }
}

let stopping = false;
/** @param {number} code */
function shutdown(code) {
  if (stopping) return;
  stopping = true;
  log.info('daemon.stop', { code });
  try { daemon.queue.stop(); } catch { /* ignore */ }
  server.close();
  for (const p of [sock, lockPath()]) { try { unlinkSync(p); } catch { /* gone */ } }
  setTimeout(() => process.exit(code), 150).unref();
}
