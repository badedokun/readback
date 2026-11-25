// Contract tests: the real shim (bin/readback-hook.mjs) fed the payload shapes recorded in M0
// (scrubbed fixtures), against (a) a scripted fake daemon to pin the exact stdout contract and
// (b) the real daemon with the record engine for end-to-end flows.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const SHIM = join(ROOT, 'bin', 'readback-hook.mjs');
const fixture = (name) => readFileSync(join(ROOT, 'test', 'contract', 'fixtures', `${name}.json`), 'utf8');

/** Run the shim with a fixture on stdin. */
function runShim(event, payload, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SHIM, event], { env: { ...process.env, ...env } });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.on('exit', (code) => resolve({ code, out }));
    child.stdin.end(payload);
  });
}

/** A fake daemon that answers each request type with a scripted reply. */
function fakeDaemon(sock, replies) {
  const seen = [];
  const server = net.createServer((c) => {
    let buf = '';
    c.setEncoding('utf8');
    c.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const msg = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
        seen.push(msg);
        c.write(JSON.stringify({ id: msg.id, ok: true, ...(replies[msg.type] ?? {}) }) + '\n');
      }
    });
  });
  return new Promise((r) => server.listen(sock, () => r({ server, seen })));
}

const dirs = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'rbc-')); dirs.push(d); return d; };
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

test('permission: daemon allow → exact PermissionRequest allow output', async () => {
  const d = tmp(); const sock = join(d, 's.sock');
  const { server, seen } = await fakeDaemon(sock, { 'permission.ask': { decision: 'allow' } });
  const r = await runShim('permission', fixture('permission-write'), { READBACK_SOCKET: sock });
  server.close();
  assert.equal(r.code, 0);
  assert.deepEqual(JSON.parse(r.out), { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } });
  assert.equal(seen[0].tool_name, 'Write');
  assert.equal(seen[0].tool_input.file_path, '/work/api-server/probe.txt');
});

test('permission: daemon deny → deny with message; never updatedPermissions', async () => {
  const d = tmp(); const sock = join(d, 's.sock');
  const { server } = await fakeDaemon(sock, { 'permission.ask': { decision: 'deny' } });
  const r = await runShim('permission', fixture('permission-write'), { READBACK_SOCKET: sock });
  server.close();
  const out = JSON.parse(r.out);
  assert.deepEqual(out.hookSpecificOutput.decision, { behavior: 'deny', message: 'Denied by voice' });
  assert.ok(!('updatedPermissions' in out.hookSpecificOutput.decision));
});

test('permission: null decision, or no daemon → no output, exit 0 (fail closed)', async () => {
  const d = tmp(); const sock = join(d, 's.sock');
  const { server } = await fakeDaemon(sock, { 'permission.ask': { decision: null } });
  let r = await runShim('permission', fixture('permission-write'), { READBACK_SOCKET: sock });
  server.close();
  assert.deepEqual(r, { code: 0, out: '' });
  // No daemon, and the daemon cannot start (bad socket dir): still exit 0, no output.
  r = await runShim('permission', fixture('permission-write'), { READBACK_SOCKET: join(d, 'missing', 'x.sock') });
  assert.deepEqual(r, { code: 0, out: '' });
});

test('garbage stdin → exit 0, no output', async () => {
  for (const ev of ['permission', 'prompt', 'stop']) {
    assert.deepEqual(await runShim(ev, '{not json', { READBACK_SOCKET: '/nonexistent/x.sock' }), { code: 0, out: '' });
  }
});

test('prompt: /readback:* is blocked with suppressOriginalPrompt; plain prompts pass and send stop', async () => {
  const d = tmp(); const sock = join(d, 's.sock');
  const { server, seen } = await fakeDaemon(sock, { command: { message: 'speech stopped' } });
  const blocked = await runShim('prompt', fixture('prompt-stop'), { READBACK_SOCKET: sock });
  const plain = await runShim('prompt', fixture('prompt-plain'), { READBACK_SOCKET: sock });
  server.close();
  assert.deepEqual(JSON.parse(blocked.out), { decision: 'block', reason: 'readback: speech stopped', suppressOriginalPrompt: true });
  assert.equal(plain.out, '');
  assert.deepEqual(seen.map((m) => m.type), ['stop', 'command', 'stop']);
  assert.equal(seen[1].name, 'stop');
});

