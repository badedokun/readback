# Readback — Detailed Design

| | |
|---|---|
| Version | 1.0 |
| Date | 2026-11-24 |
| Inputs | [01-requirements.md](01-requirements.md), [02-architecture.md](02-architecture.md) |

> Field names below match the Claude Code hooks reference as verified on 2026-11-24. Before coding (M0), re-check the `PermissionRequest` output schema against the live docs. The verification of it came from a summarized fetch.

## 1. Repository layout

```
readback/
├── .claude-plugin/plugin.json
├── .claude-plugin/marketplace.json
├── hooks/hooks.json
├── skills/<command>/SKILL.md        # stop, mute, unmute, mode, repeat, test, voice, rate
├── bin/readback-hook.mjs             # compiled shim entry
├── src/
│   ├── shim/                        # per-event handlers (no heavy imports)
│   ├── daemon/
│   │   ├── main.ts                  # boot, socket, lifecycle
│   │   ├── ipc.ts
│   │   ├── summarizer/{rules.ts,haiku.ts,sanitize.ts}
│   │   ├── queue.ts
│   │   ├── tts/{index.ts,say.ts,piper.ts,kokoro.ts,espeak.ts,openai.ts,elevenlabs.ts}
│   │   ├── broker.ts
│   │   ├── listener/{index.ts,whisper.ts,vocabulary.ts}
│   │   └── config.ts
│   └── shared/{protocol.ts,log.ts}
├── test/{golden/,contract/,queue/,broker/,engines/}
└── docs/
```

## 2. Plugin manifest and hook registration

`.claude-plugin/plugin.json`:
```json
{
  "name": "readback",
  "version": "0.1.0",
  "description": "Hear Claude Code: spoken turn summaries and voice approval of permission prompts.",
  "author": { "name": "Readback contributors" },
  "license": "MIT"
}
```

`hooks/hooks.json`:
```json
{
  "hooks": {
    "SessionStart":      [{ "hooks": [{ "type": "command", "command": "node \"${CLAUDE_PLUGIN_ROOT}/bin/readback-hook.mjs\" session-start", "async": true }] }],
    "Stop":              [{ "hooks": [{ "type": "command", "command": "node \"${CLAUDE_PLUGIN_ROOT}/bin/readback-hook.mjs\" stop", "async": true }] }],
    "Notification":      [{ "hooks": [{ "type": "command", "command": "node \"${CLAUDE_PLUGIN_ROOT}/bin/readback-hook.mjs\" notification", "async": true }] }],
    "PermissionRequest": [{ "matcher": "*", "hooks": [{ "type": "command", "command": "node \"${CLAUDE_PLUGIN_ROOT}/bin/readback-hook.mjs\" permission", "timeout": 30 }] }],
    "UserPromptSubmit":  [{ "hooks": [{ "type": "command", "command": "node \"${CLAUDE_PLUGIN_ROOT}/bin/readback-hook.mjs\" prompt", "timeout": 2 }] }],
    "SessionEnd":        [{ "hooks": [{ "type": "command", "command": "node \"${CLAUDE_PLUGIN_ROOT}/bin/readback-hook.mjs\" session-end", "async": true }] }]
  }
}
```

## 3. Hook contracts

### 3.1 Stop (input → action)
```json
{ "hook_event_name": "Stop", "session_id": "…", "cwd": "/repo", "stop_hook_active": false,
  "last_assistant_message": "I added a rate limiter … All 42 tests pass. Want me to commit?" }
```
- If `stop_hook_active` is true, ignore the event. That means another Stop hook is looping.
- Send `{"type":"speak.turn","session":…,"cwd":…,"text":last_assistant_message,"ts":…}`.
- Never read `transcript_path` ([ADR-0003](adr/0003-use-last-assistant-message.md)).

### 3.2 PermissionRequest (input → output)
Input: `tool_name`, `tool_input`, `permission_suggestions`, and `mcp_server` for MCP tools.

The shim sends `permission.ask` and waits up to 28 s, which is 2 s below the hook timeout.

| Daemon reply | Shim stdout | Exit |
|---|---|---|
| `{"decision":"allow"}` | `{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}` | 0 |
| `{"decision":"deny"}` | `{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"Denied by voice"}}}` | 0 |
| `{"decision":null}`, timeout or error | *(nothing)* | 0 |

The shim never sets `updatedPermissions` or `updatedInput`.

### 3.3 UserPromptSubmit
1. Send `stop` without waiting for the reply. This is fire-and-forget, with a 100 ms socket write budget.
2. If `prompt` matches `^/readback:(\w+)\s*(.*)$`, send `command` and wait up to 1 s. Then output:
   ```json
   {"decision":"block","reason":"readback: speech stopped","suppressOriginalPrompt":true}
   ```
   The prompt never reaches Claude, so no tokens are spent.
3. Otherwise output nothing, and the prompt continues normally.

Each `skills/<cmd>/SKILL.md` exists so the command appears in autocomplete and `/help`. Its body is one line ("Readback handles this locally."), as a fallback if blocking ever fails.

