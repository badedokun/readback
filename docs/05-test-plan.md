# Readback — Test Plan

| | |
|---|---|
| Version | 1.0 |
| Date | 2026-11-24 |
| Framework | Node's built-in `node:test` (no test dependencies). Node scripts for the engine, listener and audio-set runs. |

## 1. Strategy

Most behaviour is tested as text, with no audio. The TTS adapter and the listener are mocked behind their interfaces. Real-audio tests are limited to engine smoke tests and the voice-approval audio sets.

| Level | What | Runs |
|---|---|---|
| Unit | Sanitizer, summarizer rules, vocabulary matcher, config merge | Every PR |
| Golden | Speech corpus: message → expected utterance | Every PR |
| Contract | Recorded hook payloads → shim output and IPC messages | Every PR, plus nightly against the latest Claude Code |
| Component | Queue, broker state machine (fake clock, fake listener) | Every PR |
| Engine smoke | Each TTS engine speaks one line into a null sink, and cancel stops it in < 150 ms with no process left (`test/smoke/engines.mjs`) | Every PR (Linux runner; `say` locally) |
| Listener loop | Piper speaks the vocabulary into a PulseAudio null sink; the real listener records its monitor (`test/smoke/linux-listener.sh`) | Every PR (Linux runner) |
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
| TC-50 | Default config makes no network connections: every process is preloaded with a guard that records any TCP, DNS or fetch (`test/no-network.test.mjs`), and CI also runs the suite in a network namespace with no interfaces. The one exception is the pinned model download on first enable. | NFR-06 |
| TC-51 | Logs contain no message text with `debug = false` | NFR-06 |
| TC-60 | Turn end → first audio p95 < 600 ms over 50 runs | NFR-02 |

## 4. Voice-approval audio sets (release gate)

| Set | Contents | Pass criterion |
|---|---|---|
| Positive | 3 speakers × 9 phrases × 3 mic distances (laptop mic, 0.5 m, 2 m) | ≥ 95% correct decision |
| Negative | Readback's own prompts played back, office chatter, podcast audio, partial phrases ("yes but wait", "no idea") | **0 false allows**; false denies ≤ 1% |
| Noise | Fan, keyboard typing, music at 60 dB | ≥ 90% correct; 0 false allows |

### Method

One tester can't supply the speaker range this needs, so the sets use synthetic speech that is as close to real voices as we can get:

- **28 speakers.** 12 L2-ARCTIC speakers, non-native English: a man and a woman each with Arabic, Mandarin, Hindi, Korean, Spanish and Vietnamese as first language. 6 LibriTTS-R speakers (US). Scottish (alba), northern English, two Semaine speakers (UK) and Ryan (US). Five macOS `say` voices. Every speaker except `say` is a Piper voice trained on recordings of real people, pinned to rhasspy/piper-voices `5ec43b18`, at a fixed pace of 0.9–1.1×.
- **Distance:** near is the clip as is. Mid is volume 0.45, a 7 kHz low-pass and moderate room reverb. Far is volume 0.2, a 4.5 kHz low-pass and heavy reverb.
- **Two steps:**
  1. `record-sets.mjs` plays each trial through the laptop speakers and records exactly what the built-in mic hears. Speaker volume is fixed at 50%; the run stops if it changes. The room is at −62 dBFS.
  2. `score-sets.mjs` replays the recordings through the real `Listener.listen()` with a fake microphone, once per model. Models are compared on identical audio.

### Results: 2026-11-27, 2,492 trials per model

| Set | Gate | `tiny.en` (bar 0.6) | `base.en` (bar 0.5) | `small.en` (bar 0.5) |
|---|---|---|---|---|
| Positive (14 phrases × 28 speakers × 3 distances = 1,176) | ≥ 95% correct | 70.7% | 71.7% | 80.6% |
| Negative (24 phrases × 28 = 672) | 0 false allows, ≤ 1% false denies | **1 false allow**, 20 false denies (3.0%) | **0 false allows**, 12 false denies (1.8%) | **3 false allows**, 13 false denies (1.9%) |
| Noise (pink noise, 23 phrases × 28 = 644) | ≥ 90%, 0 false allows | 78.7%, 0 false allows | 80.9%, 0 false allows | 84.6%, **2 false allows** |

The bar is each model's minimum confidence for an allow (deny and defer accept 0.4). base.en was also scored at 0.6: 70.3% positive, the same 0 false allows.