test('stop: forwards last_assistant_message, never the transcript; stop_hook_active is ignored', async () => {
  const d = tmp(); const sock = join(d, 's.sock');
  const { server, seen } = await fakeDaemon(sock, {});
  await runShim('stop', fixture('stop'), { READBACK_SOCKET: sock });
  await runShim('stop', fixture('stop-active'), { READBACK_SOCKET: sock });
  server.close();
  assert.equal(seen.length, 1);
  assert.equal(seen[0].type, 'speak.turn');
  assert.match(seen[0].text, /^I added a rate limiter/);
  assert.ok(!JSON.stringify(seen[0]).includes('transcript'));
});

// ---- end to end with the real daemon ------------------------------------------------------
let env; let spoken;
before(() => {
  const d = tmp();
  spoken = join(d, 'spoken.jsonl');
  env = {
    READBACK_SOCKET: join(d, 'rb.sock'), READBACK_DATA_DIR: join(d, 'data'), READBACK_CONFIG: join(d, 'config.toml'),
    READBACK_ENGINE: `record:${spoken}:20`, READBACK_MODEL: join(d, 'no-model.bin'), READBACK_IDLE_EXIT_MS: '5000',
  };
});
after(() => { try { process.kill(Number(readFileSync(env.READBACK_SOCKET.replace(/\.sock$/, '.lock'), 'utf8')), 'SIGTERM'); } catch { /* gone */ } });

const heard = () => (existsSync(spoken) ? readFileSync(spoken, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l).text) : []);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('e2e: session start spawns the daemon; a turn is summarized and spoken', async () => {
  await runShim('session-start', fixture('session-start'), env);
  await runShim('stop', fixture('stop'), env);
  await wait(200);
  assert.deepEqual(heard(), ['I added a rate limiter to rateLimit.ts. Want me to commit this?']);
});

test('e2e: idle alert names the project; /readback:status reports through the block reason', async () => {
  await runShim('notification', fixture('notification-idle'), env);
  const status = await runShim('prompt', fixture('prompt-mode'), env);
  await wait(150);
  assert.ok(heard().includes('Claude is waiting for you in api-server.'));
  assert.equal(JSON.parse(status.out).reason, 'readback: mode chatty');
});

test('e2e: permission without a listener announces and returns no decision; the later notification is not repeated', async () => {
  const before = heard().length;
  const r = await runShim('permission', fixture('permission-mcp'), env);
  await runShim('notification', fixture('notification-permission'), env);
  await wait(150);
  assert.deepEqual(r, { code: 0, out: '' });
  assert.deepEqual(heard().slice(before), ['Claude wants to use docs update. Please answer on screen.']);
});

test('e2e: protected command is never voice-approved', async () => {
  const before = heard().length;
  const r = await runShim('permission', fixture('permission-bash-protected'), env);
  await wait(150);
  assert.equal(r.out, '');
  assert.deepEqual(heard().slice(before), ['Claude wants to run a protected command. Please use the keyboard.']);
});

test('e2e: daemon socket is private (0600)', async () => {
  const { statSync } = await import('node:fs');
  assert.equal(statSync(env.READBACK_SOCKET).mode & 0o777, 0o600);
});

test('daemon: sessions whose Claude Code process exited are pruned', async () => {
  const { Daemon } = await import('../src/daemon/daemon.mjs');
  const { nullLogger } = await import('../src/shared/log.mjs');
  let now = 0;
  const d = new Daemon({ engine: null, listener: null, log: nullLogger(), now: () => now, loadConfig: () => ({}) });
  await d.handle({ type: 'hello', session: 'live', cwd: '/a', pid: 1001 }, new AbortController().signal);
  await d.handle({ type: 'hello', session: 'dead', cwd: '/b', pid: 1002 }, new AbortController().signal);
  await d.handle({ type: 'alert', session: 'nopid', cwd: '/c', kind: 'other' }, new AbortController().signal);
  d.prune(1000, (pid) => pid === 1001);
  assert.deepEqual([...d.sessions.keys()], ['live', 'nopid']);
  now = 2000;
  d.prune(1000, () => true);
  assert.deepEqual([...d.sessions.keys()], ['live']);
});
