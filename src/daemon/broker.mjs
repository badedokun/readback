// Permission broker (detailed design §7). Fail closed: anything but a clear, confident,
// timely voice answer on an open request returns null, and Claude Code's dialog decides.
import { sleep, projectName } from './util.mjs';

export const DEFAULT_NEVER_BY_VOICE = [
  String.raw`\brm\s+-[a-z]*r[a-z]*f`, String.raw`\brm\s+-[a-z]*f[a-z]*r`, String.raw`git\s+push\b.*--force`,
  String.raw`git\s+push\b.*\s-f\b`, String.raw`git\s+reset\s+--hard`, String.raw`\bsudo\b`,
  String.raw`\bDROP\s+(TABLE|DATABASE)\b`, String.raw`terraform\s+(apply|destroy)`,
  String.raw`kubectl\s+delete`, String.raw`gcloud\s+.*\bdelete\b`,
];
const POST_PLAYBACK_GAP_MS = 250;
const HANDLED_WINDOW_MS = 30_000;

/**
 * @typedef {{ decision: 'allow'|'deny'|null, reason: string }} BrokerResult
 * @typedef {{ session: string, cwd: string, tool_name: string, tool_input: any, mcp_server?: string }} AskRequest
 * @typedef {{ voiceApproval: boolean, answerTimeoutMs: number, minConfidence: number,
 *             neverByVoice: string[], multiSession: boolean }} AskSettings
 */

/** Spoken description of a tool request: never a paraphrase, never more than 8 raw words. */
export function describe(tool_name, tool_input, mcp_server) {
  const input = tool_input && typeof tool_input === 'object' ? tool_input : {};
  const first = (s, n = 8) => String(s ?? '').split('\n')[0].trim().split(/\s+/).slice(0, n).join(' ');
  const base = (p) => String(p ?? '').replace(/\/+$/, '').split('/').pop() || 'a file';
  switch (tool_name) {
    case 'Bash': return `Claude wants to run ${first(input.command) || 'a command'}.`;
    case 'Edit': case 'Write': case 'MultiEdit': return `Claude wants to edit ${base(input.file_path)}.`;
    case 'NotebookEdit': return `Claude wants to edit ${base(input.notebook_path)}.`;
    case 'WebFetch': {
      let host = 'a website';
      try { host = new URL(String(input.url)).hostname; } catch { /* keep default */ }
      return `Claude wants to open ${host}.`;
    }
    case 'WebSearch': return `Claude wants to search the web for ${first(input.query, 6)}.`;
    default: {
      const m = /^mcp__(.+?)__(.+)$/.exec(tool_name);
      if (m) return `Claude wants to use ${spoken(mcp_server || m[1])} ${spoken(m[2])}.`;
      return `Claude wants to use ${spoken(tool_name) || 'a tool'}.`;
    }
  }
}
const spoken = (s) => String(s ?? '').replace(/[_-]+/g, ' ').trim();

/** @param {any} tool_input @param {string[]} patterns */
export function isProtected(tool_input, patterns) {
  const text = JSON.stringify(tool_input ?? {});
  return patterns.some((p) => { try { return new RegExp(p, 'i').test(text); } catch { return false; } });
}

export class Broker {
  /**
   * @param {{ queue: import('./queue.mjs').SpeechQueue,
   *           listener: { ready(): Promise<boolean>, listen(o: any): Promise<any> } | null,
   *           tone?: (kind: 'allow'|'deny') => void, now?: () => number,
   *           log?: import('../shared/log.mjs').Logger }} deps
   */
  constructor({ queue, listener, tone = () => {}, now = Date.now, log }) {
    this.queue = queue; this.listener = listener; this.tone = tone; this.now = now; this.log = log;
    /** @type {{ session: string } | null} */ this.open = null;
    /** @type {Map<string, number>} */ this.lastHandled = new Map();
  }

  /** True while a request for this session is open, or was handled in the last 30 s (FR-11). */
  handled(session) {
    if (this.open?.session === session) return true;
    const t = this.lastHandled.get(session);
    return t !== undefined && this.now() - t < HANDLED_WINDOW_MS;
  }

  /**
   * @param {AskRequest} req @param {AskSettings} settings
   * @param {AbortSignal} signal aborts when the shim's connection closes (answered on screen)
   * @returns {Promise<BrokerResult>}
   */
  async ask(req, settings, signal) {
    if (this.open) return { decision: null, reason: 'busy' };      // T6: one request at a time
    this.open = { session: req.session };
    const started = this.now();
    try {
      const result = await this.run(req, settings, signal);
      this.log?.info('permission', { tool: req.tool_name, decision: result.decision, reason: result.reason, ms: this.now() - started });
      return result;
    } finally {
      this.open = null;
      this.lastHandled.set(req.session, this.now());
    }
  }

  /** @private @param {AskRequest} req @param {AskSettings} s @param {AbortSignal} signal @returns {Promise<BrokerResult>} */
  async run(req, s, signal) {
    const prefix = s.multiSession ? `In ${projectName(req.cwd)}: ` : '';
    const say = (text) => this.queue.enqueue({ session: req.session, kind: 'permission', text: prefix + text });

    if (isProtected(req.tool_input, [...DEFAULT_NEVER_BY_VOICE, ...s.neverByVoice])) {
      say('Claude wants to run a protected command. Please use the keyboard.');
      return { decision: null, reason: 'protected' };
    }
    const description = describe(req.tool_name, req.tool_input, req.mcp_server);
    const canListen = s.voiceApproval && this.listener && await this.listener.ready();
    if (!canListen) {
      say(`${description} Please answer on screen.`);
      return { decision: null, reason: s.voiceApproval ? 'listener-unavailable' : 'announce-only' };
    }

    // "yes"/"no" are the most reliably recognised answers (M1 mic measurements).
    const { id, outcome } = say(`${description} Say yes or no, or answer on screen.`);
    const onAbort = () => this.queue.cancel(id);
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      if (await outcome !== 'played' || signal.aborted) return cancelledOr(signal, 'not-played');
      await sleep(POST_PLAYBACK_GAP_MS, signal);              // FR-26: never hear our own voice
      if (signal.aborted) return cancelledOr(signal, 'cancelled');
      this.log?.info('permission.listening', { tool: req.tool_name });
      const heard = await /** @type {NonNullable<Broker['listener']>} */ (this.listener).listen({
        timeoutMs: s.answerTimeoutMs, minConfidence: s.minConfidence, signal,
      });
      // FR-24b: a request answered on screen is final. Never apply a late voice answer.
      if (signal.aborted) return { decision: null, reason: 'cancelled' };
      if (heard?.answer === 'allow') { this.tone('allow'); return { decision: 'allow', reason: 'voice' }; }
      if (heard?.answer === 'deny') { this.tone('deny'); return { decision: 'deny', reason: 'voice' }; }
      return { decision: null, reason: heard?.answer === 'defer' ? 'defer' : 'timeout' };
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
  }
}

/** @param {AbortSignal} signal @param {string} reason @returns {BrokerResult} */
function cancelledOr(signal, reason) {
  return { decision: null, reason: signal.aborted ? 'cancelled' : reason };
}
