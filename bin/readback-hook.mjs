#!/usr/bin/env node
// Readback hook shim. One short-lived process per hook event:
//   node readback-hook.mjs <session-start|session-end|stop|notification|permission|prompt>
// Reads the hook payload on stdin, forwards it to the daemon over a Unix socket, and for
// `permission` and `prompt` prints the hook decision. It must stay light (no heavy imports)
// and must never break Claude Code: every failure path exits 0 with no output.
import net from 'node:net';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { socketPath } from '../src/shared/paths.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DAEMON = join(ROOT, 'src', 'daemon', 'main.mjs');
const PERMISSION_WAIT_MS = 28_000;   // 2 s under the 30 s hook timeout
const COMMAND_WAIT_MS = 1_000;
const ASYNC_WAIT_MS = 1_500;
const CONNECT_RETRY_MS = 300;
const COMMAND_RE = /^\/readback:(\w+)\s*(.*)$/s;

const event = process.argv[2] ?? '';

main().catch(() => done());

async function main() {
  let input;
  try { input = JSON.parse(await readStdin()); } catch { return done(); }
  if (!input || typeof input !== 'object') return done();
  const session = String(input.session_id ?? '');
  const cwd = String(input.cwd ?? '');

  switch (event) {
    case 'session-start':
      await sendOnly({ type: 'hello', session, cwd, pid: process.ppid });
      return done();
    case 'session-end':
      await sendOnly({ type: 'bye', session });
      return done();
    case 'stop':
      if (input.stop_hook_active === true) return done();
      if (typeof input.last_assistant_message !== 'string') return done();
      await sendOnly({ type: 'speak.turn', session, cwd, text: input.last_assistant_message });
      return done();
    case 'notification':
      await sendOnly({
        type: 'alert', session, cwd,
        kind: String(input.notification_type ?? ''), message: String(input.message ?? ''),
      });
      return done();
    case 'permission': {
      const reply = await request({
        type: 'permission.ask', session, cwd,
        tool_name: String(input.tool_name ?? ''), tool_input: input.tool_input ?? {},
        mcp_server: input.mcp_server,
      }, PERMISSION_WAIT_MS, { spawnIfMissing: true });
      const decision = reply?.decision;
      if (decision === 'allow') return done(permissionOut({ behavior: 'allow' }));
      if (decision === 'deny') return done(permissionOut({ behavior: 'deny', message: 'Denied by voice' }));
      return done();
    }
    case 'prompt': {
      const prompt = String(input.prompt ?? '').trim();
      const m = COMMAND_RE.exec(prompt);
      // FR-31: any prompt stops speech. For a command, the stop rides on the same connection.
      if (!m) {
        await sendOnly({ type: 'stop', session }, { spawnIfMissing: false });
        return done();
      }
      const reply = await request(
        { type: 'command', session, cwd, name: m[1], args: m[2].trim() },
        COMMAND_WAIT_MS, { spawnIfMissing: true, preface: [{ type: 'stop', session }] },
      );
      const message = typeof reply?.message === 'string' ? reply.message : 'not running';
      return done(JSON.stringify({
        decision: 'block', reason: `readback: ${message}`, suppressOriginalPrompt: true,
      }));
    }
    default:
      return done();
  }
}

/** @param {object} decision */
function permissionOut(decision) {
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } });
}

/** Fire-and-forget: wait only for the daemon's ack so the write is not lost. */
async function sendOnly(msg, opts = { spawnIfMissing: true }) {
  await request(msg, ASYNC_WAIT_MS, opts);
}

/**
 * Send one request (optionally preceded by fire-and-forget messages) and wait for its reply.
 * Resolves null on any failure or timeout.
 * @param {object} msg @param {number} timeoutMs
 * @param {{ spawnIfMissing?: boolean, preface?: object[] }} opts
 * @returns {Promise<any>}
 */
async function request(msg, timeoutMs, opts) {
  const sock = await connect(!!opts.spawnIfMissing);
  if (!sock) return null;
  const id = `${process.pid}-${Date.now()}`;
  return new Promise((resolve) => {
    let buf = '';
    const finish = (v) => { clearTimeout(timer); sock.destroy(); resolve(v); };
    const timer = setTimeout(() => finish(null), timeoutMs);
    sock.setEncoding('utf8');
    sock.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        try { const r = JSON.parse(line); if (r.id === id) return finish(r); } catch { /* skip */ }
      }
    });
    sock.on('error', () => finish(null));
    sock.on('close', () => finish(null));
    const lines = [...(opts.preface ?? []).map((p, n) => ({ ...p, id: `${id}-p${n}` })), { ...msg, id }];
    sock.write(lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  });
}

/** @param {boolean} spawnIfMissing @returns {Promise<net.Socket|null>} */
async function connect(spawnIfMissing) {
  const path = socketPath();
  const attempt = () => new Promise((resolve) => {
    const s = net.connect(path);
    s.once('connect', () => resolve(s));
    s.once('error', () => resolve(null));
  });
  let s = await attempt();
  if (s || !spawnIfMissing) return s;
  startDaemon();
  const deadline = Date.now() + CONNECT_RETRY_MS;
  while (!s && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 30));
    s = await attempt();
  }
  return s;
}

function startDaemon() {
  try {
    const child = spawn(process.execPath, [DAEMON], { detached: true, stdio: 'ignore', env: process.env });
    child.unref();
  } catch { /* daemon unavailable: fail closed */ }
}

/** @param {string} [out] */
function done(out) {
  if (out) process.stdout.write(out, () => process.exit(0));
  else process.exit(0);
}

function readStdin() {
  return new Promise((resolve) => {
    let buf = '';
    if (process.stdin.isTTY) return resolve('');
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => { buf += d; });
    process.stdin.on('end', () => resolve(buf));
    process.stdin.on('error', () => resolve(''));
  });
}
