// Voice-approval audio sets (test plan §4): phrases, speakers and acoustic conditions.
import { VOCABULARY } from '../../src/daemon/listener/vocabulary.mjs';

export const POSITIVE = Object.entries(VOCABULARY).flatMap(([answer, phrases]) => phrases.map((p) => ({ phrase: p, want: answer })));
export const NEGATIVE = [
  // Readback's own prompts (echo), and things people say near a laptop.
  'Claude wants to run npm test. Say yes or no, or answer on screen.',
  'Claude wants to edit login dot ts. Please answer on screen.',
  'The build is green and all tests pass.',
  'yes but wait', 'no idea', 'I don\'t know', 'yesterday', 'nobody', 'allowance', 'denial',
  'yeah', 'sure', 'okay', 'yes please do it', 'approve it later maybe',
  'show me the money', 'go ahead and wait a second', 'stop the music', 'can you say that again',
  'we should ship this on Friday', 'did you see the game last night', 'hello', 'thank you',
].map((p) => ({ phrase: p, want: /** @type {string|null} */ (null) }));
// Not in the vocabulary, but a real "no": hearing it as deny is fine, never as allow.
NEGATIVE.push({ phrase: 'nope', want: null, alsoOk: 'deny' });

export const SETS = {
  positive: { cases: POSITIVE, levels: ['near', 'mid', 'far'], noise: 0 },
  negative: { cases: NEGATIVE, levels: ['near'], noise: 0 },
  noise: { cases: [...POSITIVE, ...NEGATIVE.slice(3, 12)], levels: ['near'], noise: 0.03 },
};

/**
 * Speakers. `say`: macOS voices. `piper`: neural voices trained on recordings of real people,
 * with a fixed speaker id and pace. L2-ARCTIC speakers are non-native English (first language
 * in the name).
 * @type {{ id: string, engine: 'say'|'piper', voice: string, speaker?: number, pace?: number }[]}
 */
export const SPEAKERS = [
  ...['Samantha', 'Daniel', 'Karen', 'Moira', 'Fred'].map((v) => ({ id: `say-${v}`, engine: /** @type {const} */ ('say'), voice: v })),
  ...[['arabic-m', 21], ['arabic-f', 3], ['mandarin-m', 20], ['mandarin-f', 12], ['hindi-m', 10], ['hindi-f', 9],
    ['korean-m', 16], ['korean-f', 15], ['spanish-m', 22], ['spanish-f', 17], ['vietnamese-m', 8], ['vietnamese-f', 4]]
    .map(([id, s], i) => ({ id: `l2-${id}`, engine: /** @type {const} */ ('piper'), voice: 'en_US-l2arctic-medium', speaker: Number(s), pace: [0.9, 1, 1.1][i % 3] })),
  ...[0, 150, 300, 450, 600, 750].map((s, i) => ({ id: `libritts-${s}`, engine: /** @type {const} */ ('piper'), voice: 'en_US-libritts_r-medium', speaker: s, pace: [1.1, 0.95, 1][i % 3] })),
  { id: 'gb-scottish-f', engine: 'piper', voice: 'en_GB-alba-medium', pace: 1 },
  { id: 'gb-northern-m', engine: 'piper', voice: 'en_GB-northern_english_male-medium', pace: 0.95 },
  { id: 'gb-semaine-f', engine: 'piper', voice: 'en_GB-semaine-medium', speaker: 0, pace: 1.05 },
  { id: 'gb-semaine-m', engine: 'piper', voice: 'en_GB-semaine-medium', speaker: 2, pace: 1 },
  { id: 'us-ryan', engine: 'piper', voice: 'en_US-ryan-high', pace: 1.1 },
];

/** Distance, as sox effects on the clip: quieter, more room, less treble. */
export const LEVELS = {
  near: ['vol', '1.0'],
  mid: ['vol', '0.45', 'lowpass', '7000', 'reverb', '40', '50', '60'],
  far: ['vol', '0.2', 'lowpass', '4500', 'reverb', '70', '50', '90'],
};

/** One trial's result → is it right? @param {{ want: string|null, alsoOk?: string }} c @param {string|null} answer */
export const correct = (c, answer) => answer === c.want || (c.alsoOk !== undefined && answer === c.alsoOk);

/** Summary and release gates for a list of scored rows. */
export function summarize(rows) {
  const summary = {};
  for (const set of Object.keys(SETS)) {
    const r = rows.filter((x) => x.set === set);
    if (!r.length) continue;
    const ok = r.filter((x) => x.ok).length;
    summary[set] = {
      trials: r.length,
      correct: ok,
      accuracy: Math.round((ok / r.length) * 1000) / 10,
      false_allows: r.filter((x) => x.answer === 'allow' && x.want !== 'allow').length,
      false_denies: r.filter((x) => x.answer === 'deny' && x.want !== 'deny' && !x.ok).length,
      wrong_answer: r.filter((x) => x.want && x.answer && x.answer !== x.want).length,
    };
  }
  const gates = {
    positive: (s) => s.accuracy >= 95,
    negative: (s) => s.false_allows === 0 && s.false_denies <= Math.floor(s.trials * 0.01),
    noise: (s) => s.accuracy >= 90 && s.false_allows === 0,
  };
  for (const [set, s] of Object.entries(summary)) s.gate = gates[set](s) ? 'pass' : 'fail';
  return summary;
}
