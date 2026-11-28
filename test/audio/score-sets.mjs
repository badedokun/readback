#!/usr/bin/env node
// Step 2 of 2: replay recorded trials (record-sets.mjs) through the real Listener with a given
// whisper model, and report the release gates (test plan §4).
//
// Usage: node test/audio/score-sets.mjs <recordings-dir> <model.bin> [jobs=4]
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { correct, summarize } from './sets.mjs';

// 0 = the model's own default bar, as for a user who has not set listener_confidence.
const MIN_CONFIDENCE = Number(process.env.AUDIO_MIN_CONFIDENCE ?? 0);
const WINDOW_MS = 9000;
const here = fileURLToPath(new URL('.', import.meta.url));

if (process.argv[2] === '--worker') {
  // One process per job: READBACK_CAPTURE_CMD and REPLAY_RAW are process-wide.
  const [, , , dir, model, list] = process.argv;
  process.env.READBACK_MODEL = model;
  process.env.READBACK_CAPTURE_CMD = join(here, 'replay.mjs');
  const { Listener, MODELS } = await import('../../src/daemon/listener/index.mjs');
  const listener = new Listener();
  const pinned = Object.values(MODELS).find((m) => basename(model) === m.file);
  if (pinned) listener.model = pinned;
  else if (!MIN_CONFIDENCE) { console.error(`unknown model ${model}: set AUDIO_MIN_CONFIDENCE`); process.exit(2); }
  for (const t of JSON.parse(list)) {
    process.env.REPLAY_RAW = join(dir, t.file);
    const heard = [];
    const t0 = Date.now();
    const got = await listener.listen({ timeoutMs: WINDOW_MS, minConfidence: MIN_CONFIDENCE, onHeard: (h) => heard.push(`${h.heard} ${h.confidence.toFixed(2)}`) });
    const answer = got?.answer ?? null;
    process.stdout.write(JSON.stringify({ ...t, answer, heard, confidence: got ? Math.round(got.confidence * 100) / 100 : null, ok: correct(t, answer), ms: Date.now() - t0 }) + '\n');
  }
  process.exit(0);
}

const [dir, model, jobsArg] = process.argv.slice(2);
if (!dir || !model) { console.error('usage: score-sets.mjs <recordings-dir> <model.bin> [jobs]'); process.exit(2); }
const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
const jobs = Number(jobsArg ?? 4);
const parts = Array.from({ length: jobs }, (_, j) => manifest.trials.filter((_, i) => i % jobs === j));
/** @type {any[]} */ const rows = [];
await Promise.all(parts.map((part) => new Promise((resolve, reject) => {
  const p = spawn(process.execPath, [fileURLToPath(import.meta.url), '--worker', dir, model, JSON.stringify(part)], { stdio: ['ignore', 'pipe', 'inherit'] });
  let buf = '';
  p.stdout.on('data', (d) => {
    buf += d;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const r = JSON.parse(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
      rows.push(r);
      process.stdout.write(`${rows.length}/${manifest.trials.length} ${r.ok ? 'ok  ' : r.answer === 'allow' ? 'FALSE-ALLOW' : 'miss'} ${r.set} ${r.speaker} ${r.level} "${r.phrase}" → ${r.answer} [${r.heard.join(' | ')}]\n`);
    }
  });
  p.on('exit', (c) => (c === 0 ? resolve(undefined) : reject(new Error(`worker exited ${c}`))));
})));
const summary = summarize(rows);
const name = basename(model).replace(/^ggml-|\.bin$/g, '');
const file = join(dir, `scores-${name}.json`);
writeFileSync(file, JSON.stringify({ model: name, min_confidence: MIN_CONFIDENCE, recorded: manifest.started, summary, rows }, null, 2));
console.log(JSON.stringify(summary, null, 2));
console.log(`details: ${file}`);
