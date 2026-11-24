# ADR-0006: A deterministic rules summarizer by default; Haiku opt-in

- Status: Accepted
- Date: 2026-11-24

## Context
Spoken output must be short, timely, private and testable. An LLM summarizer gives better prose, but adds latency, usage cost and nondeterminism.

## Decision
The default is a rules pipeline: strip, split, score, sanitize, compose. An opt-in `claude-haiku` strategy calls `claude -p --model haiku` with a 4 s timeout and falls back to rules. The sanitizer always runs on any output.

## Consequences
- The default works offline, responds instantly, and can be tested with golden cases.
- Rules will sometimes pick the wrong sentence. The "speech-rule miss" issue template feeds real failures back into the golden corpus.
