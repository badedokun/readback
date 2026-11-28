// Daemon core: one instance per user. Routes IPC requests to the summarizer, queue, broker
// and commands. No sockets here (see main.mjs), so it can be tested directly.
import { Broker } from './broker.mjs';
import { inQuietHours, loadConfig, saveUserSetting } from './config.mjs';
import { SpeechQueue } from './queue.mjs';
import { summarize } from './summarizer/rules.mjs';
import { summarizeHaiku } from './summarizer/haiku.mjs';
import { projectName } from './util.mjs';

/** @typedef {import('./config.mjs').Config} Config */
/** @typedef {{ cwd: string, muted: boolean, settings: Partial<Config>, lastPromptAt: number|null, seenAt: number, pid?: number }} Session */

export const REQUEST_TYPES = new Set(['hello', 'bye', 'speak.turn', 'alert', 'permission.ask', 'stop', 'command']);
const MODES = ['alerts', 'brief', 'chatty'];

export class Daemon {
  /**
   * @param {{ engine: { name: string, engine: import('./queue.mjs').Engine } | null,
   *           listener: import('./listener/index.mjs').Listener | null,
   *           tone?: (k: 'allow'|'deny') => void, now?: () => number,
   *           log: import('../shared/log.mjs').Logger, loadConfig?: typeof loadConfig,
   *           haiku?: typeof summarizeHaiku }} deps
   */
  constructor({ engine, listener, tone, now = Date.now, log, loadConfig: lc = loadConfig, haiku = summarizeHaiku }) {
    this.haiku = haiku;
    this.engineName = engine?.name ?? 'none';
    const silent = { speak: () => ({ done: Promise.resolve(), cancel() {} }) };
    this.queue = new SpeechQueue({ engine: engine?.engine ?? silent, now, log });
    this.listener = listener;
    this.broker = new Broker({ queue: this.queue, listener, tone, now, log });
    this.now = now;
    this.log = log;
    this.loadConfig = lc;
    /** @type {Map<string, Session>} */ this.sessions = new Map();
    this.lastActivity = now();
  }

  /** @param {string} id @param {string} [cwd] @returns {Session} */
  session(id, cwd) {
    let s = this.sessions.get(id);
    if (!s) {
      s = { cwd: cwd ?? '', muted: false, settings: {}, lastPromptAt: null, seenAt: this.now() };
      this.sessions.set(id, s);
    }
    if (cwd) s.cwd = cwd;
    s.seenAt = this.now();
    return s;
  }

  /**
   * Drop sessions whose Claude Code process has exited (no SessionEnd after a crash), and
   * sessions with no known process that have been silent for `staleMs`.
   * @param {number} staleMs @param {(pid: number) => boolean} alive
   */
  prune(staleMs, alive) {
    for (const [id, s] of this.sessions) {
      if (s.pid ? !alive(s.pid) : this.now() - s.seenAt > staleMs) this.sessions.delete(id);
    }
  }

  /** @param {Session} s @returns {Config} */
  config(s) { return this.loadConfig({ cwd: s.cwd, session: s.settings }); }

  /** "In api-server: …" when more than one session is registered. */
  prefix(s) { return this.sessions.size > 1 ? `In ${projectName(s.cwd)}: ` : ''; }

  /**
   * Speak unless muted or in quiet hours. Permission-class items always speak.
   * @param {string} id @param {Session} s @param {import('./queue.mjs').Kind} kind @param {string} text
   * @param {{ exempt?: boolean, force?: boolean }} [opts]
   */
  speak(id, s, kind, text, opts = {}) {
    const cfg = this.config(s);
    if (!opts.exempt && kind !== 'permission' && (s.muted || inQuietHours(cfg.quiet_hours))) return null;
    return this.queue.enqueue({ session: id, kind, text: this.prefix(s) + text, voice: cfg.voice || undefined, rate: cfg.rate, force: opts.force });
  }

