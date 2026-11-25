import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Broker, describe, isProtected, DEFAULT_NEVER_BY_VOICE } from '../src/daemon/broker.mjs';
import { SpeechQueue } from '../src/daemon/queue.mjs';
import { instantEngine, tick } from './helpers.mjs';

const SETTINGS = { voiceApproval: true, answerTimeoutMs: 20_000, minConfidence: 0.6, neverByVoice: [], multiSession: false };
const REQ = { session: 's1', cwd: '/w/api', tool_name: 'Write', tool_input: { file_path: '/w/api/probe.txt', content: 'hi' } };

/** Listener double: resolves with `answer` after `delayMs`, or when aborted, whichever is first. */
function fakeListener(answer, delayMs = 5, { ready = true } = {}) {
  const calls = [];
  return {
    calls,
    async ready() { return ready; },
    listen(opts) {
      calls.push(opts);
      return new Promise((resolve) => {
        const t = setTimeout(() => resolve(answer ? { answer, heard: answer, confidence: 0.9 } : null), delayMs);
        opts.signal?.addEventListener('abort', () => { clearTimeout(t); resolve(null); }, { once: true });
      });
    },
  };
}

function setup(listener) {
  const engine = instantEngine();
  const queue = new SpeechQueue({ engine });
  const tones = [];
  const broker = new Broker({ queue, listener, tone: (k) => tones.push(k) });
  return { engine, broker, tones };
}

test('voice allow → allow, with tone, after the prompt is spoken', async () => {
  const { engine, broker, tones } = setup(fakeListener('allow'));
  const r = await broker.ask(REQ, SETTINGS, new AbortController().signal);
  assert.deepEqual(r, { decision: 'allow', reason: 'voice' });
  assert.deepEqual(tones, ['allow']);
  assert.equal(engine.spoken[0], 'Claude wants to edit probe.txt. Say yes or no, or answer on screen.');
});

test('voice deny → deny', async () => {
  const { broker, tones } = setup(fakeListener('deny'));
  assert.equal((await broker.ask(REQ, SETTINGS, new AbortController().signal)).decision, 'deny');
  assert.deepEqual(tones, ['deny']);
});

test('defer, silence/timeout → no decision', async () => {
  for (const answer of ['defer', null]) {
    const { broker, tones } = setup(fakeListener(answer));
    assert.equal((await broker.ask(REQ, SETTINGS, new AbortController().signal)).decision, null);
    assert.deepEqual(tones, []);
  }
});

test('M0 race: answered on screen (connection closed) → a late voice allow is never applied', async () => {
  // The listener would hear "allow" at 200 ms; the user answers on screen at 50 ms.
  const listener = { async ready() { return true; },
    listen: () => new Promise((r) => setTimeout(() => r({ answer: 'allow', heard: 'allow', confidence: 0.99 }), 200)) };
  const { broker, tones } = setup(listener);
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 50);
  const r = await broker.ask(REQ, SETTINGS, ac.signal);
  assert.deepEqual(r, { decision: null, reason: 'cancelled' });
  assert.deepEqual(tones, []);
});

test('closing the connection while the prompt is still speaking stops the speech', async () => {
  const plays = [];
  const engine = { speak(text) { const p = { text, cancelled: false }; plays.push(p);
    return { done: new Promise((r) => { p.end = r; }), cancel() { p.cancelled = true; p.end(); } }; } };
  const broker = new Broker({ queue: new SpeechQueue({ engine }), listener: fakeListener('allow') });
  const ac = new AbortController();
  const pending = broker.ask(REQ, SETTINGS, ac.signal);
  await tick(5);
  ac.abort();
  assert.deepEqual(await pending, { decision: null, reason: 'cancelled' });
  assert.equal(plays[0].cancelled, true);
});

test('protected commands are announced and never voice-approved', async () => {
  const listener = fakeListener('allow');
  const { engine, broker } = setup(listener);
  const r = await broker.ask({ ...REQ, tool_name: 'Bash', tool_input: { command: 'sudo rm -rf /tmp/x' } }, SETTINGS, new AbortController().signal);
  assert.deepEqual(r, { decision: null, reason: 'protected' });
  assert.equal(listener.calls.length, 0);
  await tick(5);
  assert.match(engine.spoken[0], /protected command/);
});

test('voice_approval=false and a missing listener only announce', async () => {
  let s = setup(fakeListener('allow'));
  assert.equal((await s.broker.ask(REQ, { ...SETTINGS, voiceApproval: false }, new AbortController().signal)).reason, 'announce-only');
  s = setup(fakeListener('allow', 5, { ready: false }));
  assert.equal((await s.broker.ask(REQ, SETTINGS, new AbortController().signal)).reason, 'listener-unavailable');
  s = setup(null);
  assert.equal((await s.broker.ask(REQ, SETTINGS, new AbortController().signal)).decision, null);
});

test('only one open request: a second one gets no decision at once (T6)', async () => {
  const { broker } = setup(fakeListener('allow', 100));
  const first = broker.ask(REQ, SETTINGS, new AbortController().signal);
  await tick(1);
  assert.deepEqual(await broker.ask({ ...REQ, session: 's2' }, SETTINGS, new AbortController().signal), { decision: null, reason: 'busy' });
  assert.equal((await first).decision, 'allow');
});

test('handled() covers the open request and the following 30 s (FR-11)', async () => {
  let now = 0;
  const broker = new Broker({ queue: new SpeechQueue({ engine: instantEngine(), now: () => now }), listener: fakeListener(null), now: () => now });
  await broker.ask(REQ, SETTINGS, new AbortController().signal);
  assert.ok(broker.handled('s1'));
  now = 31_000;
  assert.ok(!broker.handled('s1'));
});

test('describe() speaks at most 8 raw words and never paraphrases', () => {
  assert.equal(describe('Bash', { command: 'npm test -- --watch=false --coverage a b c d e' }), 'Claude wants to run npm test -- --watch=false --coverage a b c.');
  assert.equal(describe('Edit', { file_path: '/a/b/c.ts' }), 'Claude wants to edit c.ts.');
  assert.equal(describe('WebFetch', { url: 'https://docs.example.com/x' }), 'Claude wants to open docs.example.com.');
  assert.equal(describe('mcp__claude_ai_Claude_Docs__update', {}), 'Claude wants to use claude ai Claude Docs update.');
  assert.equal(describe('Bash', { command: 'echo hi\nrm -rf /' }), 'Claude wants to run echo hi.');
});

test('never_by_voice defaults catch the dangerous ones', () => {
  for (const c of ['rm -rf build', 'rm -fr x', 'git push origin main --force', 'git push -f origin', 'git reset --hard HEAD~1',
    'sudo make install', 'psql -c "DROP TABLE users"', 'terraform apply', 'kubectl delete pod x', 'gcloud run services delete api']) {
    assert.ok(isProtected({ command: c }, DEFAULT_NEVER_BY_VOICE), c);
  }
  for (const c of ['npm test', 'git push origin main', 'rm build.log', 'ls -rf']) {
    assert.ok(!isProtected({ command: c }, DEFAULT_NEVER_BY_VOICE), c);
  }
});
