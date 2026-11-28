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
├── bin/readback-hook.mjs             # the shim: every hook event (no heavy imports)
├── src/                              # plain ES modules + JSDoc (ADR-0002 amendment)
│   ├── daemon/
│   │   ├── main.mjs                  # lock, socket, lifecycle
│   │   ├── daemon.mjs                # request routing, sessions, commands
│   │   ├── summarizer/{rules.mjs,sanitize.mjs,haiku.mjs}
│   │   ├── queue.mjs
│   │   ├── tts/index.mjs             # say, piper, espeak-ng + record (test); kokoro/cloud in M3
│   │   ├── broker.mjs
│   │   ├── listener/{index.mjs,segmenter.mjs,vocabulary.mjs}
│   │   ├── config.mjs
│   │   └── util.mjs
│   └── shared/{paths.mjs,log.mjs}
├── test/{golden/,contract/,fakes/,smoke/,audio/,*.test.mjs}
├── spike/{run_m0.py,run_m1_live.py}  # live drivers for real Claude Code sessions
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

1. **Strip** fenced code blocks, inline code longer than 24 characters, tables, block quotes, headings, HTML, emphasis markers (`**bold**`, `*italic*`, `_italic_` but not snake_case) and markdown links (keep the link text).
2. **Split** into sentences. Drop sentences made mostly of symbols, more than 30% characters that are neither letters nor digits (digits count as words: "Version 2.4.0 is out." is kept).
3. **Find the question.** If the message ends on a question, that is the question to the user ("Deploy now?", "Before I start: should this cover…?"). Otherwise take the last question addressed to the user ("you", "want me", "should I", "shall I", "would you"). Two questions joined by "And/Also/Or" are kept together when they fit in 20 words. A question that leans on the sentence before it ("Go ahead?", any question of 3 words or fewer, "Which do you prefer?" after a sentence with "or") takes that sentence as its outcome.
4. **Find the outcome.** Score the remaining sentences:
    - +3 for a past-tense action verb at the start (added, fixed, updated, created, removed, ran, deployed).
    - +3 for a test or build result (pass, fail, error, green, red).
    - +2 for the first sentence.
    - −2 for hedging or meta talk ("Let me", "I'll now", "Here's").
    - Take the top sentence, plus a second one in chatty mode.
5. **Sanitize** (shared with the Haiku strategy):
    - Paths → basename, at most 2 per utterance, so `src/auth/login.ts` becomes "login.ts"; later ones become "N other files". `file.ts:42` → "file.ts line 42". Branch-like names without an extension read with a space (`release/2.3` → "release 2.3").
    - Hashes and IDs (hex ≥ 7 characters, UUIDs) → "a commit" or "an ID".
    - Numbers > 6 digits, with or without thousands separators → "about 12 million" (rounded to millions, billions or trillions; "the roughly 12 million-row table"). ISO dates → "January 14, 2027".
    - URLs → "a link" (a trailing ": a link" at the end of a sentence is dropped). "Committed the fix as 4e1d9a7" → "Committed the fix".
    - Remove emoji and markdown symbols.
    - Expand common abbreviations for TTS: "e.g." → "for example", "PR" → "P R" where the engine needs it.
6. **Compose:** outcome + question. Brief mode allows at most 2 sentences and 30 words; truncate at a clause boundary. Chatty mode allows 4 sentences and 60 words.
7. **Empty result:** if nothing remains, say "Claude finished." only when the turn was longer than 60 s. Otherwise stay silent.

### 5.2 Haiku strategy (opt-in)
- `summarizer = "claude-haiku"`. Runs `claude -p --model haiku --output-format text --tools "" --strict-mcp-config --no-session-persistence --setting-sources "" --system-prompt <rules>` with the message on stdin, wrapped in `<message>` tags and truncated to 8 kB. `--bare` is not usable: it accepts only `ANTHROPIC_API_KEY`, and most users sign in with a subscription.
- The child runs in an empty directory (`<data>/summarizer`), so it reads no repository, `CLAUDE.md` or project settings, and with `READBACK_DISABLE=1`, so Readback's own hooks in the child exit at once (no recursion).
- The system prompt makes the model speak as the assistant in the first person, treat the message as data (never answer it or describe it), keep any question the message asks and never add one, never read code aloud, and answer `NOTHING` when there is nothing worth saying.
- Timeout 4 s. On timeout, error, empty output or `NOTHING`, the rules strategy is used. Measured (M2, 10 corpus messages): p50 1.1 s, max 1.4 s.
- The output is never trusted: it goes through the sanitizer and `clamp()`, which holds it to the mode's sentence and word limits (keeping the question, and the sentence the question leans on).
- If the user types while the model runs, the result is dropped (the turn is stale, FR-31).

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
| `Bash` | "Claude wants to run <first 8 words of command>." |
| `Edit` / `Write` | "Claude wants to edit <basename>." |
| `WebFetch` | "Claude wants to open <hostname>." |
| MCP tool | "Claude wants to use <server> <tool>." |
| other | "Claude wants to use <tool_name>." |

