# Readback — Implementation Plan

| | |
|---|---|
| Version | 1.0 |
| Date | 2026-11-24 |
| Start date | Not scheduled. The build is deferred by decision on 2026-11-24. |

Milestones run in order. Each has a gate that must pass before the next one starts. Effort assumes one developer working with Claude Code.

## M0 — Spike (≈ 1 day)

Goal: prove the hook facts this design depends on.

- [x] Write a capture plugin that logs the stdin of every hook event to a file. Record fixtures for Stop, Notification, PermissionRequest, UserPromptSubmit and SessionStart/End.
- [x] Confirm that Stop carries `last_assistant_message` and that it matches the visible final reply in 20 turns.
- [x] Confirm the PermissionRequest output schema: return allow, then deny, then nothing, and observe the dialog behaviour.
- [x] Confirm that typing `/readback:stop` reaches UserPromptSubmit and that `decision:block` + `suppressOriginalPrompt` keeps it from Claude. If not, test `UserPromptExpansion`.
- [x] Confirm a sync PermissionRequest hook can wait 20 s without side effects.
- [x] Speak `last_assistant_message`'s last sentence with `say` from an async Stop hook.

**Gate:** all six confirmed, or the design docs updated with the workarounds. **Passed 2026-11-24.** See [spike/README.md](../spike/README.md).

## M1 — macOS alpha (≈ 1 week)

- [ ] Shim and daemon skeleton: IPC, lock file, lifecycle (SessionStart/End).
- [ ] Rules summarizer and sanitizer, plus 30 golden cases.
- [ ] Speech queue (priority, dedupe, newest wins, barge-in) and the `say` engine.
- [ ] Notification alerts.
- [ ] Commands: stop, mute, unmute, mode, repeat, test, status.
- [ ] Permission broker: describe, gate, and announce-only mode.
- [ ] Answer listener: sox + whisper.cpp `tiny.en`, the vocabulary matcher, and confidence handling.
- [ ] Contract tests on the M0 fixtures.

**Gate:** the author uses it daily for 5 working days. There are zero false allows in daily use, and every observed speech miss has been added to the golden corpus.

## M2 — Public v0.1 (≈ 1–2 weeks)

- [ ] Linux support: Piper and espeak-ng engines; PulseAudio/PipeWire capture.
- [ ] Optional Haiku summarizer.
- [ ] Config file and project override, enforcing the safety restrictions.
- [ ] Golden corpus at 100 or more cases.
- [ ] Audio sets recorded, and the release gates passing.
- [ ] CI: macOS and Linux matrix, a no-network test, a nightly contract job.
- [ ] README with a 30-second demo video, install steps, safety notes and a tested-version range.
- [ ] `marketplace.json`; release v0.1.0.

**Gate:** all exit criteria in [05-test-plan.md](05-test-plan.md) §6 are met.

## M3 — v0.2

- [ ] Windows and WSL engines (PowerShell `System.Speech`).
- [ ] Kokoro engine, plus cloud engines (OpenAI, ElevenLabs) behind opt-in.
- [ ] Global stop hotkey (FR-37).
- [ ] Contributor guide for adding engines; issue templates for "speech-rule miss" and "new engine".

## Definition of done (every task)

- Unit and contract tests are added or updated, and CI is green on macOS and Linux.
- No message text appears in logs at the default level.
- The docs (requirements trace, design) are updated if behaviour changed.