> M0 check: confirm that UserPromptSubmit receives the typed `/readback:stop` line and that blocking it prevents skill expansion. If not, move command handling to `UserPromptExpansion`, which the docs say "can block the expansion".

### 3.4 Notification
| `notification_type` | Action |
|---|---|
| `idle_prompt` | Say "Claude is waiting for you in <project>." |
| `permission_prompt` | If the broker has an open request for this session, ignore it. Otherwise say "Claude needs permission in <project>." |
| `elicitation_dialog`, `agent_needs_input` | Say "Claude needs your input in <project>." |
| other | Ignore. |

`<project>` is the basename of `cwd`.

## 4. IPC protocol

The transport is a Unix domain socket at `${XDG_RUNTIME_DIR:-/tmp}/readback-${UID}.sock`, mode 0600, carrying newline-delimited JSON. Every request has an `id`, and the daemon replies `{"id":…,"ok":true,…}`.

| Request `type` | Fields | Reply |
|---|---|---|
| `hello` | `session`, `cwd`, `pid` | `ok` |
| `speak.turn` | `session`, `cwd`, `text`, `elapsed_ms?` | `ok` (immediately; speaking is async) |
| `alert` | `session`, `cwd`, `kind`, `message` | `ok` |
| `permission.ask` | `session`, `cwd`, `tool_name`, `tool_input`, `mcp_server?` | `decision: "allow" \| "deny" \| null`, `reason` |
| `stop` | `session` | `ok` |
| `command` | `session`, `name`, `args` | `ok`, `message` |
| `bye` | `session` | `ok` |

Daemon start: the shim tries to connect. On `ENOENT` or `ECONNREFUSED`, it spawns `node daemon.mjs` detached and retries for up to 300 ms. Async hooks may wait. For PermissionRequest, an unavailable daemon means no decision. A lock file (`readback-$UID.lock`, `O_EXCL`) prevents two daemons starting at once.

## 5. Summarizer

### 5.1 Rules strategy (default)
Pipeline, applied in order to `last_assistant_message`:

1. **Strip** fenced code blocks, inline code longer than 24 characters, tables, block quotes, HTML and markdown links (keep the link text).
2. **Split** into sentences. Drop sentences made mostly of symbols or paths, more than 30% non-letters.
3. **Find the question.** Take the last sentence ending in `?`, if it is addressed to the user ("you", "want me", "should I", "shall I", "would you").
4. **Find the outcome.** Score the remaining sentences:
    - +3 for a past-tense action verb at the start (added, fixed, updated, created, removed, ran, deployed).
    - +3 for a test or build result (pass, fail, error, green, red).
    - +2 for the first sentence.
    - −2 for hedging or meta talk ("Let me", "I'll now", "Here's").
    - Take the top sentence, plus a second one in chatty mode.
5. **Sanitize** (shared with the Haiku strategy):
    - Paths → basename, at most 2 per utterance, so `src/auth/login.ts` becomes "login.ts".
    - Hashes and IDs (hex ≥ 7 characters, UUIDs) → "a commit" or "an ID".
    - Numbers > 6 digits → "a large number".
    - URLs → "a link".
    - Remove emoji and markdown symbols.
    - Expand common abbreviations for TTS: "e.g." → "for example", "PR" → "P R" where the engine needs it.
6. **Compose:** outcome + question. Brief mode allows at most 2 sentences and 30 words; truncate at a clause boundary. Chatty mode allows 4 sentences and 60 words.
7. **Empty result:** if nothing remains, say "Claude finished." only when the turn was longer than 60 s. Otherwise stay silent.

### 5.2 Haiku strategy (opt-in)
- Run `claude -p --model haiku --output-format text` with a fixed system prompt that encodes the speech rules, and the message (truncated to 8 kB) on stdin.
- Timeout 4 s. On timeout or error, fall back to the rules strategy.
- Always run the sanitizer (§5.1 step 5) on the output. Model output is never trusted to follow the rules.

## 6. Speech queue

```
Item { id, session, kind: permission|alert|turn|system, text, createdAt }
Priority: permission > alert > turn > system
```
| Rule | Behaviour |
|---|---|
| Newest wins | Enqueuing a `turn` drops older queued `turn` items. If a `turn` is playing, it is stopped and replaced. |
| Permission is sacred | A `permission` item interrupts anything except another `permission`. It is never dropped by dedupe or newest-wins. |
| Dedupe | Identical normalized text within 60 s is dropped. |
| Barge-in | `stop` kills the current playback (SIGTERM to the process group, then SIGKILL after 100 ms) and clears all non-permission items. |
| Quiet hours | Drop everything except `permission`. |
| Mute | Drop everything except `permission` while muted. Mute is per session. |
| Multi-session | Prefix the project name when more than one session is registered: "In api-server: …". |

## 7. Permission broker

State machine per request:

```
RECEIVED → GATED ─(never_by_voice match / voice_approval=false)→ ANNOUNCE_ONLY → DONE(null)
              └→ SPEAKING → LISTENING ─("allow")→ DONE(allow) + tone
                                     ├("deny")→ DONE(deny) + tone
                                     ├("show me"/unclear/low confidence)→ DONE(null)
                                     ├(answer_timeout)→ DONE(null)
                                     └(shim socket closed)→ CANCELLED: stop speech, close mic, drop late results
```

