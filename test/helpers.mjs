// Test doubles.
/** Engine whose utterances finish only when the test says so. */
export function manualEngine() {
  const plays = [];
  return {
    plays,
    speak(text) {
      let finish = () => {};
      const done = new Promise((r) => { finish = r; });
      const p = { text, cancelled: false, finish: () => finish() };
      plays.push(p);
      return { done, cancel() { p.cancelled = true; finish(); } };
    },
    /** Finish the utterance currently playing. */
    finishCurrent() { const p = plays.findLast((x) => !x.cancelled && !x.ended); if (p) { p.ended = true; p.finish(); } },
  };
}

/** Engine that finishes every utterance on the next tick. */
export function instantEngine() {
  const spoken = [];
  return { spoken, speak(text) { spoken.push(text); return { done: new Promise((r) => setImmediate(r)), cancel() {} }; } };
}

export const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
