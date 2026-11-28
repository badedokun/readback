import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { summarize } from '../src/daemon/summarizer/rules.mjs';
import { sanitize } from '../src/daemon/summarizer/sanitize.mjs';
import { INPUTS } from './golden/inputs.mjs';

const CASES = JSON.parse(readFileSync(new URL('./golden/cases.json', import.meta.url), 'utf8'));
const LIMITS = { brief: { words: 30, sentences: 2 }, chatty: { words: 60, sentences: 4 }, alerts: { words: 0, sentences: 0 } };

test('golden corpus has at least 100 cases and matches inputs', () => {
  assert.ok(CASES.length >= 100);
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

test('sanitizer M2 rules: dates, file lines, path runs, branches, dotfiles, numbers, links', () => {
  const cases = [
    ['Expires on 2027-01-14.', 'Expires on January 14, 2027.'],
    ['Fails in utils/format.ts:42.', 'Fails in format.ts line 42.'],
    ['Touched a/b/one.ts, a/b/two.ts, a/b/three.ts and a/b/four.ts.', 'Touched one.ts, two.ts, 2 other files.'],
    ['Kept release/2.3 for now.', 'Kept release 2.3 for now.'],
    ['Added .env.example and .gitignore.', 'Added .env.example and .gitignore.'],
    ['It has 48,213,906 rows.', 'It has about 48 million rows.'],
    ['About 3,000,000,000 calls.', 'About 3 billion calls.'],
    ['On the 12345678-row table.', 'On the roughly 12 million-row table.'],
    ['Opened PR 12: https://x.io/pr/12.', 'Opened PR 12.'],
    ['Committed the fix as 4e1d9a7 and pushed.', 'Committed the fix and pushed.'],
  ];
  for (const [input, want] of cases) assert.equal(sanitize(input), want, input);
});

test('rules M2: emphasis, final question, leaning question, question pair, digits', () => {
  assert.equal(summarize('**Done.** The **migration** ran **successfully**.'), 'The migration ran successfully.');
  assert.equal(summarize('Before I start: should this cover the portal too?'), 'Before I start: should this cover the portal too?');
  assert.equal(summarize('I can fix it by parsing the value first. Go ahead?'), 'I can fix it by parsing the value first. Go ahead?');
  assert.equal(summarize('Do you want archived projects? And should dates be UTC?'), 'Do you want archived projects? And should dates be UTC?');
  assert.equal(summarize('Version 2.4.0 is out.'), 'Version 2.4.0 is out.');
});
