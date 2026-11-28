// Listener smoke test: play each phrase with a local engine while the real Listener listens.
// On Linux CI the engine plays into a null sink whose monitor is the default source.
import { Listener } from '../../src/daemon/listener/index.mjs';
import { createEngine } from '../../src/daemon/tts/index.mjs';

// This checks the audio path (engine → sink → capture → whisper → vocabulary), not
// accuracy: the audio sets measure that (test plan §4), and Piper varies each run. So a
// wrong answer or hearing nothing fails; a miss (heard, no answer: the keyboard decides)
// passes, as long as most cases are exact.
// Linux CI recognises on the CPU (about 3 s per clip in a 4-thread VM); allow for it.
const WINDOW_MS = Number(process.env.LISTEN_WINDOW_MS ?? 15000);
const CASES = [['yes', 'allow'], ['allow', 'allow'], ['no', 'deny'], ['deny', 'deny'], ['show me', 'defer'], ['banana bread', null]];
const engine = createEngine(process.argv[2] ?? 'auto');
if (!engine) { console.log('FAIL no engine'); process.exit(1); }
const listener = new Listener();
if (!(await listener.ready())) { console.log(`FAIL listener not ready: missing ${listener.missing().join(', ')}`); process.exit(1); }

let failed = 0;
let exact = 0;
for (const [phrase, want] of CASES) {
  const heard = [];
  const ac = new AbortController();
  const listening = listener.listen({ timeoutMs: WINDOW_MS, minConfidence: 0.6, signal: ac.signal, onHeard: (h) => heard.push(h) });
  await new Promise((r) => setTimeout(r, 600));
  await engine.engine.speak(phrase, { rate: 150 }).done;
  const got = await listening;
  const answer = got?.answer ?? null;
  const miss = answer === null && want !== null && heard.length > 0;
  const ok = answer === want || miss;
  if (answer === want) exact++;
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} "${phrase}" → ${answer} (heard ${heard.map((h) => `"${h.heard}" ${h.confidence.toFixed(2)}`).join(', ') || 'nothing'})${answer !== want && miss ? ' (miss: keyboard decides)' : ''}`);
}
const MIN_EXACT = 4;
if (exact < MIN_EXACT) console.log(`FAIL only ${exact}/${CASES.length} exact (need ${MIN_EXACT})`);
process.exit(failed || exact < MIN_EXACT ? 1 : 0);
