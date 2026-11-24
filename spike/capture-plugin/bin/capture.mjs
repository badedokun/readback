#!/usr/bin/env node
// M0 spike hook: logs every hook payload and exercises the behaviours Readback depends on.
// Usage (from hooks.json): node capture.mjs <EventName>   — payload arrives on stdin.
//
// Output dir: $READBACK_SPIKE_DIR, else <repo>/spike/fixtures/raw (gitignored: real session data).
// PermissionRequest behaviour is read per call from <repo>/spike/.mode:
//   none | allow | deny | wait<N> | wait<N>:allow | wait<N>:deny   ($READBACK_SPIKE_MODE overrides)

import { appendFileSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const event = process.argv[2] ?? 'Unknown';
const spikeDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const outDir = process.env.READBACK_SPIKE_DIR ?? join(spikeDir, 'fixtures', 'raw');
mkdirSync(outDir, { recursive: true });

const started = Date.now();
const raw = await readStdin();
let input;
try { input = JSON.parse(raw); } catch { input = { _unparsed: raw }; }

const log = (file, obj) => appendFileSync(join(outDir, file), JSON.stringify(obj) + '\n');
log(`${event}.jsonl`, { ts: new Date(started).toISOString(), event, input });
const latest = join(outDir, `${event}.latest.json`);
writeFileSync(latest, JSON.stringify(input, null, 2) + '\n');

switch (event) {
  case 'PermissionRequest': await permission(); break;
  case 'UserPromptSubmit':
  case 'UserPromptExpansion': promptHook(); break;
  case 'Stop': await stop(); break;
  default: break;
}
process.exit(0);

// ---------------------------------------------------------------------------

async function permission() {
  // Mode: $READBACK_SPIKE_MODE, else <spike>/.mode, else none.
  // Values: none | allow | deny | wait<N> | wait<N>:allow | wait<N>:deny   (N = seconds)
  const modeFile = join(spikeDir, '.mode');
  const mode = process.env.READBACK_SPIKE_MODE
    ?? (existsSync(modeFile) ? readFileSync(modeFile, 'utf8').trim() : 'none');
  const m = /^wait(\d+)(?::(allow|deny))?$/.exec(mode);
  if (m) await sleep(Number(m[1]) * 1000);
  const verdict = m ? (m[2] ?? 'none') : mode;
  let out = null;
  if (verdict === 'allow') out = { behavior: 'allow' };
  if (verdict === 'deny') out = { behavior: 'deny', message: 'Denied by readback spike' };
  log('PermissionRequest.decisions.jsonl', {
    ts: new Date().toISOString(), mode, tool: input.tool_name, waited_ms: Date.now() - started,
  });
  if (out) {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: out },
    }));
  }
}

function promptHook() {
  const prompt = String(input.prompt ?? input.command ?? input.expanded_prompt ?? '');
  const hit = /^\s*\/readback:stop\b/.test(prompt) || input.command_name === 'readback:stop';
  log('prompt.intercepts.jsonl', { ts: new Date().toISOString(), event, hit, keys: Object.keys(input) });
  if (hit) {
    speak('Stopped.');
    process.stdout.write(JSON.stringify({
      decision: 'block', reason: 'readback: speech stopped', suppressOriginalPrompt: true,
    }));
  }
}

async function stop() {
  const lam = input.last_assistant_message;
  const now = lastAssistantText(input.transcript_path);
  await sleep(2000);
  const later = lastAssistantText(input.transcript_path);
  log('Stop.compare.jsonl', {
    ts: new Date().toISOString(),
    has_lam: typeof lam === 'string',
    lam_len: lam?.length ?? null,
    transcript_at_stop_matches: now === lam,
    transcript_after_2s_matches: later === lam,
    transcript_at_stop_len: now?.length ?? null,
  });
  if (typeof lam === 'string' && lam.trim()) speak(lastSentence(lam));
}

function lastAssistantText(path) {
  if (!path || !existsSync(path)) return null;
  const lines = readFileSync(path, 'utf8').trim().split('\n').reverse();
  for (const line of lines) {
    let e; try { e = JSON.parse(line); } catch { continue; }
    if (e.type !== 'assistant') continue;
    const content = e.message?.content;
    const text = Array.isArray(content)
      ? content.filter((c) => c.type === 'text').map((c) => c.text).join('')
      : typeof content === 'string' ? content : '';
    if (text) return text;
  }
  return null;
}

function lastSentence(md) {
  const plain = md
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_#>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const sentences = plain.match(/[^.!?]+[.!?]*/g) ?? [plain];
  return sentences.map((s) => s.trim()).filter(Boolean).pop()?.slice(0, 300) ?? '';
}

function speak(text) {
  if (!text || process.platform !== 'darwin') return;
  // Text goes in on stdin, never argv, so it can't be read as a flag.
  const p = spawn('say', ['-f', '-'], { stdio: ['pipe', 'ignore', 'ignore'], detached: true });
  p.stdin.end(text);
  p.unref();
}

function readStdin() {
  return new Promise((resolve) => {
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => { buf += d; });
    process.stdin.on('end', () => resolve(buf));
    if (process.stdin.isTTY) resolve('');
  });
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