  /**
   * @param {any} msg a validated IPC request
   * @param {AbortSignal} signal aborts when the requesting connection closes
   * @returns {Promise<object>} reply fields (the caller adds id and ok)
   */
  async handle(msg, signal) {
    this.lastActivity = this.now();
    const id = String(msg.session ?? '');
    switch (msg.type) {
      case 'hello': {
        const s = this.session(id, msg.cwd);
        if (Number.isInteger(msg.pid) && msg.pid > 1) s.pid = msg.pid;   // the Claude Code process
        if (this.config(s).voice_approval && this.listener && this.listener.missing().join() === 'model') {
          this.listener.ensureModel();                        // first enable: fetch the pinned model
        }
        return {};
      }
      case 'bye':
        this.sessions.delete(id);
        return {};
      case 'stop': {
        if (this.queue.busy) this.log.info('speech.stop');
        this.queue.stop();
        this.session(id).lastPromptAt = this.now();          // every prompt sends stop (FR-31)
        return {};
      }
      case 'speak.turn': return this.onTurn(id, msg);
      case 'alert': return this.onAlert(id, msg);
      case 'permission.ask': return this.onPermission(id, msg, signal);
      case 'command': return { message: await this.onCommand(id, msg) };
      default: return {};
    }
  }

  /** @private */
  async onTurn(id, msg) {
    const s = this.session(id, msg.cwd);
    const cfg = this.config(s);
    if (cfg.summarizer === 'off' || cfg.mode === 'alerts' || typeof msg.text !== 'string') return {};
    const promptAt = s.lastPromptAt;
    const elapsedMs = promptAt === null ? null : this.now() - promptAt;
    if (cfg.mode === 'brief' && elapsedMs !== null && elapsedMs < cfg.min_turn_seconds * 1000) {
      this.log.info('turn.skip', { reason: 'short', ms: elapsedMs });
      return {};
    }
    let text;
    let strategy = 'rules';
    if (cfg.summarizer === 'claude-haiku') {
      const t0 = this.now();
      const r = await this.haiku(msg.text, { mode: cfg.mode, elapsedMs });
      ({ text, strategy } = r);
      this.log.info('summarizer', { strategy, ms: this.now() - t0, ...(r.fallback ? { fallback: r.fallback } : {}) });
      // The user typed again while the model ran: this turn is stale (FR-31).
      if (s.lastPromptAt !== promptAt) { this.log.info('turn.skip', { reason: 'superseded' }); return {}; }
    } else {
      text = summarize(msg.text, { mode: cfg.mode, elapsedMs });
    }
    this.log.info('turn', { mode: cfg.mode, strategy, chars_in: msg.text.length, words_out: text ? text.split(' ').length : 0 });
    this.log.debug('turn.text', { text });
    if (text) this.speak(id, s, 'turn', text);
    return {};
  }

  /** @private */
  onAlert(id, msg) {
    const s = this.session(id, msg.cwd);
    const where = projectName(s.cwd);
    const lone = this.sessions.size <= 1;
    switch (msg.kind) {
      case 'idle_prompt':
        this.speak(id, s, 'alert', lone ? `Claude is waiting for you in ${where}.` : 'Claude is waiting for you.');
        break;
      case 'permission_prompt':
        if (this.broker.handled(id)) break;                  // FR-11: the broker already spoke
        this.speak(id, s, 'alert', lone ? `Claude needs permission in ${where}.` : 'Claude needs permission.', { exempt: true });
        break;
      case 'elicitation_dialog':
      case 'agent_needs_input':
        this.speak(id, s, 'alert', lone ? `Claude needs your input in ${where}.` : 'Claude needs your input.');
        break;
      default: break;
    }
    return {};
  }

  /** @private */
  async onPermission(id, msg, signal) {
    const s = this.session(id, msg.cwd);
    const cfg = this.config(s);
    const result = await this.broker.ask(
      { session: id, cwd: s.cwd, tool_name: String(msg.tool_name ?? ''), tool_input: msg.tool_input, mcp_server: msg.mcp_server },
      {
        voiceApproval: cfg.voice_approval, answerTimeoutMs: cfg.answer_timeout * 1000,
        minConfidence: cfg.listener_confidence, neverByVoice: cfg.never_by_voice,
        multiSession: this.sessions.size > 1,
      },
      signal,
    );
    return { decision: result.decision, reason: result.reason };
  }