**Race with the on-screen dialog (M0 finding).** Claude Code shows the normal dialog about 6 s after the request, while the hook is still waiting. If the user answers there, Claude Code kills the hook process. The broker learns this only when the shim's socket closes, so every request is keyed by its connection. A result from the recogniser is applied only if that connection is still open at the moment of writing the reply. The shim writes the decision in a single `write()` and exits, so there is no partial-decision state.

**Describe** builds the spoken request, with no raw command longer than 8 words:

| Tool | Spoken form |
|---|---|
| `Bash` | "Claude wants to run <first 8 words of command>. Allow?" |
| `Edit` / `Write` | "Claude wants to edit <basename>. Allow?" |
| `WebFetch` | "Claude wants to open <hostname>. Allow?" |
| MCP tool | "Claude wants to use <server> <tool>. Allow?" |
| other | "Claude wants to use <tool_name>. Allow?" |

**Gate.** `never_by_voice` holds regexes matched against `JSON.stringify(tool_input)`. Defaults:

```
\brm\s+-[a-z]*r[a-z]*f, git\s+push\s+.*--force, git\s+reset\s+--hard, \bsudo\b, \bDROP\s+(TABLE|DATABASE)\b, terraform\s+(apply|destroy), kubectl\s+delete, gcloud\s+.*\bdelete\b
```

On a match, say "Claude wants to run a protected command. Please use the keyboard." and return null.

**Timing:** Claude Code's own dialog appears at about 6 s (FR-24a), so `answer_timeout` (20 s) bounds only the voice side. The spoken prompt ends with "…or answer on screen".

**Concurrency:** only one open request per daemon. Another request arriving while one is open returns null immediately, so it falls back to the dialog.

## 8. Answer listener

- Capture: `sox -d` (`rec`), 16 kHz mono, started only in the LISTENING state, after playback ends + 250 ms.
- Recognition: whisper.cpp `whisper-cli` with `tiny.en`, run on each utterance segment. Segments are cut by voice-activity detection: energy threshold plus 600 ms of silence.
- Vocabulary mapping: normalize to lowercase letters, then exact-match one of:

| Decision | Phrases |
|---|---|
| allow | allow, yes, approve, yes allow, go ahead |
| deny | deny, no, reject, don't, stop |
| defer | show me, wait, keyboard, hold on |

- Accept only when the transcript is **1–3 words** and fully matches, and whisper's average token probability is ≥ 0.6 (`listener_confidence`). Anything else is "unclear", and the listener keeps waiting until the window closes.
- Dependencies: `brew install sox whisper-cpp` (macOS) or the distro packages. The model downloads to `${CLAUDE_PLUGIN_DATA}/models/ggml-tiny.en.bin` on first enable. If anything is missing, voice approval is disabled with a spoken one-time notice, and announcements still work.

## 9. Configuration schema

```toml
# ~/.config/readback/config.toml  (project override: .claude/readback.toml)
mode = "brief"                 # alerts | brief | chatty
engine = "auto"                # auto | say | piper | kokoro | espeak | openai | elevenlabs
voice = ""                     # engine-specific; empty = engine default
rate = 190                     # words per minute
summarizer = "rules"           # rules | claude-haiku | off
min_turn_seconds = 10
quiet_hours = ""               # e.g. "22:00-07:00"
voice_approval = true
answer_timeout = 20            # seconds
listener_confidence = 0.6
never_by_voice = []            # extra regexes, appended to the defaults
debug = false                  # log message text (off by default)
```

The project file may set only `mode`, `voice_approval`, `never_by_voice` (append-only) and `min_turn_seconds`. A repository cannot switch on cloud engines or loosen the safety settings.

## 10. Commands

Each command is handled by the UserPromptSubmit shim and the daemon `command` handler.

| Command | Effect |
|---|---|
| `/readback:stop` | `queue.stop()`, clears the queue |
| `/readback:mute` / `/readback:unmute` | Per-session mute |
| `/readback:mode <m>` | Sets the mode for the session (persist with `--save`) |
| `/readback:repeat` | Re-enqueues the last spoken item |
| `/readback:test` | Speaks a sample line, then opens a 5 s listener and says what it heard |
| `/readback:voice <name>` / `/readback:rate <wpm>` | Session setting (persist with `--save`) |
| `/readback:status` | Shows engine, mode, listener state and daemon PID in the block `reason` text |

## 11. Error handling and logging

| Failure | Behaviour |
|---|---|
| Daemon unreachable | Async hooks drop the event. PermissionRequest → no decision. |
| TTS engine fails | Try the next engine in `auto` order. If all fail, log it and stay silent. |
| Listener dependency missing | Disable voice approval for the session, give a one-time spoken notice, and keep announcing. |
| Haiku summarizer fails | Fall back to rules. |
| Unknown hook fields | Ignored. Missing required field → silent no-op, logged at warn. |

Logging is JSON lines at `${CLAUDE_PLUGIN_DATA}/readback.log`, at levels info and warn. It records event types, durations and decisions. Message text is logged only when `debug = true`.
