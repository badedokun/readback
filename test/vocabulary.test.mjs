import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchAnswer } from '../src/daemon/listener/vocabulary.mjs';
import { parseWhisperJson } from '../src/daemon/listener/index.mjs';

test('exact phrases map to answers', () => {
  for (const [t, a] of [['Allow.', 'allow'], [' Yes, allow.', 'allow'], ['Go ahead!', 'allow'], ['No.', 'deny'],
    ["Don't.", 'deny'], ['Stop', 'deny'], ['Show me.', 'defer'], ['Hold on', 'defer']]) {
    assert.equal(matchAnswer(t), a, t);
  }
});

test('anything else is unclear (fail closed)', () => {
  for (const t of ['', 'Tonight.', 'yes please do it', 'allow everything forever', 'I allow', 'maybe', 'yes no', 'allow allow allow allow', 'Yes, 30.', 'yes 2', 'No 1']) {
    assert.equal(matchAnswer(t), null, JSON.stringify(t));
  }
});

test('parseWhisperJson averages word-token probability, ignoring special and punctuation tokens', () => {
  const json = JSON.stringify({ transcription: [{ text: ' Show me.', tokens: [
    { text: '[_BEG_]', p: 0.1 }, { text: ' Show', p: 0.8 }, { text: ' me', p: 0.6 }, { text: '.', p: 0.2 },
    { text: '<|endoftext|>', p: 0.99 }, { text: '[_TT_50]', p: 0.1 }] }] });
  const h = parseWhisperJson(json);
  assert.equal(h?.answer, 'defer');
  assert.ok(Math.abs((h?.confidence ?? 0) - 0.7) < 1e-9);
  assert.equal(parseWhisperJson(JSON.stringify({ transcription: [{ text: '[BLANK_AUDIO]', tokens: [] }] })), null);
  assert.equal(parseWhisperJson('not json'), null);
});
