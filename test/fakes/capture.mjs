// Fake microphone: writes raw 16 kHz mono s16le in real time, then silence until killed.
// FAKE_CAPTURE = "tone:400,gap:300,tone:400" (milliseconds).
const RATE = 16000;
const plan = (process.env.FAKE_CAPTURE ?? '').split(',').filter(Boolean).map((p) => {
  const [kind, ms] = p.split(':');
  return { amp: kind === 'tone' ? 0.3 : 0, ms: Number(ms) };
});
let i = 0;
let phase = 0;
setInterval(() => {
  const step = plan[0] ?? { amp: 0, ms: Infinity };
  const n = RATE / 50;                                  // 20 ms per tick
  const b = Buffer.alloc(n * 2);
  for (let k = 0; k < n; k++, i++) b.writeInt16LE(Math.round(step.amp * 32767 * Math.sin((2 * Math.PI * 440 * i) / RATE)), k * 2);
  process.stdout.write(b);
  phase += 20;
  if (phase >= step.ms) { plan.shift(); phase = 0; }
}, 20);
