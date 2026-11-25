// Speech sanitizer (detailed design §5.1 step 5). Shared by every summarizer strategy:
// model output is never trusted to follow the speech rules, so it always passes through here.

const URL_RE = /\bhttps?:\/\/[^\s)>\]]+/gi;
const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const COMMIT_HASH_RE = /\b(commit(?:ted)?(?:\s+as)?\s+)([0-9a-f]{7,40})\b/gi;
const HEX_RE = /\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,64}\b/gi;
const BIG_NUMBER_RE = /\b\d{7,}\b/g;
// A path: starts with / ./ ../ ~/, or has 2+ slashes, or ends in a file extension.
const PATH_RE = /(?:~|\.{1,2})?\/?(?:[\w@.+-]+\/)+[\w@.+-]*|\b[\w@+-]+\/[\w@+-]+\.[A-Za-z0-9]{1,6}\b/g;
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
    const looksLikePath = /^[~./]/.test(m) || slashes >= 2 || /\.[A-Za-z0-9]{1,6}$/.test(m);
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
  t = t.replace(new RegExp(String.raw`\bIDs?\s+(?=${UUID_RE.source})`, 'gi'), '');   // "ID <uuid>" → "an ID"
  t = t.replace(UUID_RE, 'an ID');
  // "commit 3f9a2bc" → "a commit"; "committed 3f9a2bc" / "committed as 3f9a2bc" → "committed"
  t = t.replace(COMMIT_HASH_RE, (_m, lead) => (/^committed/i.test(lead) ? lead.split(/\s/)[0] : 'a commit'));
  t = t.replace(new RegExp(String.raw`\bIDs?\s+(?=${HEX_RE.source})`, 'gi'), '');
  t = t.replace(HEX_RE, 'an ID');
  t = t.replace(PATH_RE, pathReplacer());
  t = t.replace(BIG_NUMBER_RE, (n) => roughly(Number(n)));
  t = expandAbbreviations(t);
  t = t.replace(EMOJI_RE, '');
  t = t.replace(/\*\*|__|[*`#~|]/g, '');
  t = t.replace(/(\w)_(\w)/g, '$1 $2');
  t = t.replace(/\s+/g, ' ').replace(/\s+([.,!?;:])/g, '$1').replace(/([.!?]){2,}/g, '$1');
  return t.trim();
}
