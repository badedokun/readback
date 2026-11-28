// listen() with a fake microphone and a fake whisper-cli: segmentation, matching and the
// "allow" settle check, without audio hardware.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const here = fileURLToPath(new URL('.', import.meta.url));
process.env.PATH = `${join(here, 'fakes', 'bin')}:${process.env.PATH}`;
process.env.READBACK_CAPTURE_CMD = join(here, 'fakes', 'capture.mjs');
process.env.READBACK_MODEL = join(here, 'fakes', 'no-model.bin');
const { Listener, MODELS } = await import('../src/daemon/listener/index.mjs');

/** @param {string} capture @param {string} whisper */
async function hear(capture, whisper, timeoutMs = 4000, opts = {}) {
  process.env.FAKE_CAPTURE = capture;
  process.env.FAKE_WHISPER = whisper;
  const heard = [];
  const t0 = Date.now();
  const l = new Listener();
  if (opts.model) l.model = opts.model;
  const r = await l.listen({ timeoutMs, minConfidence: opts.minConfidence ?? 0.6, onHeard: (h) => heard.push(h.heard) });
  return { answer: r?.answer ?? null, heard, ms: Date.now() - t0 };
}

test('listener: "yes" followed by quiet is an allow', async () => {
  const r = await hear('gap:200,tone:400', 'Yes.');
  assert.equal(r.answer, 'allow');
  assert.ok(r.ms < 3000, `took ${r.ms} ms`);
});

test('listener: "yes … but wait" is never an allow (speech right after "yes" fails closed)', async () => {
  const r = await hear('gap:200,tone:400,gap:700,tone:400', 'Yes.|But wait.', 3500);
  assert.equal(r.answer, null);
  assert.deepEqual(r.heard, ['Yes.', 'But wait.']);
});

test('listener: "no" is accepted at once, without the settle wait', async () => {
  const r = await hear('gap:200,tone:400,gap:700,tone:400', 'No.|Yes.');
  assert.equal(r.answer, 'deny');
});

test('listener: unclear speech then the deadline → no answer', async () => {
  const r = await hear('gap:200,tone:400', 'Hello.', 2000);
  assert.equal(r.answer, null);
  assert.ok(r.ms < 3000);
});

test('listener: unclear speech, then "yes" in the same window → never an allow', async () => {
  const r = await hear('gap:200,tone:600,gap:700,tone:300', 'Yeah, build this green.|Yes.', 6000);
  assert.equal(r.answer, null);
  assert.deepEqual(r.heard, ['Yeah, build this green.', 'Yes.']);
});

test('listener: deny and defer accept a less certain hearing than allow', async () => {
  assert.equal((await hear('gap:200,tone:400', 'No.@0.45')).answer, 'deny');
  assert.equal((await hear('gap:200,tone:400', 'Wait.@0.45')).answer, 'defer');
  assert.equal((await hear('gap:200,tone:400', 'Yes.@0.45', 2500)).answer, null);
});

test('listener: confidence 0 (the default) uses the model\'s own bar: 0.5 for base.en, 0.6 for tiny.en', async () => {
  assert.equal((await hear('gap:200,tone:400', 'Yes.@0.55', 2500, { minConfidence: 0, model: MODELS['base.en'] })).answer, 'allow');
  assert.equal((await hear('gap:200,tone:400', 'Yes.@0.55', 2500, { minConfidence: 0, model: MODELS['tiny.en'] })).answer, null);
});
