# ADR-0004: Stop speech with `/readback:stop`

- Status: Accepted
- Date: 2026-11-24

## Context
The user wants a command to stop speech. `/stop` is already a built-in Claude Code command ("Stop the background session you're attached to"). Plugin commands are namespaced as `/<plugin>:<name>`. No hook fires when `/voice` dictation starts.

## Decision
- `/readback:stop` stops playback and clears the queue. The UserPromptSubmit hook handles it locally and blocks it with `suppressOriginalPrompt`, so it never reaches Claude.
- Any submitted prompt also stops speech.
- A global hotkey is planned for v0.2 (FR-37).

## Consequences
- There is no clash with built-ins and no token cost.
- The user cannot stop speech by starting dictation, only by submitting a prompt or typing the command. Short utterances keep this tolerable.
- M0 must confirm that blocking works for typed plugin commands. The fallback is the `UserPromptExpansion` hook.
