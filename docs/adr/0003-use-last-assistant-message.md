# ADR-0003: Summarize `last_assistant_message`, never read the transcript

- Status: Accepted
- Date: 2026-11-24

## Context
The Stop hook input includes `transcript_path` and `last_assistant_message`. The Claude Code hooks reference says to "use this field rather than reading `transcript_path`: the transcript file isn't guaranteed to include the final message at Stop time on all versions". Issues report flush races (#74340, #15812, #15813, #40655), and the transcript JSONL schema is undocumented.

## Decision
Readback uses only `last_assistant_message` and never opens the transcript.

## Consequences
- Readback is reliable across Claude Code versions and avoids parsing an undocumented format.
- Summaries see only the final message, not earlier text in the turn. That is acceptable, because the final message is what the user would read.
