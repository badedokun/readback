# Readback — Requirements Specification

| | |
|---|---|
| Version | 1.0 (baseline) |
| Date | 2026-11-24 |
| Status | Approved for design |
| License | MIT (open source, non-commercial community project) |

## 1. Purpose

Readback is a free, open-source Claude Code plugin. With it, a developer can hold a spoken conversation with Claude Code:

1. The developer talks.
2. Claude works.
3. Claude says out loud, in one or two sentences, what it did and what it needs.
4. The developer can approve or deny permission prompts by voice.

Claude Code already accepts spoken *input* through the built-in `/voice` dictation. It cannot answer out loud, and you cannot approve permission prompts by voice. Reading raw replies aloud is useless because they are full of diffs, paths and tool output. Readback's core job is deciding **what is worth saying, and when**.

## 2. Users

| Persona | Need |
|---|---|
| Away-from-keyboard developer | Step away while long tasks run; hear when Claude is done or needs approval, and approve without walking back. |
| Accessibility user (RSI, low vision) | A spoken status, with less reading and typing. |
| Voice pair-programmer | A short spoken status instead of scrolling the terminal. |

## 3. Decisions baked into this baseline

| # | Decision | Date |
|---|---|---|
| D1 | Readback provides voice approval of permission prompts. | 2026-11-24 |
| D2 | Speech is stopped by a dedicated plugin command, `/readback:stop`. The bare `/stop` is a built-in Claude Code command, and plugin commands are namespaced `/<plugin>:<name>`. Any typed prompt also stops speech. | 2026-11-24 |
| D3 | The turn summary comes from the Stop hook's `last_assistant_message` field, not from the transcript file. Claude Code docs say the transcript "isn't guaranteed to include the final message at Stop time". | 2026-11-24 |
| D4 | Input for normal prompts stays with Claude Code's native `/voice`. Readback adds only a narrow, short-lived yes/no listener for permission prompts. | 2026-11-24 |

## 4. Functional requirements

Priority: **M** = must (v0.1), **S** = should (v0.1 if time allows), **C** = could (later).

### 4.1 Spoken turn summaries
| ID | Requirement | Pri |
|---|---|---|
| FR-01 | When a Claude turn ends (Stop hook), Readback speaks a summary of `last_assistant_message`, following the speech rules (§6). | M |
| FR-02 | Turns shorter than `min_turn_seconds` (default 10 s) stay silent in Brief mode. | M |
| FR-03 | If Claude's final message ends with a question to the user, the summary includes that question, verbatim if it is 20 words or fewer. | M |
| FR-04 | Subagent completions (SubagentStop) stay silent unless they failed. | S |

### 4.2 Attention alerts
| ID | Requirement | Pri |
|---|---|---|
| FR-10 | On Notification `idle_prompt`, speak "Claude is waiting for you." with the project name. | M |
| FR-11 | On Notification `permission_prompt`, speak nothing if FR-20 already handled that prompt. Otherwise speak the prompt. | M |
| FR-12 | On `elicitation_dialog` / `agent_needs_input`, speak that Claude needs input. | S |

### 4.3 Voice permission approval
| ID | Requirement | Pri |
|---|---|---|
| FR-20 | On PermissionRequest, speak a plain description of the request (tool and target, no raw command longer than 8 words), then open the answer listener. | M |
| FR-21 | The listener accepts a closed vocabulary: **allow** ("allow", "yes", "approve"), **deny** ("deny", "no", "reject"), **defer** ("show me", "wait", "keyboard"). | M |
| FR-22 | **allow** returns `behavior: "allow"` for this one request only. Voice never grants persistent rules (`updatedPermissions`). | M |
| FR-23 | **deny** returns `behavior: "deny"` with message "Denied by voice". | M |
| FR-24 | **defer**, silence for `answer_timeout` (default 20 s), low-confidence recognition, or any error → the hook exits 0 with no decision, and Claude Code shows its normal permission dialog. | M |
| FR-25 | Requests matching the `never_by_voice` patterns are never voice-approved. They are announced and fall through to the keyboard. Default patterns: `rm -rf`, `git push --force`, `git reset --hard`, `sudo`, `DROP `, `terraform apply`, `kubectl delete`. | M |
| FR-26 | The listener opens only after the spoken prompt finishes playing, and closes on the first answer. This prevents Readback's own speech being heard as an answer. | M |
| FR-27 | A short confirmation tone plays after a voice answer is accepted (distinct tones for allow and deny). | S |
| FR-28 | Voice approval can be disabled entirely (`voice_approval = false`). Readback then only announces prompts. | M |

