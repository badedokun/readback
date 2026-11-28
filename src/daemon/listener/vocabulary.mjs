// Closed answer vocabulary (detailed design §8). Exact match only, 1–3 words.

/** @typedef {'allow'|'deny'|'defer'} Answer */

/** @type {Record<Answer, string[]>} */
export const VOCABULARY = {
  allow: ['allow', 'yes', 'approve', 'approved', 'yes allow', 'go ahead'],
  deny: ['deny', 'no', 'reject', "don't", 'stop'],
  defer: ['show me', 'wait', 'keyboard', 'hold on'],
};

/** Lowercase letters and single spaces only; apostrophes dropped ("don't" → "dont"). */
export function normalizeAnswer(text) {
  return String(text ?? '').toLowerCase().replace(/['’]/g, '').replace(/[^a-z]+/g, ' ').trim();
}

const TABLE = new Map();
for (const [answer, phrases] of Object.entries(VOCABULARY)) {
  for (const p of phrases) TABLE.set(normalizeAnswer(p), /** @type {Answer} */ (answer));
}

/**
 * @param {string} transcript
 * @returns {Answer|null} null = unclear (not 1–3 words, not an exact phrase, or has digits)
 */
export function matchAnswer(transcript) {
  // Digits are speech we did not ask for: "Yes, 30." must not become "yes".
  if (/\d/.test(String(transcript ?? ''))) return null;
  const norm = normalizeAnswer(transcript);
  const n = norm ? norm.split(' ').length : 0;
  if (n < 1 || n > 3) return null;
  return TABLE.get(norm) ?? null;
}
