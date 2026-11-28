// Rules summarizer (detailed design §5.1). Deterministic, local, no network.
import { sanitize, expandAbbreviations } from './sanitize.mjs';

/** @typedef {'alerts'|'brief'|'chatty'} Mode */

const LIMITS = /** @type {const} */ ({
  brief: { sentences: 2, words: 30, outcomes: 1 },
  chatty: { sentences: 4, words: 60, outcomes: 2 },
});
const QUESTION_TO_USER = /\b(you|your|want me|should i|shall i|would you|do you|can i|ok to|okay to)\b/i;
const ACTION_START = /^(?:i\s+(?:have\s+|also\s+|just\s+)?|i've\s+|we\s+|and\s+)?(added|fixed|updated|created|removed|ran|deployed|implemented|wrote|merged|refactored|renamed|moved|installed|changed|built|committed|pushed|deleted|replaced|reverted|upgraded|migrated|configured|enabled|disabled|resolved|cleaned|split|extracted|finished|completed|published|released|opened|closed|switched|raised|lowered|bumped|cut|reduced|rewrote|restarted|rotated|patched|wired|split)\b/i;
const RESULT = /\b(pass(?:es|ed|ing)?|fail(?:s|ed|ing|ures?)?|errors?|green|red|succeed(?:s|ed)?|successful(?:ly)?|broken|builds? (?:cleanly|fine))\b/i;
const PROPOSAL = /^(?:next,?\s+|then,?\s+)?(?:i could|i can|i'd suggest|i would suggest|we could|one option is)\b/i;
const DEICTIC = /^(?:go ahead|proceed|continue|ok|okay|sound good|sounds good|all right|alright|is that ok(?:ay)?|does that work|which (?:do you prefer|would you prefer|works))\b/i;
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
  t = t.replace(/(\*\*|__)(?=\S)([^\n]*?\S)\1/g, '$2');                            // **bold**, __bold__
  t = t.replace(/(^|[^\w*])\*(?=\S)([^*\n]*?\S)\*(?!\w)/g, '$1$2');                  // *italic*
  t = t.replace(/(^|[^\w])_(?=\S)([^_\n]*?\S)_(?!\w)/g, '$1$2');                    // _italic_ (not snake_case)
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

/** More than 30% of the non-space characters are neither letters nor digits. */
function mostlySymbols(s) {
  const chars = s.replace(/\s/g, '');
  if (!chars) return true;
  const letters = (chars.match(/[\p{L}\p{N}]/gu) ?? []).length;   // digits are words too ("2.4.0")
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
export function truncate(sentence, max) {
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

  // Step 3: the question addressed to the user. A message that ends on a question is asking
  // the user ("Deploy now?", "Before I start: should this cover…?"); otherwise the last
  // question with a you/should-I shape.
  let qIndex = sentences.length && sentences[sentences.length - 1].endsWith('?') ? sentences.length - 1 : -1;
  for (let i = sentences.length - 1; qIndex < 0 && i >= 0; i--) {
    if (sentences[i].endsWith('?') && QUESTION_TO_USER.test(sentences[i])) qIndex = i;
  }
  // "Do you want X? And should Y?": one question in two sentences.
  const pair = qIndex > 0 && /^(?:and|also|or|plus)\b/i.test(sentences[qIndex]) && sentences[qIndex - 1].endsWith('?')
    && words(sentences[qIndex - 1]).length + words(sentences[qIndex]).length <= 20;
  const question = qIndex >= 0 ? sanitize(pair ? `${sentences[qIndex - 1]} ${sentences[qIndex]}` : sentences[qIndex]) : '';

  // Chatty keeps a proposal right before the question ("Next I could add retries. Want me to?").
  const pIndex = mode === 'chatty' && qIndex > 0 && PROPOSAL.test(sentences[qIndex - 1]) ? qIndex - 1 : -1;

  // A question that points back at the sentence before it ("Go ahead?", "Which do you
  // prefer?" after the options) needs that sentence as its outcome.
  const qWords = qIndex >= 0 ? words(sentences[qIndex]).length : 0;
  const leans = !pair && qIndex > 0 && !sentences[qIndex - 1].endsWith('?') && (
    DEICTIC.test(sentences[qIndex]) || qWords <= 3
    || (/^which\b/i.test(sentences[qIndex]) && /,? or\b/i.test(sentences[qIndex - 1])));
  const cIndex = leans && pIndex < 0 ? qIndex - 1 : -1;

  // Step 4: rank the rest, keep the best in original order.
  const statements = sentences.map((s, i) => ({ s, i })).filter((x) => x.i !== qIndex && x.i !== pIndex && x.i !== cIndex && !x.s.endsWith('?'));
  // (the first half of a question pair ends in "?", so it is already excluded above)
  const firstIndex = statements[0]?.i ?? -1;
  const ranked = statements
    .map((x) => ({ ...x, n: score(x.s, x.i === firstIndex) }))
    .sort((a, b) => b.n - a.n || a.i - b.i)
    .slice(0, limits.outcomes)
    .sort((a, b) => a.i - b.i)
    .map((x) => sanitize(x.s))
    .filter(Boolean);
  if (cIndex >= 0) {
    // The leaning sentence takes the last outcome slot, right before the question.
    if (ranked.length >= limits.outcomes) ranked.pop();
    ranked.push(sanitize(sentences[cIndex]));
  }
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

/**
 * Hold text from another summarizer to the same budget as the rules strategy: sanitize each
 * sentence, keep the question if there is one, and cut to the mode's sentence and word limits.
 * @param {string} text @param {Mode} [mode]
 * @returns {string}
 */
export function clamp(text, mode = 'brief') {
  if (mode === 'alerts') return '';
  const limits = LIMITS[mode] ?? LIMITS.brief;
  const sentences = splitSentences(stripMarkdown(text)).map(sanitize).filter(Boolean);
  const qi = sentences.findLastIndex((s) => s.endsWith('?'));
  const question = qi >= 0 ? truncate(sentences[qi], Math.min(20, limits.words)) : '';
  // Over the sentence limit: keep the opening sentences and the one the question leans on
  // ("Next I could add retries. Want me to?").
  let body = sentences.filter((_, i) => i !== qi);
  const room = limits.sentences - (question ? 1 : 0);
  if (question && body.length > room && qi > 0 && room >= 2) {
    body = [...body.slice(0, room - 1), sentences[qi - 1]];
  }
  let budget = limits.words - words(question).length;
  const parts = [];
  for (const s of body) {
    if (parts.length >= room || budget < 4) break;
    const t = truncate(s, budget);
    parts.push(t);
    budget -= words(t).length;
  }
  if (question) parts.push(question);
  return parts.join(' ').trim();
}
