// Rules summarizer (detailed design §5.1). Deterministic, local, no network.
import { sanitize, expandAbbreviations } from './sanitize.mjs';

/** @typedef {'alerts'|'brief'|'chatty'} Mode */

const LIMITS = /** @type {const} */ ({
  brief: { sentences: 2, words: 30, outcomes: 1 },
  chatty: { sentences: 4, words: 60, outcomes: 2 },
});
const QUESTION_TO_USER = /\b(you|your|want me|should i|shall i|would you|do you|can i|ok to|okay to)\b/i;
const ACTION_START = /^(?:i\s+(?:have\s+|also\s+|just\s+)?|i've\s+|we\s+|and\s+)?(added|fixed|updated|created|removed|ran|deployed|implemented|wrote|merged|refactored|renamed|moved|installed|changed|built|committed|pushed|deleted|replaced|reverted|upgraded|migrated|configured|enabled|disabled|resolved|cleaned|split|extracted|finished|completed|published|released|opened|closed)\b/i;
const RESULT = /\b(pass(?:es|ed|ing)?|fail(?:s|ed|ing|ures?)?|errors?|green|red|succeed(?:s|ed)?|broken|builds? (?:cleanly|fine))\b/i;
const PROPOSAL = /^(?:next,?\s+|then,?\s+)?(?:i could|i can|i'd suggest|i would suggest|we could|one option is)\b/i;
const HEDGE = /^(let me|let's|i'll now|i will now|i'll|i will|here's|here is|now i|next,? i|first,? i|okay,? |ok,? |sure,? |great,? )/i;

/**
 * Strip markdown that should never be spoken, and return plain lines (one block per line).
 * @param {string} md @returns {string[]}
 */
export function stripMarkdown(md) {
  let t = String(md ?? '').replace(/\r\n?/g, '\n');
  t = t.replace(/(^|\n)(```|~~~)[^\n]*\n[\s\S]*?(\n\2[^\n]*(?=\n|$)|$)/g, '\n');   // fenced code
  t = t.replace(/<!--[\s\S]*?-->/g, ' ').replace(/<\/?[a-z][^>]*>/gi, ' ');      // HTML
  t = t.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ');                                    // images
  t = t.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');                                  // links → text
  // Inline code: keep short spans and paths (the sanitizer shortens paths); drop long code.
  t = t.replace(/`([^`\n]*)`/g, (_m, c) => (c.length <= 24 || /^[~./\w@+-]+\/[\w@./+-]+$/.test(c) ? c : 'the code'));
  const lines = [];
  for (const raw of t.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (/^\|/.test(line) || /^[-:|\s]+$/.test(line)) continue;                    // tables, rules
    if (/^>/.test(line)) continue;                                               // block quotes
    if (/^#{1,6}\s/.test(line)) continue;                                        // headings
    const item = line.replace(/^(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/, '');       // list markers
    lines.push(item);
  }
  return lines;
}

/** @param {string[]} lines @returns {string[]} */
export function splitSentences(lines) {
  const out = [];
  for (const line of lines) {
    const withStop = /[.!?:]$/.test(line) ? line : `${line}.`;
    const text = expandAbbreviations(withStop).replace(/:$/, '.');
    for (const s of text.split(/(?<=[.!?])\s+(?=["'(]?[A-Z0-9])/)) {
      const trimmed = s.trim();
      if (trimmed) out.push(trimmed);
    }
  }
  return out.filter((s) => !mostlySymbols(s));
}

/** More than 30% of the non-space characters are not letters. */
function mostlySymbols(s) {
  const chars = s.replace(/\s/g, '');
  if (!chars) return true;
  const letters = (chars.match(/\p{L}/gu) ?? []).length;
  return (chars.length - letters) / chars.length > 0.3;
}

/** @param {string} s @param {boolean} first the first statement (questions don't count) */
function score(s, first) {
  let n = 0;
  if (ACTION_START.test(s)) n += 3;
  if (RESULT.test(s)) n += 3;
  if (first) n += 2;
  if (HEDGE.test(s)) n -= 2;
  if (words(s).length <= 3) n -= 2;       // "It passed." loses to the sentence that explains it
  return n;
}

const words = (s) => s.split(/\s+/).filter(Boolean);

/** Cut a sentence to at most `max` words, at a clause boundary when one is close. */
function truncate(sentence, max) {
  const w = words(sentence);
  if (w.length <= max) return sentence;
  const end = sentence.endsWith('?') ? '?' : '.';
  const head = w.slice(0, max).join(' ');
  const cut = Math.max(head.lastIndexOf(', '), head.lastIndexOf('; '), head.lastIndexOf(' — '));
  // A question keeps its first complete clause; a statement needs a cut past 40% to be worth it.
  const minCut = end === '?' ? 12 : head.length * 0.4;
  const body = cut >= minCut ? head.slice(0, cut) : head;
  return body.replace(/[\s,;:—-]+$/, '') + end;
}

/**
 * Summarize Claude's final message for speech.
 * @param {string} message  last_assistant_message
 * @param {{ mode?: Mode, elapsedMs?: number|null }} [opts]
 * @returns {string} text to speak, or '' for silence
 */
export function summarize(message, opts = {}) {
  const mode = opts.mode ?? 'brief';
  if (mode === 'alerts') return '';
  const limits = LIMITS[mode] ?? LIMITS.brief;
  const sentences = splitSentences(stripMarkdown(message));

  // Step 3: the last question addressed to the user.
  let qIndex = -1;
  for (let i = sentences.length - 1; i >= 0; i--) {
    if (sentences[i].endsWith('?') && QUESTION_TO_USER.test(sentences[i])) { qIndex = i; break; }
  }
  const question = qIndex >= 0 ? sanitize(sentences[qIndex]) : '';

  // Chatty keeps a proposal right before the question ("Next I could add retries. Want me to?").
  const pIndex = mode === 'chatty' && qIndex > 0 && PROPOSAL.test(sentences[qIndex - 1]) ? qIndex - 1 : -1;

  // Step 4: rank the rest, keep the best in original order.
  const statements = sentences.map((s, i) => ({ s, i })).filter((x) => x.i !== qIndex && x.i !== pIndex && !x.s.endsWith('?'));
  const firstIndex = statements[0]?.i ?? -1;
  const ranked = statements
    .map((x) => ({ ...x, n: score(x.s, x.i === firstIndex) }))
    .sort((a, b) => b.n - a.n || a.i - b.i)
    .slice(0, limits.outcomes)
    .sort((a, b) => a.i - b.i)
    .map((x) => sanitize(x.s))
    .filter(Boolean);
  if (pIndex >= 0) ranked.push(sanitize(sentences[pIndex]));

  // Step 6: compose under the sentence and word budget; the question has priority (FR-03).
  const qText = question ? truncate(question, Math.min(20, limits.words)) : '';
  let budget = limits.words - words(qText).length;
  const parts = [];
  for (const s of ranked) {
    if (parts.length + (qText ? 1 : 0) >= limits.sentences || budget < 4) break;
    const t = truncate(s, budget);
    parts.push(t);
    budget -= words(t).length;
  }
  if (qText) parts.push(qText);
  const out = parts.join(' ').trim();

  // Step 7: nothing worth saying.
  if (!out) return (opts.elapsedMs ?? 0) > 60_000 ? 'Claude finished.' : '';
  return out;
}
