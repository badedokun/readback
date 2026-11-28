// Speech sanitizer (detailed design §5.1 step 5). Shared by every summarizer strategy:
// model output is never trusted to follow the speech rules, so it always passes through here.

const URL_RE = /\bhttps?:\/\/[^\s)>\]]*[^\s)>\].,;:!?]/gi;   // trailing punctuation is the sentence's
const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const COMMIT_HASH_RE = /\b(commit(?:ted)?(?:\s+as)?\s+)([0-9a-f]{7,40})\b/gi;
const HEX_RE = /\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,64}\b/gi;
const BIG_NUMBER_RE = /\b(?:\d{7,}|\d{1,3}(?:,\d{3}){2,})\b/g;   // 12345678 or 12,345,678
// A path: starts with / ./ ../ ~/, or has 2+ slashes, or ends in a file extension.
const PATH_RE = /(?:~|\.{1,2})?\/?(?:[\w@.+-]+\/)+[\w@.+-]*|\b[\w@+-]+\/[\w@+-]+\.[A-Za-z][A-Za-z0-9]{0,5}\b/g;
const ISO_DATE_RE = /\b(20\d{2}|19\d{2})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])\b/g;
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const EMOJI_RE = /[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}\u{FE0F}\u{200D}\u{20E3}]/gu;

const ABBREVIATIONS = [
  [/\be\.g\.,?/gi, 'for example'],
  [/\bi\.e\.,?/gi, 'that is'],
  [/\betc\./gi, 'and so on.'],
  [/\bvs\.?(?=\s)/gi, 'versus'],
  [/\s*(?:->|→|=>)\s*/g, ' to '],
  [/&/g, ' and '],
];

/** Expand abbreviations that would otherwise break sentence splitting or read badly. */
export function expandAbbreviations(text) {
  let t = text;
  for (const [re, rep] of ABBREVIATIONS) t = t.replace(re, rep);
  return t;
}

/** Replace a path with its basename, the first two times; after that, "another file". */
function pathReplacer() {
  let count = 0;
  return (match) => {
    const trail = /[.]+$/.exec(match)?.[0] ?? '';
    const m = trail ? match.slice(0, -trail.length) : match;
    // Leave plain words like "and/or" alone: require an extension, a leading /, ~ or ., or 2+ slashes.
    const slashes = (m.match(/\//g) ?? []).length;
    const looksLikePath = /^[~./]/.test(m) || slashes >= 2 || /\.[A-Za-z][A-Za-z0-9]{0,5}$/.test(m);
    if (!looksLikePath) return m.replace(/\//g, ' ') + trail;
    count += 1;
    if (count > 2) return 'another file' + trail;
    const base = m.replace(/\/+$/, '').split('/').pop() ?? '';
    return (base || 'a folder') + trail;
  };
}

/** 12345678 → "about 12 million": never read a long digit string aloud. */
function roughly(n) {
  /** @type {Array<[number, string]>} */
  const units = [[1e12, 'trillion'], [1e9, 'billion'], [1e6, 'million']];
  for (const [size, word] of units) {
    if (n >= size) return `about ${Math.round(n / size)} ${word}`;
  }
  return 'a large number';
}

/** @param {string} text @returns {string} */
export function sanitize(text) {
  let t = String(text ?? '');
  t = t.replace(URL_RE, 'a link');
  t = t.replace(/:\s*a link\s*(?=[.!?]?$)/, '');                                  // "Opened PR 12: <url>" → "Opened PR 12"
  t = t.replace(new RegExp(String.raw`\bIDs?\s+(?=${UUID_RE.source})`, 'gi'), '');   // "ID <uuid>" → "an ID"
  t = t.replace(UUID_RE, 'an ID');
  // "commit 3f9a2bc" → "a commit"; "committed 3f9a2bc" / "committed as 3f9a2bc" → "committed"
  t = t.replace(/(\bcommit\w*\b[^.?!]*?)\s+as\s+[0-9a-f]{7,40}\b/gi, '$1');      // "Committed the fix as 4e1d9a7"
  t = t.replace(COMMIT_HASH_RE, (_m, lead) => (/^committed/i.test(lead) ? lead.split(/\s/)[0] : 'a commit'));
  t = t.replace(new RegExp(String.raw`\bIDs?\s+(?=${HEX_RE.source})`, 'gi'), '');
  t = t.replace(HEX_RE, 'an ID');
  t = t.replace(PATH_RE, pathReplacer());
  t = t.replace(/another file(?:(?:,\s*|\s+and\s+)another file)+/g, (m) => `${m.split('another file').length - 1} other files`);
  t = t.replace(/\b([\w-]+\.[A-Za-z][A-Za-z0-9]{0,5}):(\d+)(?::\d+)?\b/g, '$1 line $2');            // format.ts:42
  t = t.replace(ISO_DATE_RE, (_m, y, mo, d) => `${MONTHS[Number(mo) - 1]} ${Number(d)}, ${y}`);
  t = t.replace(BIG_NUMBER_RE, (n) => roughly(Number(n.replace(/,/g, ''))));
  t = t.replace(/\b(about|around|roughly|approximately|over|nearly|almost) about (?=\d)/gi, '$1 ');   // no "about about"
  t = t.replace(/\b(the|a|an|its|this|that) about (\d+ (?:million|billion|trillion))\b/gi, '$1 roughly $2');
  t = expandAbbreviations(t);
  t = t.replace(EMOJI_RE, '');
  t = t.replace(/\*\*|__|[*`#~|]/g, '');
  t = t.replace(/(\w)_(\w)/g, '$1 $2');
  // Close up space before punctuation, but not before a dotfile (".env", ".gitignore").
  t = t.replace(/\s+/g, ' ').replace(/\s+([.,!?;:])(?=\s|$)/g, '$1').replace(/([.!?]){2,}/g, '$1');
  return t.trim();
}
