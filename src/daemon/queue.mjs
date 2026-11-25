// Speech queue (detailed design §6): priority, newest-wins, dedupe, barge-in.
// Mute, quiet hours and multi-session prefixes are applied by the daemon before enqueue.

/** @typedef {'permission'|'alert'|'turn'|'system'} Kind */
/** @typedef {'played'|'dropped'|'stopped'|'failed'} Outcome */
/**
 * @typedef {{ speak(text: string, opts?: { voice?: string, rate?: number }):
 *   { done: Promise<void>, cancel(): void } }} Engine
 */
/**
 * @typedef {{ id: number, session: string, kind: Kind, text: string, createdAt: number,
 *   voice?: string, rate?: number, resolve: (o: Outcome) => void }} Item
 */

const PRIORITY = { permission: 0, alert: 1, turn: 2, system: 3 };
const DEDUPE_MS = 60_000;

const normalize = (t) => t.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

export class SpeechQueue {
  /** @param {{ engine: Engine, now?: () => number, log?: import('../shared/log.mjs').Logger }} deps */
  constructor({ engine, now = Date.now, log }) {
    this.engine = engine;
    this.now = now;
    this.log = log;
    /** @type {Item[]} */ this.items = [];
    /** @type {(Item & { playback: { done: Promise<void>, cancel(): void } }) | null} */ this.current = null;
    /** @type {Map<string, number>} */ this.recent = new Map();
    /** @type {{ session: string, kind: Kind, text: string } | null} */ this.last = null;
    this.nextId = 1;
  }

  /**
   * @param {{ session: string, kind: Kind, text: string, voice?: string, rate?: number, force?: boolean }} req
   * @returns {{ id: number, outcome: Promise<Outcome> }}
   */
  enqueue(req) {
    const id = this.nextId++;
    /** @type {(o: Outcome) => void} */ let resolve = () => {};
    const outcome = new Promise((r) => { resolve = r; });
    const item = { ...req, id, createdAt: this.now(), resolve };
    const key = normalize(req.text);

    if (!key) { resolve('dropped'); return { id, outcome }; }
    if (req.kind !== 'permission' && !req.force) {
      const seen = this.recent.get(key);
      if (seen !== undefined && this.now() - seen < DEDUPE_MS) { resolve('dropped'); return { id, outcome }; }
    }
    this.recent.set(key, this.now());
    this.pruneRecent();

    if (req.kind === 'turn') {
      // Newest wins: drop queued turns, and replace a turn that is playing.
      this.items = this.items.filter((i) => {
        if (i.kind !== 'turn') return true;
        i.resolve('dropped');
        return false;
      });
      if (this.current?.kind === 'turn') this.interruptCurrent();
    }
    if (req.kind === 'permission' && this.current && this.current.kind !== 'permission') {
      this.interruptCurrent();           // permission is sacred: interrupts everything else
    }

    this.items.push(item);
    this.items.sort((a, b) => PRIORITY[a.kind] - PRIORITY[b.kind] || a.createdAt - b.createdAt || a.id - b.id);
    this.pump();
    return { id, outcome };
  }

  /** Barge-in: stop playback and clear everything except permission prompts. */
  stop() {
    this.items = this.items.filter((i) => {
      if (i.kind === 'permission') return true;
      i.resolve('stopped');
      return false;
    });
    if (this.current) this.interruptCurrent();
  }

  /** Cancel one item (queued or playing). Used when a permission request is answered elsewhere. */
  cancel(id) {
    const idx = this.items.findIndex((i) => i.id === id);
    if (idx >= 0) { this.items[idx].resolve('stopped'); this.items.splice(idx, 1); }
    if (this.current?.id === id) this.interruptCurrent();
  }

  get busy() { return !!this.current || this.items.length > 0; }

  /** @private */
  interruptCurrent() {
    const cur = this.current;
    if (!cur) return;
    this.current = null;
    cur.resolve('stopped');
    try { cur.playback.cancel(); } catch { /* already gone */ }
  }

  /** @private */
  pump() {
    if (this.current || this.items.length === 0) return;
    const item = /** @type {Item} */ (this.items.shift());
    let playback;
    try {
      playback = this.engine.speak(item.text, { voice: item.voice, rate: item.rate });
    } catch (e) {
      this.log?.warn('tts.fail', { error: String(e) });
      item.resolve('failed');
      return this.pump();
    }
    const cur = { ...item, playback };
    this.current = cur;
    this.last = { session: item.session, kind: item.kind, text: item.text };
    playback.done.then(
      () => this.finish(cur, 'played'),
      (e) => { this.log?.warn('tts.fail', { error: String(e) }); this.finish(cur, 'failed'); },
    );
  }

  /** @private */
  finish(cur, outcome) {
    if (this.current !== cur) return;  // already interrupted and resolved
    this.current = null;
    cur.resolve(outcome);
    this.pump();
  }

  /** @private */
  pruneRecent() {
    if (this.recent.size < 200) return;
    const cutoff = this.now() - DEDUPE_MS;
    for (const [k, t] of this.recent) if (t < cutoff) this.recent.delete(k);
  }
}
