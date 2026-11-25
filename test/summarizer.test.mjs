import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { summarize } from '../src/daemon/summarizer/rules.mjs';
import { sanitize } from '../src/daemon/summarizer/sanitize.mjs';
import { INPUTS } from './golden/inputs.mjs';

const CASES = JSON.parse(readFileSync(new URL('./golden/cases.json', import.meta.url), 'utf8'));
const LIMITS = { brief: { words: 30, sentences: 2 }, chatty: { words: 60, sentences: 4 }, alerts: { words: 0, sentences: 0 } };

test('golden corpus has at least 30 cases and matches inputs', () => {
  assert.ok(CASES.length >= 30);
  assert.deepEqual(CASES.map((c) => c.name), INPUTS.map(([n]) => n));
});

for (const [name, mode, input] of INPUTS) {
  const expected = CASES.find((c) => c.name === name).expected;
  test(`golden: ${name}`, () => {
    const out = summarize(input, { mode, elapsedMs: 30_000 });
    assert.equal(out, expected);
    // Invariants that hold for every utterance (test plan §3).
    const words = out ? out.split(/\s+/).length : 0;
    const sentences = out ? (out.match(/[.!?](\s|$)/g) ?? []).length : 0;
    assert.ok(words <= LIMITS[mode].words, `${words} words`);
    assert.ok(sentences <= LIMITS[mode].sentences, `${sentences} sentences`);
    assert.doesNotMatch(out, /https?:|`|\*\*|```|\||#/);
    assert.doesNotMatch(out, /\b[0-9a-f]{7,}\b/i, 'no hashes');
    assert.doesNotMatch(out, /\d{7,}/, 'no long numbers');
    assert.doesNotMatch(out, /\w\/\w+\//, 'no multi-segment paths');
    assert.doesNotMatch(out, /\p{Extended_Pictographic}/u, 'no emoji');
  });
}

test('question to the user is kept verbatim when 20 words or fewer (FR-03)', () => {
  const q = 'Should I also update the changelog for this release?';
  assert.ok(summarize(`I bumped the version to 2.4.0. ${q}`).endsWith(q));
});

test('silent turn becomes "Claude finished." only after 60 s (§5.1 step 7)', () => {
  assert.equal(summarize('```\ncode\n```', { elapsedMs: 30_000 }), '');
  assert.equal(summarize('```\ncode\n```', { elapsedMs: 61_000 }), 'Claude finished.');
});

test('sanitize: paths, urls, hashes, numbers', () => {
  assert.equal(sanitize('Edited src/a/b/login.ts.'), 'Edited login.ts.');
  assert.equal(sanitize('See https://x.dev/a?b=1 now'), 'See a link now');
  assert.equal(sanitize('commit 3f9a2bc1 is on main'), 'a commit is on main');
  assert.equal(sanitize('Committed as 3f9a2bc1.'), 'Committed.');
  assert.equal(sanitize('It has 2500000000 rows'), 'It has about 3 billion rows');
  assert.equal(sanitize('and/or'), 'and or');
  assert.equal(sanitize('x.ts, y.ts, a/b.ts, c/d.ts, e/f.ts'), 'x.ts, y.ts, b.ts, d.ts, another file');
});
