// TC-50 / NFR-06: with default settings the shim and daemon make no network connections.
// The one exception is the pinned model download when voice approval is first enabled with
// sox and whisper-cli installed (security §5): it goes only to the pinned URL.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MODEL } from '../src/daemon/listener/index.mjs';
import { which } from '../src/daemon/util.mjs';

const ROOT = new URL('..', import.meta.url).pathname;
const SHIM = join(ROOT, 'bin', 'readback-hook.mjs');
const GUARD = join(ROOT, 'test', 'fakes', 'no-network.mjs');
const fixture = (n) => readFileSync(join(ROOT, 'test', 'contract', 'fixtures', `${n}.json`), 'utf8');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const dirs = [];
const locks = [];
after(() => {
  for (const l of locks) { try { process.kill(Number(readFileSync(l, 'utf8')), 'SIGTERM'); } catch { /* gone */ } }
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function shim(event, payload, env) {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [SHIM, event], { env: { ...process.env, ...env } });
    let out = '';
    c.stdout.on('data', (d) => { out += d; });
    c.on('exit', () => resolve(out));
    c.stdin.end(payload);
  });
}

/** A whole session through the real shim and daemon, under the network guard. */
async function session(setup) {
  const d = mkdtempSync(join(tmpdir(), 'rbn-'));
  dirs.push(d);
  const env = {
    READBACK_SOCKET: join(d, 'rb.sock'), READBACK_DATA_DIR: join(d, 'data'), READBACK_CONFIG: join(d, 'config.toml'),
    READBACK_ENGINE: `record:${join(d, 'spoken.jsonl')}:10`, READBACK_IDLE_EXIT_MS: '4000',
    READBACK_NETLOG: join(d, 'net.log'), NODE_OPTIONS: `--import ${GUARD}`,
    READBACK_MODEL: '',   // the default model location in the data dir, as for a real user
  };
  locks.push(join(d, 'rb.lock'));
  writeFileSync(env.READBACK_CONFIG, 'min_turn_seconds = 0\n');   // the scripted turn is instant
  setup?.(d, env);
  await shim('session-start', fixture('session-start'), env);
  await shim('prompt', fixture('prompt-plain'), env);
  await shim('stop', fixture('stop'), env);
  await shim('notification', fixture('notification-idle'), env);
  await shim('permission', fixture('permission-write'), env);
  await shim('prompt', fixture('prompt-mode'), env);
  await shim('session-end', fixture('session-end'), env);
  await wait(300);
  const net = existsSync(env.READBACK_NETLOG) ? readFileSync(env.READBACK_NETLOG, 'utf8').trim().split('\n').filter(Boolean) : [];
  const spoke = existsSync(join(d, 'spoken.jsonl'));
  return { net, spoke };
}

test('guard works: a TCP connection from a guarded process is recorded', async () => {
  const d = mkdtempSync(join(tmpdir(), 'rbn-')); dirs.push(d);
  const logf = join(d, 'net.log');
  await new Promise((r) => spawn(process.execPath, ['-e', "require('node:net').connect(443, 'example.com').on('error', () => {})"],
    { env: { ...process.env, NODE_OPTIONS: `--import ${GUARD}`, READBACK_NETLOG: logf } }).on('exit', r));
  assert.match(readFileSync(logf, 'utf8'), /connect/);
});

test('default settings, model present: no network at all (TC-50)', async () => {
  const r = await session((d) => {
    mkdirSync(join(d, 'data', 'models'), { recursive: true });
    writeFileSync(join(d, 'data', 'models', MODEL.file), 'not really a model');
  });
  assert.ok(r.spoke, 'the session really ran');
  assert.deepEqual(r.net, []);
});

test('voice approval off, model missing: no network (no download)', async () => {
  const r = await session((d, env) => writeFileSync(env.READBACK_CONFIG, 'min_turn_seconds = 0\nvoice_approval = false\n'));
  assert.ok(r.spoke);
  assert.deepEqual(r.net, []);
});

const hasTools = Boolean(which('whisper-cli') && (which('rec') || which('parec')));
test('first enable with sox and whisper installed: only the pinned model URL is fetched', { skip: !hasTools && 'needs sox and whisper-cli' }, async () => {
  const r = await session();
  assert.deepEqual(r.net.map((l) => l.replace(/^\d+ /, '')), [`fetch ${MODEL.url}`]);
});