### 4.4 Stopping and control
| ID | Requirement | Pri |
|---|---|---|
| FR-30 | `/readback:stop` stops current speech, clears the queue, and does not reach Claude. No tokens are spent. | M |
| FR-31 | Any submitted prompt (UserPromptSubmit) stops current speech. | M |
| FR-32 | `/readback:mute` and `/readback:unmute` toggle speech for the session. | M |
| FR-33 | `/readback:mode alerts\|brief\|chatty` switches mode. | M |
| FR-34 | `/readback:repeat` replays the last utterance. | S |
| FR-35 | `/readback:test` speaks a sample line and runs a mic check for the listener. | M |
| FR-36 | `/readback:voice <name>` and `/readback:rate <wpm>` set the voice and speed. | S |
| FR-37 | Optional global hotkey to stop speech without focusing the terminal. | C |

### 4.5 Modes
| Mode | Turn end | Permission / idle |
|---|---|---|
| alerts | silent | spoken |
| brief (default) | ≤ 2 sentences, ≈ 30 words | spoken |
| chatty | ≤ 4 sentences, ≈ 60 words | spoken |

### 4.6 Configuration
| ID | Requirement | Pri |
|---|---|---|
| FR-40 | Works with zero configuration on macOS. | M |
| FR-41 | User config at `~/.config/readback/config.toml`. Project override at `.claude/readback.toml`. | M |
| FR-42 | `quiet_hours` mutes everything except permission prompts. | S |
| FR-43 | `summarizer = rules \| claude-haiku \| off`. Default `rules`. | M |

## 5. Non-functional requirements

| ID | Requirement | Target |
|---|---|---|
| NFR-01 | Hook overhead added to Claude Code (non-permission hooks) | < 50 ms to return |
| NFR-02 | Turn end → first audio, rules summarizer | < 600 ms (p95) |
| NFR-03 | Turn end → first audio, Haiku summarizer | < 2.5 s (p95) |
| NFR-04 | `/readback:stop` or prompt submit → silence | < 150 ms |
| NFR-05 | Voice answer recognized → decision returned | < 1 s after the end of speech |
| NFR-06 | Privacy: nothing leaves the machine with default settings. No telemetry. | Always |
| NFR-07 | Fail-safe: any Readback error degrades to normal Claude Code behaviour. It never blocks or auto-approves. | Always |
| NFR-08 | Daemon memory with listener model loaded | < 250 MB |
| NFR-09 | Platforms | macOS 13+ and Linux (PulseAudio/PipeWire) in v0.1. Windows/WSL in v0.2. |
| NFR-10 | Runtime | Node ≥ 20 (already required by Claude Code). No other mandatory runtime. |
| NFR-11 | Install | `claude plugin marketplace add <owner>/readback` then `claude plugin install readback@readback` |
| NFR-12 | Compatibility | README states the tested Claude Code version range. CI runs hook contract tests on recorded payloads. |

## 6. Speech rules (normative)

**Always say:**
- The outcome in plain words.
- Any question to the user.
- That the user is needed.
- Failures, with a count.

**Never say:**
- Code, diffs, stack traces, JSON or log lines.
- Full paths. Say the file name only, at most two.
- Hashes, IDs or numbers longer than 6 digits.
- Markdown symbols, URLs or emoji.

**Timing:**
- Silent while tools run.
- No identical utterance within 60 s.
- A newer utterance replaces an older one. Permission prompts are never dropped or replaced.

## 7. Out of scope (v0.1)

- A general speech-to-text engine. Use `/voice`.
- Always-on wake word.
- Other agents (Codex, Gemini CLI, Cursor).
- Reading code aloud.
- SSH or remote audio relay: Readback detects a remote session and disables itself with a message.

## 8. Constraints and assumptions

- No hook fires when `/voice` dictation starts. Readback cannot detect the start of dictation, only prompt submission. Utterances are kept short, and `/readback:stop` is available.
- `/voice` dictation requires a claude.ai login. Readback's speech output works with any login, and its answer listener is independent of `/voice`.
- Hook payload shapes can change between Claude Code versions (risk R1 in the architecture doc).

## 9. Acceptance criteria (v0.1)

1. All **M** requirements pass their test cases in `05-test-plan.md`.
2. The golden speech corpus (≥ 100 messages) passes with no code, paths, hashes or more than 30 words in Brief mode.
3. Voice approval: ≥ 95% correct on the scripted answer set, and **0 false allows** on the negative set (noise, TTS echo, other speech).
4. A 30-minute hands-free dogfood session completes with no keyboard use except fallbacks.
