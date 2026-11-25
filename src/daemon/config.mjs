// Configuration (detailed design §9). User file, then a restricted project override,
// then per-session settings from commands. Readback has no runtime npm dependencies, so this
// reads the small TOML subset the schema uses: `key = value` with strings, numbers,
// booleans and single-line string arrays.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { userConfigPath } from '../shared/paths.mjs';

/**
 * @typedef {{ mode: 'alerts'|'brief'|'chatty', engine: string, voice: string, rate: number,
 *   summarizer: 'rules'|'claude-haiku'|'off', min_turn_seconds: number, quiet_hours: string,
 *   voice_approval: boolean, answer_timeout: number, listener_confidence: number,
 *   never_by_voice: string[], debug: boolean }} Config
 */

/** @type {Readonly<Config>} */
export const DEFAULTS = Object.freeze({
  mode: 'brief',
  engine: 'auto',
  voice: '',
  rate: 190,
  summarizer: 'rules',
  min_turn_seconds: 10,
  quiet_hours: '',
  voice_approval: true,
  answer_timeout: 20,
  listener_confidence: 0.6,
  never_by_voice: [],
  debug: false,
});

const MODES = ['alerts', 'brief', 'chatty'];
const PROJECT_KEYS = new Set(['mode', 'voice_approval', 'never_by_voice', 'min_turn_seconds']);

/** @param {string} text @returns {Record<string, unknown>} */
export function parseToml(text) {
  /** @type {Record<string, unknown>} */ const out = {};
  for (const raw of String(text).split('\n')) {
    const line = stripComment(raw).trim();
    if (!line || line.startsWith('[')) continue;               // tables are not used
    const m = /^([A-Za-z0-9_-]+)\s*=\s*(.+)$/.exec(line);
    if (!m) continue;
    const v = parseValue(m[2].trim());
    if (v !== undefined) out[m[1]] = v;
  }
  return out;
}

function stripComment(line) {
  let q = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === '\\' && q === '"') i++; else if (c === q) q = null; }
    else if (c === '"' || c === "'") q = c;
    else if (c === '#') return line.slice(0, i);
  }
  return line;
}

/** @returns {unknown} */
function parseValue(v) {
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (/^[+-]?\d+(\.\d+)?$/.test(v)) return Number(v);
  if (/^"(?:[^"\\]|\\.)*"$/.test(v)) { try { return JSON.parse(v); } catch { return undefined; } }
  if (/^'[^']*'$/.test(v)) return v.slice(1, -1);
  if (v.startsWith('[') && v.endsWith(']')) {
    const items = [];
    const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'/g;
    let m;
    while ((m = re.exec(v))) items.push(m[1] !== undefined ? JSON.parse(`"${m[1]}"`) : m[2]);
    return items;
  }
  return undefined;
}

/** Keep only known keys with the right types and sane values. */
function validate(obj) {
  /** @type {Partial<Config>} */ const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (!(k in DEFAULTS)) continue;
    const d = /** @type {any} */ (DEFAULTS)[k];
    if (Array.isArray(d)) { if (Array.isArray(v) && v.every((x) => typeof x === 'string')) /** @type {any} */ (out)[k] = v; continue; }
    if (typeof v !== typeof d) continue;
    /** @type {any} */ (out)[k] = v;
  }
  if (out.mode && !MODES.includes(out.mode)) delete out.mode;
  if (out.rate !== undefined && (out.rate < 80 || out.rate > 500)) delete out.rate;
  if (out.answer_timeout !== undefined && (out.answer_timeout < 3 || out.answer_timeout > 25)) delete out.answer_timeout;
  if (out.listener_confidence !== undefined && (out.listener_confidence < 0.5 || out.listener_confidence > 1)) delete out.listener_confidence;
  return out;
}

function readToml(path) {
  try { return existsSync(path) ? parseToml(readFileSync(path, 'utf8')) : {}; } catch { return {}; }
}

/**
 * Effective config for a session.
 * @param {{ cwd?: string, session?: Partial<Config> }} [ctx]
 * @returns {Config}
 */
export function loadConfig(ctx = {}) {
  const user = validate(readToml(userConfigPath()));
  /** @type {Partial<Config>} */ let project = {};
  if (ctx.cwd) {
    const raw = validate(readToml(join(ctx.cwd, '.claude', 'readback.toml')));
    // A repository may not switch engines, loosen safety, or raise its own volume.
    for (const [k, v] of Object.entries(raw)) if (PROJECT_KEYS.has(k)) /** @type {any} */ (project)[k] = v;
    if (project.voice_approval === true && user.voice_approval === false) delete project.voice_approval;
  }
  const never = [...(user.never_by_voice ?? []), ...(project.never_by_voice ?? [])];
  return /** @type {Config} */ ({ ...DEFAULTS, ...user, ...project, ...(ctx.session ?? {}), never_by_voice: never });
}

/** Persist one setting to the user file (commands with --save). Rewrites or appends the key. */
export function saveUserSetting(key, value) {
  if (!['mode', 'voice', 'rate'].includes(key)) throw new Error(`cannot save ${key}`);
  const path = userConfigPath();
  const line = `${key} = ${typeof value === 'string' ? JSON.stringify(value) : String(value)}`;
  const text = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const re = new RegExp(`^\\s*${key}\\s*=.*$`, 'm');
  const next = re.test(text) ? text.replace(re, line) : `${text}${text && !text.endsWith('\n') ? '\n' : ''}${line}\n`;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, next);
}

/** "22:00-07:00" → is `date` inside it? Empty or malformed → false. */
export function inQuietHours(spec, date = new Date()) {
  const m = /^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/.exec(String(spec ?? '').trim());
  if (!m) return false;
  const start = Number(m[1]) * 60 + Number(m[2]);
  const end = Number(m[3]) * 60 + Number(m[4]);
  const now = date.getHours() * 60 + date.getMinutes();
  return start <= end ? now >= start && now < end : now >= start || now < end;
}
