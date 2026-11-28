// Engine smoke test (test plan §1): every engine available on this machine speaks one line to
// the default sink, and cancel() stops it fast and leaves no process behind.
// Usage: node test/smoke/engines.mjs [engine ...]   (default: every engine for this platform)
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createEngine } from '../../src/daemon/tts/index.mjs';

const wanted = process.argv.slice(2);
const candidates = wanted.length ? wanted : process.platform === 'darwin' ? ['say'] : ['piper', 'espeak'];
const LINE = 'Readback engine smoke test. The build is green and all tests pass.';
let failed = 0;

function survivors(name) {
  const bins = { say: ['say'], espeak: ['espeak-ng', 'espeak'], piper: ['piper', 'paplay', 'pw-cat', 'aplay'] }[name] ?? [];
  try { return execFileSync('ps', ['-eo', 'comm'], { encoding: 'utf8' }).split('\n').filter((c) => bins.some((b) => c.trim().endsWith(b))); }
  catch { return []; }
}

for (const name of candidates) {
  const picked = createEngine(name);
  if (!picked || picked.name !== name) { console.log(`FAIL ${name}: not available`); failed++; continue; }
  try {
    const t0 = Date.now();
    const full = picked.engine.speak(LINE, { rate: 190 });
    await Promise.race([full.done, new Promise((_, rej) => setTimeout(() => rej(new Error('did not finish in 20 s')), 20_000))]);
    const playMs = Date.now() - t0;

    const p = picked.engine.speak(`${LINE} ${LINE} ${LINE}`, { rate: 190 });
    await new Promise((r) => setTimeout(r, 400));
    const c0 = Date.now();
    p.cancel();
    await p.done;
    const cancelMs = Date.now() - c0;
    await new Promise((r) => setTimeout(r, 300));
    const left = survivors(name);
    assert.ok(cancelMs < 150, `cancel took ${cancelMs} ms`);
    assert.deepEqual(left, [], `processes left: ${left}`);
    console.log(`ok   ${name}: played in ${playMs} ms, cancelled in ${cancelMs} ms`);
  } catch (e) {
    console.log(`FAIL ${name}: ${/** @type {Error} */ (e).message}`);
    failed++;
  }
}
process.exit(failed ? 1 : 0);
