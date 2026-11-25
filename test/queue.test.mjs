import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SpeechQueue } from '../src/daemon/queue.mjs';
import { manualEngine, tick } from './helpers.mjs';

const q = (engine, now = () => 0) => new SpeechQueue({ engine, now });

test('plays in priority order: permission > alert > turn > system', async () => {
  const e = manualEngine(); const queue = q(e);
  queue.enqueue({ session: 's', kind: 'system', text: 'system' });     // starts playing at once
  queue.enqueue({ session: 's', kind: 'turn', text: 'turn' });
  queue.enqueue({ session: 's', kind: 'alert', text: 'alert' });
  for (let i = 0; i < 3; i++) { e.finishCurrent(); await tick(); }
  assert.deepEqual(e.plays.map((p) => p.text), ['system', 'alert', 'turn']);
});

test('newest turn wins: replaces a playing turn and drops queued ones', async () => {
  const e = manualEngine(); const queue = q(e);
  const a = queue.enqueue({ session: 's', kind: 'turn', text: 'first' });
  const b = queue.enqueue({ session: 's', kind: 'turn', text: 'second' });
  assert.equal(await a.outcome, 'stopped');
  e.finishCurrent();
  assert.equal(await b.outcome, 'played');
  assert.deepEqual(e.plays.map((p) => [p.text, p.cancelled]), [['first', true], ['second', false]]);
});

test('permission interrupts a turn and is never deduped', async () => {
  const e = manualEngine(); const queue = q(e);
  const t = queue.enqueue({ session: 's', kind: 'turn', text: 'long turn' });
  const p1 = queue.enqueue({ session: 's', kind: 'permission', text: 'Allow?' });
  assert.equal(await t.outcome, 'stopped');
  e.finishCurrent(); assert.equal(await p1.outcome, 'played');
  const p2 = queue.enqueue({ session: 's', kind: 'permission', text: 'Allow?' });
  e.finishCurrent(); assert.equal(await p2.outcome, 'played');
});

test('identical text within 60 s is dropped; after 60 s or with force it plays', async () => {
  let now = 0; const e = manualEngine(); const queue = q(e, () => now);
  queue.enqueue({ session: 's', kind: 'alert', text: 'Claude is waiting.' }); e.finishCurrent(); await tick();
  assert.equal(await queue.enqueue({ session: 's', kind: 'alert', text: 'claude is WAITING' }).outcome, 'dropped');
  const forced = queue.enqueue({ session: 's', kind: 'system', text: 'Claude is waiting.', force: true });
  e.finishCurrent(); assert.equal(await forced.outcome, 'played');
  now = 61_000;
  const later = queue.enqueue({ session: 's', kind: 'alert', text: 'Claude is waiting.' });
  e.finishCurrent(); assert.equal(await later.outcome, 'played');
});

test('stop (barge-in) kills playback and clears all but permission', async () => {
  const e = manualEngine(); const queue = q(e);
  const cur = queue.enqueue({ session: 's', kind: 'alert', text: 'alert' });
  const turn = queue.enqueue({ session: 's', kind: 'turn', text: 'turn' });
  queue.stop();
  assert.equal(await cur.outcome, 'stopped');
  assert.equal(await turn.outcome, 'stopped');
  assert.equal(e.plays[0].cancelled, true);
  assert.equal(queue.busy, false);
});

test('cancel(id) removes a queued or playing item', async () => {
  const e = manualEngine(); const queue = q(e);
  const a = queue.enqueue({ session: 's', kind: 'alert', text: 'a' });
  const b = queue.enqueue({ session: 's', kind: 'alert', text: 'b' });
  queue.cancel(b.id); assert.equal(await b.outcome, 'stopped');
  queue.cancel(a.id); assert.equal(await a.outcome, 'stopped');
  assert.equal(queue.busy, false);
});

test('engine failure resolves failed and the queue keeps going', async () => {
  let n = 0;
  const engine = { speak(text) { n++; return { done: n === 1 ? Promise.reject(new Error('boom')) : Promise.resolve(), cancel() {} }; } };
  const queue = q(engine);
  const a = queue.enqueue({ session: 's', kind: 'alert', text: 'a' });
  const b = queue.enqueue({ session: 's', kind: 'alert', text: 'b' });
  assert.equal(await a.outcome, 'failed');
  assert.equal(await b.outcome, 'played');
});