  /** @private @returns {Promise<string>} */
  async onCommand(id, msg) {
    const s = this.session(id, msg.cwd);
    const args = String(msg.args ?? '').split(/\s+/).filter(Boolean);
    const save = args.includes('--save');
    const value = args.filter((a) => a !== '--save').join(' ');
    const persist = (key, v) => {
      if (!save) return '';
      try { saveUserSetting(key, v); return ' (saved)'; } catch (e) { return ` (not saved: ${e})`; }
    };
    switch (String(msg.name)) {
      case 'stop': return 'speech stopped';                // the shim already sent stop
      case 'mute': s.muted = true; return 'muted for this session (permission prompts still speak)';
      case 'unmute': s.muted = false; return 'unmuted';
      case 'mode':
        if (!MODES.includes(value)) return `mode is ${this.config(s).mode}; use alerts, brief or chatty`;
        s.settings.mode = /** @type {any} */ (value);
        return `mode ${value}${persist('mode', value)}`;
      case 'voice':
        if (!value) return `voice is ${this.config(s).voice || 'the engine default'}`;
        s.settings.voice = value;
        return `voice ${value}${persist('voice', value)}`;
      case 'rate': {
        const n = Number(value);
        if (!Number.isInteger(n) || n < 80 || n > 500) return `rate is ${this.config(s).rate}; use 80 to 500 words per minute`;
        s.settings.rate = n;
        return `rate ${n}${persist('rate', n)}`;
      }
      case 'repeat': {
        const last = this.queue.last;
        if (!last) return 'nothing to repeat';
        this.queue.enqueue({ session: id, kind: 'system', text: last.text, force: true });
        return 'repeating';
      }
      case 'test': return this.runTest(id, s);
      case 'status': return this.status(s);
      default: return `unknown command "${msg.name}"; try stop, mute, unmute, mode, repeat, test, voice, rate or status`;
    }
  }

  /** @private */
  async runTest(id, s) {
    const listener = this.listener;
    const canListen = this.config(s).voice_approval && listener && await listener.ready();
    const intro = canListen ? 'Readback is working. After this, say allow or deny.' : 'Readback is working.';
    const { outcome } = this.queue.enqueue({ session: id, kind: 'system', text: intro, force: true });
    if (canListen) {
      (async () => {
        if (await outcome !== 'played') return;
        const heard = [];
        await listener.listen({ timeoutMs: 5000, minConfidence: 0, onHeard: (h) => heard.push(h) });
        const h = heard.find((x) => x.answer) ?? heard[0];
        const text = h
          ? `I heard ${h.heard.replace(/[^\w\s']/g, '').trim()}${h.answer ? `, which means ${h.answer}` : ', which is not an answer'}.`
          : 'I did not hear anything. Check microphone access for your terminal.';
        this.queue.enqueue({ session: id, kind: 'system', text, force: true });
      })().catch((e) => this.log.warn('test.fail', { error: String(e) }));
      return 'test running: speaking, then listening for 5 seconds';
    }
    const why = !this.config(s).voice_approval ? 'voice approval is off' : `missing ${listener?.missing().join(', ') || 'listener'}`;
    return `test running: speech only (${why})`;
  }

  /** @private */
  status(s) {
    const cfg = this.config(s);
    const missing = this.listener?.missing() ?? ['listener'];
    const listen = !cfg.voice_approval ? 'off' : missing.length ? `unavailable (missing ${missing.join(', ')})` : 'ready';
    return `engine ${this.engineName}, mode ${cfg.mode}${s.muted ? ' (muted)' : ''}, voice approval ${listen}, `
      + `sessions ${this.sessions.size}, daemon pid ${process.pid}`;
  }
}
