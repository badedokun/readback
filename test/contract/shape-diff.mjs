#!/usr/bin/env node
// Nightly contract check (test plan §5): compare freshly recorded hook payloads with the
// fixtures. Exit 1 when a field Readback reads is missing or changed type; new fields are
// reported but do not fail.
// Usage: node test/contract/shape-diff.mjs <record-dir>
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const FIXTURES = new URL('./fixtures/', import.meta.url).pathname;
/** event → [fixture, fields Readback reads] */
const CHECKS = {
  SessionStart: ['session-start', ['session_id', 'cwd', 'hook_event_name']],
  UserPromptSubmit: ['prompt-plain', ['session_id', 'cwd', 'prompt', 'hook_event_name']],
  Stop: ['stop', ['session_id', 'cwd', 'last_assistant_message', 'stop_hook_active', 'hook_event_name']],
  SessionEnd: ['session-end', ['session_id', 'hook_event_name']],
};

const type = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);
const dir = process.argv[2];
if (!dir) { console.error('usage: shape-diff.mjs <record-dir>'); process.exit(2); }

const problems = [];
const notes = [];
for (const [event, [fixture, required]] of Object.entries(CHECKS)) {
  const file = join(dir, `${event}.json`);
  if (!existsSync(file)) { problems.push(`${event}: no payload recorded (the hook did not fire)`); continue; }
  const got = JSON.parse(readFileSync(file, 'utf8'));
  const want = JSON.parse(readFileSync(join(FIXTURES, `${fixture}.json`), 'utf8'));
  for (const k of required) {
    if (!(k in got)) problems.push(`${event}: required field "${k}" is missing`);
    else if (k in want && type(got[k]) !== type(want[k])) problems.push(`${event}: "${k}" is ${type(got[k])}, was ${type(want[k])}`);
  }
  for (const k of Object.keys(got)) if (!(k in want)) notes.push(`${event}: new field "${k}" (${type(got[k])})`);
  for (const k of Object.keys(want)) if (!(k in got) && !required.includes(k)) notes.push(`${event}: field "${k}" no longer sent (unused by Readback)`);
}
for (const n of notes) console.log(`note: ${n}`);
for (const p of problems) console.log(`BREAKING: ${p}`);
console.log(problems.length ? `${problems.length} breaking change(s)` : 'hook payload contract unchanged');
process.exit(problems.length ? 1 : 0);