The broker appends "Say yes or no, or answer on screen." when it will listen, and "Please answer on screen." when it will not (announce-only). "Yes" and "no" are asked for because they were the most reliably recognised answers in the M1 microphone tests.

**Gate.** `never_by_voice` holds regexes matched against `JSON.stringify(tool_input)`. Defaults:

```
\brm\s+-[a-z]*r[a-z]*f, \brm\s+-[a-z]*f[a-z]*r, git\s+push\b.*--force, git\s+push\b.*\s-f\b, git\s+reset\s+--hard, \bsudo\b, \bDROP\s+(TABLE|DATABASE)\b, terraform\s+(apply|destroy), kubectl\s+delete, gcloud\s+.*\bdelete\b
```

On a match, say "Claude wants to run a protected command. Please use the keyboard." and return null.

**Timing:** Claude Code's own dialog appears at about 6 s (FR-24a), so `answer_timeout` (20 s) bounds only the voice side. The spoken prompt ends with "…or answer on screen".

**Concurrency:** only one open request per daemon. Another request arriving while one is open returns null immediately, so it falls back to the dialog.

## 8. Answer listener

- Capture: one continuous raw stream (16 kHz mono s16le) for the whole answer window, started only in the LISTENING state, after playback ends + 250 ms. macOS: `rec` (sox). Linux: `parec` (PulseAudio, and PipeWire's Pulse server), else `pw-record`, else `rec`. sox on Linux defaults to ALSA, which blocks forever with no ALSA device, and its Pulse driver buffers its output.
- Segmentation (`segmenter.mjs`): 20 ms frames; an utterance starts after 60 ms above the trigger level and ends after 600 ms below it, capped at 4 s. The trigger level is the higher of 0.4% of full scale (−48 dBFS) and 3× the background level, which the segmenter learns as it goes (fast when the room gets quieter, slowly when it gets louder). A fixed 1% missed every quiet trial in the M2 audio sets: speech peaking at −37 dBFS in a room at −62 dBFS. It keeps **300 ms of pre-roll** from before the trigger. M2 replaced sox's `silence` effect, which threw away everything before its trigger: that clipped word onsets ("Allow" lost its "A" and scored 0.17; "deny" came out as "Good night"). If the source stops sending data mid-utterance (some PipeWire and monitor sources send nothing in silence), the utterance ends after 600 ms without data.
- **Allow must settle** (`SETTLE_MS` = 800): an accepted "allow" counts only if no more speech starts in the next 800 ms; otherwise it is dropped and listening continues. Deny and defer act at once. In the M2 noise set the louder trigger level split "yes … but wait" in two and "Yes" alone approved. This rule fails that case closed.
- **Allow must be the only speech** in the window: if unclear speech was heard earlier in the window, a later "allow" is ignored. In the 28-speaker set, the tail of "The build is green and all tests pass" was transcribed as a separate "Yes.".
- **Confidence by answer:** allow needs `listener_confidence`. Its default, 0, means the model's own bar: 0.5 for base.en and 0.6 for tiny.en. base.en scores short words lower ("Yes." at 0.59–0.85 where tiny.en gives 0.97). In the 28-speaker set, 0.5 let through no wrong allow that 0.6 would have stopped. Deny and defer need only 0.4, because they hand the decision back to the keyboard.
- Model (`MODEL`): `base.en` on macOS and `tiny.en` on Linux. Both are pinned by URL and SHA-256, and `READBACK_MODEL` may point at either. In the 28-speaker audio set, base.en had 0 false allows and tiny.en had 1, at equal accuracy. base.en takes 0.65 s per answer with Metal but about 10 s on a 4-thread CPU.
- Recognition: whisper.cpp `whisper-cli` with the vocabulary hint `--prompt "Allow. Deny. Yes. No. Approve. Reject. Go ahead. Stop. Don't. Show me. Wait. Hold on. Keyboard."` (every answer phrase; without "Wait", "Don't" and "Keyboard" in it, tiny.en wrote them as "We", "Done" and "People"), one utterance at a time while capture continues. Without the hint, tiny.en hears "deny" as "Tonight" and scores "Allow" at 0.37. With it, answers score 0.89–0.99, and noise and unrelated speech still fail to match. **Never add "okay" to the vocabulary**: with the hint, pink noise transcribes as "Okay".
- Latency: about 0.7 s per clip on Apple silicon (Metal), about 3 s on a 4-thread Linux CPU, because whisper always encodes a 30 s window. `--audio-ctx 256` cut that by only a third and made tiny.en repeat itself ("Allow. Allow."), which breaks exact matching, so it is not used.
- The answer window uses a plain timer, not `AbortSignal.any([…, AbortSignal.timeout()])`: on Node 20 the timeout signal inside `any()` can be garbage-collected and never fire (found in M2; the listener kept running past its window).
- A transcript with digits never matches ("Yes, 30." is not "yes").
- Confidence = the mean probability of word tokens only (special tokens such as `<|endoftext|>` and punctuation excluded).
- Measurements (laptop speaker → laptop mic, synthetic voices): M1, 28 trials: 22 correct, **0 false allows**. M2 with the segmenter: 6/6 smoke phrases at 0.85–0.99, and the live acceptance run's "yes"/"no" at 0.98/0.93. Audio-set results are in [05-test-plan.md](05-test-plan.md) §4.
- Vocabulary mapping: normalize to lowercase letters, then exact-match one of:

| Decision | Phrases |
|---|---|
| allow | allow, yes, approve, approved, yes allow, go ahead |
| deny | deny, no, reject, don't, stop |
| defer | show me, wait, keyboard, hold on |

- Accept only when the transcript is **1–3 words** and fully matches, and whisper's average token probability clears the bar (`listener_confidence`, above). Anything else is "unclear", and the listener keeps waiting until the window closes.
- Dependencies: `brew install sox whisper-cpp` (macOS); on Linux the distro's `pulseaudio-utils` (or PipeWire) and whisper.cpp built from source (it is not packaged by most distros). The model downloads to `${CLAUDE_PLUGIN_DATA}/models/ggml-tiny.en.bin` on first enable. If anything is missing, voice approval is disabled with a spoken one-time notice, and announcements still work.

## 8a. TTS engines

| Engine | Platform | How |
|---|---|---|
| `say` | macOS | `say -r <rate> [-v <voice>] -f -`, text on stdin. |
| `piper` | Linux (any) | `piper --model <voice.onnx> --output-raw --length_scale <170/rate>` piped into `paplay --raw` (or `pw-cat`, or `aplay`) at the voice's sample rate. Voices live in `<data>/voices/*.onnx` with their `.onnx.json`; `voice` names one, or an absolute path. Readback does not download voices in v0.1. |
| `espeak` | Linux (any) | `espeak-ng -s <rate> [-v <voice>] --stdin`. Robotic, but nearly always installed. |

`engine = "auto"` picks `say` on macOS; on Linux, Piper when it and a voice are installed, else espeak-ng. Every process of a pipeline runs in its own process group, and cancel kills all of them (measured: 2–6 ms). Text reaches engines on stdin, never through a shell.

## 9. Configuration schema

```toml
# ~/.config/readback/config.toml  (project override: .claude/readback.toml)
mode = "brief"                 # alerts | brief | chatty
engine = "auto"                # auto | say | piper | espeak  (kokoro and cloud engines: M3)
voice = ""                     # engine-specific; empty = engine default
rate = 190                     # words per minute
summarizer = "rules"           # rules | claude-haiku | off
min_turn_seconds = 10
quiet_hours = ""               # e.g. "22:00-07:00"
voice_approval = true
answer_timeout = 20            # seconds
listener_confidence = 0           # 0 = the model's default
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
