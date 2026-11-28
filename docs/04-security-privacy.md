# Readback — Security and Privacy

| | |
|---|---|
| Version | 1.0 |
| Date | 2026-11-24 |

## 1. Scope

Readback can approve tool calls in Claude Code. That makes it a security-relevant component, even though it is a small local plugin. This document covers the threat model for voice approval, local IPC, model downloads and privacy.

## 2. Security principles

1. **Fail closed to the human.** Every error, timeout or ambiguity produces *no decision*, and Claude Code shows its normal dialog. Readback never approves by default.
2. **One-shot only.** Voice never creates persistent permission rules (`updatedPermissions`) and never modifies tool input (`updatedInput`).
3. **Least capability.** The microphone opens only during an answer window, of at most `answer_timeout` seconds.
4. **Repositories cannot weaken safety.** A project config can tighten safety but never loosen it.

## 3. Threat model (voice approval)

| # | Threat | Example | Controls | Residual risk |
|---|---|---|---|---|
| T1 | Self-echo | Readback's own "…Allow?" is heard as "allow" | Listener opens only after playback ends + 250 ms (covers the reverb tail); 1–3 word utterances only; the negative audio set includes Readback's own prompts | Very low |
| T2 | Bystander or media audio | A colleague or a video says "yes" | Confidence ≥ 0.6, full-utterance match, 20 s window, the window opens only right after the spoken prompt; users in shared spaces can disable voice approval | Low. Documented in the README. |
| T3 | Dangerous command approved by voice | `rm -rf`, force push, `terraform apply` | `never_by_voice` default list, appended to by the user; announcement says "use the keyboard" | Low; regex lists are incomplete |
| T4 | Malicious repo loosens safety | `.claude/readback.toml` sets `never_by_voice = []` or a cloud engine | Project config is append-only for `never_by_voice` and cannot set `engine`, `listener_confidence` or `answer_timeout` | Very low |
| T5 | Prompt-injected request text spoken to trick the user | Tool input crafted to *sound* harmless when read aloud | Speak the tool name and the first 8 words of the raw command, not a model paraphrase; Bash commands always start "Claude wants to run …" | Medium. A human judgement risk, the same as the visual dialog. |
| T6 | Concurrent requests confused | The user answers request A, and it is applied to B | One open request at a time; others fall back to the dialog | Very low |

## 4. Local IPC

- The socket lives in `$XDG_RUNTIME_DIR` (per-user) or `/tmp/readback-$UID.sock`, created with mode 0600. The daemon checks peer UID on Linux (`SO_PEERCRED`). On macOS, `getpeereid` is used through a native helper if available; otherwise it relies on the file mode.
- The daemon accepts only the request types documented in the design. It never executes shell text received over IPC. TTS and listener processes are spawned with argument arrays, and text is passed on stdin, never interpolated into a shell.

## 5. Supply chain

- Models download over HTTPS from pinned URLs, with SHA-256 checks pinned in the source. A mismatch disables the feature. This download is the only network call in the default configuration: it happens once, when voice approval is enabled and sox and whisper-cli are installed, and it sends nothing about the user or their sessions. Turning voice approval off, or providing the model yourself (`READBACK_MODEL`), avoids it.
- The opt-in Haiku summarizer (`summarizer = "claude-haiku"`) sends the message text to Anthropic through the user's own `claude` CLI and account. It is off by default, and the README says so where it is described.
- **No runtime npm dependencies.** The config's TOML subset is parsed in-house, and tests use the built-in `node:test`. Dev-only dependencies: `typescript` and `@types/node`, pinned, lockfile committed, installed with `--ignore-scripts`. Dependabot enabled.
- Releases are tagged and signed. The marketplace entry points to tagged versions.

## 6. Privacy

| Data | Where it goes (defaults) | Opt-in changes |
|---|---|---|
| Claude's final message | Stays in daemon memory; summarized locally | `claude-haiku` sends it to Anthropic via the user's own Claude Code login (same destination Claude Code already uses) |
| Spoken text | Local TTS engine | Cloud TTS sends the summary text to OpenAI/ElevenLabs, with a first-use warning |
| Microphone audio | Captured only during an answer window, processed locally, never stored | none |
| Logs | Event types, timings and decisions; no message text | `debug = true` logs text locally |
| Telemetry | None | none |

## 7. Security review checklist (per release)

- [ ] All failure-path tests in the broker suite pass (no decision on every error).
- [ ] Negative audio set: 0 false allows.
- [ ] `never_by_voice` defaults unchanged, or the change has been reviewed.
- [ ] No new network calls in the default configuration (`test/no-network.test.mjs`, and the CI job with network disabled). The only allowed call is the pinned model download on first enable.
- [ ] Model SHA-256 pins verified.
