# Readback — Test Plan

| | |
|---|---|
| Version | 1.0 |
| Date | 2026-11-24 |
| Framework | Vitest (unit, contract, queue, broker). Shell smoke tests for the engines. |

## 1. Strategy

Most behaviour is tested as text, with no audio. The TTS adapter and the listener are mocked behind their interfaces. Real-audio tests are limited to engine smoke tests and the voice-approval audio sets.

| Level | What | Runs |
|---|---|---|
| Unit | Sanitizer, summarizer rules, vocabulary matcher, config merge | Every PR |
| Golden | Speech corpus: message → expected utterance | Every PR |
| Contract | Recorded hook payloads → shim output and IPC messages | Every PR, plus nightly against the latest Claude Code |
| Component | Queue, broker state machine (fake clock, fake listener) | Every PR |
| Engine smoke | Each TTS engine speaks one line into a null sink | Every PR (macOS + Linux runners) |
| Audio sets | Listener accuracy and false-allow rate on recorded clips | Release gate |
| Dogfood | 30-minute hands-free session on a real repo | Release gate |

## 2. Golden speech corpus

- `test/golden/*.json` holds `{ message, mode, expected }` cases. The target is at least 100 cases at v0.1, collected from real Claude Code sessions with the authors' consent and scrubbed of secrets.
- **Invariants** are checked on every output, in addition to exact match:
    - No backticks.
    - No `/` path with 2 or more segments.
    - No hex string of 7 or more characters.
    - No URL.
    - No emoji.
    - Word count ≤ 30 (brief) or ≤ 60 (chatty).
- Each new bug report with the "speech-rule miss" label adds a case.

## 3. Test cases and traceability

| ID | Test | Covers |
|---|---|---|
| TC-01 | Stop payload with message → one `speak.turn` IPC request; shim exits 0 in < 50 ms | FR-01, NFR-01 |
| TC-02 | Stop with `stop_hook_active: true` → no IPC | FR-01 |
| TC-03 | Turn shorter than `min_turn_seconds` in brief mode → silent | FR-02 |
| TC-04 | Message ending in a user-directed question → question included verbatim (≤ 20 words) | FR-03 |
| TC-05 | Golden corpus passes, with invariants | §6 speech rules |
| TC-10 | Notification `idle_prompt` → "Claude is waiting for you in <project>." | FR-10 |
| TC-11 | `permission_prompt` with a broker request open → nothing spoken | FR-11 |
| TC-20 | PermissionRequest Bash `npm test` → spoken "Claude wants to run npm test. Allow?" | FR-20 |
| TC-21 | Listener "allow" / "yes" / "approve" → allow JSON with no `updatedPermissions` | FR-21, FR-22 |
| TC-22 | Listener "deny" / "no" → deny JSON with message "Denied by voice" | FR-23 |
| TC-23 | "show me", silence 20 s, confidence 0.4, a 5-word utterance, listener crash → exit 0 with empty stdout | FR-24, NFR-07 |
| TC-24 | `rm -rf build` → announced as protected; no listener; empty stdout | FR-25 |
| TC-25 | Listener starts only after the playback-ended event + 250 ms | FR-26 |
| TC-26 | `voice_approval = false` → announce only | FR-28 |
| TC-27 | Daemon not running → PermissionRequest shim exits 0 with empty stdout within 1 s | NFR-07 |
| TC-28 | Second concurrent PermissionRequest → immediate null | §7 concurrency |
| TC-29 | Project config sets `never_by_voice = []` → defaults still apply | T4 |
| TC-30 | `/readback:stop` → playback killed < 150 ms; prompt blocked with `suppressOriginalPrompt` | FR-30, NFR-04 |
| TC-31 | Any normal prompt → `stop` sent; prompt not blocked | FR-31 |
| TC-32 | Mute and unmute; permission items still play while muted | FR-32 |
| TC-33 | `/readback:mode chatty` → 4-sentence limit applied | FR-33 |
| TC-34 | Dedupe: same text twice within 60 s → spoken once | §6 |
| TC-35 | Newest wins: turn B queued while A plays → A stopped, B played | §6 |
| TC-40 | Zero config on macOS → `say` engine selected | FR-40 |
| TC-41 | Haiku summarizer timeout → rules output used | §5.2 |
| TC-42 | Haiku output containing a path → sanitized | §5.2 |
| TC-50 | Default config makes no network connections (CI runs with network namespace disabled) | NFR-06 |
| TC-51 | Logs contain no message text with `debug = false` | NFR-06 |
| TC-60 | Turn end → first audio p95 < 600 ms over 50 runs | NFR-02 |

## 4. Voice-approval audio sets (release gate)

| Set | Contents | Pass criterion |
|---|---|---|
| Positive | 3 speakers × 9 phrases × 3 mic distances (laptop mic, 0.5 m, 2 m) | ≥ 95% correct decision |
| Negative | Readback's own prompts played back, office chatter, podcast audio, partial phrases ("yes but wait", "no idea") | **0 false allows**; false denies ≤ 1% |
| Noise | Fan, keyboard typing, music at 60 dB | ≥ 90% correct; 0 false allows |

## 5. Contract tests against Claude Code

- `test/contract/fixtures/<cc-version>/<event>.json` holds hook payloads recorded with a logging hook.
- A nightly CI job installs the latest Claude Code, records fresh payloads with a capture plugin, and diffs their shape against the fixtures. A new required field or a removed field opens an issue automatically.
- The README's "tested with Claude Code x.y–x.z" line is updated from this job.

## 6. Exit criteria for v0.1

- All TC-xx tests mapped to **M** requirements pass on macOS and Linux.
- The audio-set gates pass.
- A dogfood session is completed and logged in the release notes.
- The security checklist in [04-security-privacy.md](04-security-privacy.md) §7 is ticked.