Positive results by group (base.en):
- **Answer type:** allow 53%, deny 78%, defer 87%.
- **Speakers:** LibriTTS-R (US) 91%, `say` 81%, UK/US others 70%, L2 accents 55% (at bar 0.6).
- **Distance:** near 73%, mid 72%, far 70%. Distance is no longer the problem.

Every trial is in `test/audio/results/2026-11-27-28-speakers-{tiny,base,small}-en.json`. The recordings themselves (288 MB) stay out of the repository.

What we learned:
- **False allows.** The first scoring pass, before the M2 listener changes below, had one per model:
  - tiny.en heard "yesterday" as "Yes, 30.", and the matcher dropped the digits.
  - Both models heard the tail of "The build is green and all tests pass" (northern English) as a separate "Yes."

  Both are fixed and have tests. The one left is tiny.en hearing a Mandarin-accented "allowance" as "Allow." at 0.87, which no listener rule can catch. **base.en: 0 false allows in 2,492 trials.**
- **Allow is the hard answer.** Of base.en's 280 allow misses, 194 were misheard ("Hello", "Yes, hello", "Up" for approve, "Allah", "Alone", "Cheers"). 58 heard the right word under 0.6 confidence (at the earlier 0.6 bar). 28 heard the right word but after unclear speech, so the safety rule rejected it. None heard nothing.
- **Most false denies are "denial" heard as "Deny."** A few are a stray "No." after other speech ("Yes, please do it" then "No.").
- **Changes made from this data:**
  - Every answer phrase is now in the speech-model hint ("wait" had been written as "We", "don't" as "Done").
  - Deny and defer accept confidence 0.4, since they only hand back to the keyboard; allow keeps the model's own bar (0.5 for base.en, 0.6 for tiny.en).
  - An allow is rejected if unclear speech came before it in the window, or if the transcript contains digits.
  - "approved" counts as allow.

  Together these took positive accuracy from 57% to 71% with no new false allows.
- **small.en is more accurate but not safe.** It approved 5 times by mistake, all at high confidence (0.92–0.99): "allowance" heard as "Allow." (4 times, Mandarin and Vietnamese accents) and "approve it later maybe" heard as "Approve." Raising the allow bar to 0.8 removes none of them, so small.en is not used. It is also larger (488 MB) and slower.
- **Model speed per clip:** on Apple silicon, 0.6 s for tiny.en, 0.5–0.65 s for base.en and 0.7 s for small.en. On a 4-thread Linux CPU (Docker), 4.2 s for tiny.en and 10.2 s for base.en.

**Gate status: not passing.** Safety passes with base.en (0 false allows). Accuracy (72% / 81%) and false denies (1.8%) do not. Voice approval in v0.1 is labelled beta, and every miss falls back to the keyboard dialog.

How to run each level:

| Level | Command |
|---|---|
| Unit, golden, contract, component, TC-50 | `npm test` |
| Engine smoke | `node test/smoke/engines.mjs` (Linux: `docker build -f test/smoke/linux.Dockerfile -t readback-linux . && docker run --rm readback-linux`) |
| Listener loop (Linux) | `docker build -f test/smoke/listener.Dockerfile -t readback-linux-listener . && docker run --rm readback-linux-listener` |
| Audio sets (macOS, speakers on) | `PIPER=<piper> node test/audio/record-sets.mjs <dir>` (about 2.5 h, out loud), then `node test/audio/score-sets.mjs <dir> <model.bin>` (silent, about 30 min per model) |
| Live acceptance in real Claude Code sessions | `python3 spike/run_m1_live.py` |

## 5. Contract tests against Claude Code

- `test/contract/fixtures/<cc-version>/<event>.json` holds hook payloads recorded with a logging hook.
- A nightly CI job (`.github/workflows/nightly.yml`) installs the latest Claude Code, records fresh payloads with the synchronous recorder plugin in `test/contract/recorder/`, and diffs them with `test/contract/shape-diff.mjs`. A field Readback reads that is missing or has changed type opens an issue automatically; new fields are reported only. Under `claude -p` only SessionStart, UserPromptSubmit, Stop and SessionEnd fire (M0), so PermissionRequest and Notification are checked by the live driver before each release. The job needs the `ANTHROPIC_API_KEY` repository secret and is skipped without it.
- The README's "tested with Claude Code x.y–x.z" line is updated from this job.

## 6. Exit criteria for v0.1

- All TC-xx tests mapped to **M** requirements pass on macOS and Linux.
- The audio-set gates pass.
- A dogfood session is completed and logged in the release notes.
- The security checklist in [04-security-privacy.md](04-security-privacy.md) §7 is ticked.
