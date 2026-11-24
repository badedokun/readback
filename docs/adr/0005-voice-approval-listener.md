# ADR-0005: A dedicated closed-vocabulary listener for voice approval

- Status: Accepted
- Date: 2026-11-24

## Context
The user decided voice approval is in scope. Native `/voice` only writes into the prompt box; it cannot answer a permission dialog. The PermissionRequest hook can return `behavior: allow|deny`, and a synchronous command hook can wait (default timeout 600 s, which Readback sets to 30 s).

## Decision
While a PermissionRequest is open, the daemon opens the mic after the spoken prompt ends, for up to 20 s. It records with sox and recognises speech with whisper.cpp `tiny.en`. It accepts only a 1–3 word utterance that exactly matches the allow, deny or defer vocabulary, with confidence of 0.6 or more. Everything else produces no decision, so the normal dialog appears.

## Alternatives considered
- **Vosk with a grammar.** Its native grammar support is good, but its Node bindings are poorly maintained.
- **The macOS Speech framework.** It is not cross-platform.
- **Cloud speech-to-text.** It breaks the privacy default.

## Consequences
- **Verified in M0 (2026-11-24, Claude Code 2.1.330).** The dialog appears about 6 s into the hook's wait; answering it kills the hook; a hook decision sent while the dialog is up (no keypress) is applied. So voice and keyboard race, and the keyboard is final once pressed. The broker cancels on socket close and never applies a late answer (FR-24a, FR-24b).
- Voice approval needs extra installs (sox, whisper-cpp, a 75 MB model). Speech output works without them.
- Safety rests on the fail-closed design, the `never_by_voice` list, and the zero-false-allow release gate.
