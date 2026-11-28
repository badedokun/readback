#!/usr/bin/env node
// Step 1 of 2: play every trial through the speakers and record exactly what the mic hears.
// Step 2 (score-sets.mjs) replays the recordings through the real Listener, once per model,
// so models are compared on identical audio.
//
// Usage: node test/audio/record-sets.mjs <out-dir> [positive|negative|noise ...]
// Needs: macOS (say, osascript), sox, Piper (PIPER=path to the piper binary) with voices in
// VOICES_DIR (default ~/.cache/readback-dev/voices), speakers on at a fixed volume.
import { spawn, execFileSync } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { captureCommand } from '../../src/daemon/listener/index.mjs';
import { SETS, SPEAKERS, LEVELS } from './sets.mjs';

const [out, ...want] = process.argv.slice(2);
if (!out) { console.error('usage: record-sets.mjs <out-dir> [sets...]'); process.exit(2); }
const sets = want.length ? want : Object.keys(SETS);
const PIPER = process.env.PIPER ?? 'piper';
const VOICES = process.env.VOICES_DIR ?? join(homedir(), '.cache', 'readback-dev', 'voices');
const ONLY = process.env.AUDIO_SPEAKERS?.split(',');
const speakers = SPEAKERS.filter((s) => !ONLY || ONLY.includes(s.id));
const clips = join(out, 'clips');
mkdirSync(clips, { recursive: true });

const run = (cmd, args, input) => new Promise((resolve, reject) => {
  const p = spawn(cmd, args, { stdio: [input ? 'pipe' : 'ignore', 'ignore', 'pipe'] });
  let err = '';
  p.stderr.on('data', (d) => { err += d; });
  p.on('error', reject);
  p.on('exit', (c) => (c === 0 ? resolve(undefined) : reject(new Error(`${cmd} exited ${c}: ${err.slice(-300)}`))));
  if (input) p.stdin.end(input);
});

/** A dry clip of this speaker saying the phrase (cached). */
async function dry(s, phrase) {
  const file = join(clips, `${s.id}-${phrase.toLowerCase().replace(/[^a-z]+/g, '-').replace(/^-|-$/g, '')}.wav`);
  if (existsSync(file)) return file;
  if (s.engine === 'say') {
    const aiff = file.replace(/\.wav$/, '.aiff');
    await run('say', ['-v', s.voice, '-r', '170', '-o', aiff, phrase]);
    await run('sox', [aiff, file]);
    rmSync(aiff);
  } else {
    const args = ['-m', join(VOICES, `${s.voice}.onnx`), '-f', file, '--length-scale', String(s.pace ?? 1)];
    if (s.speaker !== undefined) args.push('-s', String(s.speaker));
    await run(PIPER, args, `${phrase}\n`);
  }
  return file;
}

const volume = () => execFileSync('osascript', ['-e', 'get volume settings']).toString().trim();
const startVolume = volume();
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const manifest = { started: new Date().toISOString(), speaker_volume: startVolume, trials: /** @type {any[]} */ ([]) };
console.log(`speaker: ${startVolume}; ${speakers.length} speakers; sets ${sets.join(', ')}`);

for (const set of sets) {
  const { cases, levels, noise } = SETS[set];
  const bg = noise ? spawn('play', ['-q', '-n', 'synth', '36000', 'pinknoise', 'vol', String(noise)], { stdio: 'ignore' }) : null;
  try {
    if (bg) await wait(1000);
    for (const s of speakers) {
      for (const level of levels) {
        for (const [i, c] of cases.entries()) {
          if (volume() !== startVolume) { console.error(`speaker volume changed mid-run (${startVolume} → ${volume()}); stopping`); process.exit(2); }
          const clip = await dry(s, c.phrase);
          const file = `${set}-${s.id}-${level}-${i}.raw`;
          const cap = captureCommand();
          const rec = spawn(cap.cmd, cap.args, { stdio: ['ignore', 'pipe', 'ignore'] });
          rec.stdout.pipe(createWriteStream(join(out, file)));
          await wait(400);
          await run('play', ['-q', clip, ...LEVELS[level]]);
          await wait(1500);
          rec.kill('SIGTERM');
          await new Promise((r) => rec.once('exit', r));
          manifest.trials.push({ set, speaker: s.id, level, phrase: c.phrase, want: c.want, alsoOk: c.alsoOk, file });
          process.stdout.write(`${manifest.trials.length} ${set} ${s.id} ${level} "${c.phrase}"\n`);
        }
      }
    }
  } finally { bg?.kill(); }
  writeFileSync(join(out, 'manifest.json'), JSON.stringify(manifest, null, 2));
}
manifest.finished = new Date().toISOString();
writeFileSync(join(out, 'manifest.json'), JSON.stringify(manifest, null, 2));
console.log(`recorded ${manifest.trials.length} trials in ${out}`);
