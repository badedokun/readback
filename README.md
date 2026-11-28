# Readback

**Hear Claude Code.** Readback is a free, open-source Claude Code plugin that speaks a one- or two-sentence summary when Claude finishes, tells you when Claude needs you, and lets you approve or deny permission prompts by voice.

```
You:      (hold space) "Add rate limiting to the login route and run the tests."
Readback:  "Claude wants to run npm test. Allow?"
You:      "Allow."
Readback:  "Added a rate limiter to the login route. Tests pass. Want me to commit?"
```

## How it works

- **You talk** with Claude Code's built-in `/voice` dictation.
- **Readback speaks** through Claude Code hooks: a short summary at the end of each turn, plus alerts when Claude is idle or needs permission. It never reads code, diffs or paths aloud.
- **You answer permission prompts by voice:** "allow", "deny", or "show me". Anything unclear, and any protected command, falls back to the normal keyboard dialog.
- **Stop it** with `/readback:stop`, or by sending any prompt.
- **Local by default.** It uses your system voice (`say` on macOS, Piper or espeak-ng on Linux), and nothing about your sessions leaves your machine.

![Architecture](docs/diagrams/01-system-context.png)

## Status

**M2 in progress (v0.1). Voice approval is beta:** in 2,492 recorded test answers on macOS it never approved by mistake, but it missed about 3 in 10, which then fall back to the keyboard (test plan §4). Spoken turn summaries, attention alerts, `/readback:*` commands and voice approval work on macOS and pass the live acceptance run (`spike/run_m1_live.py`). Linux engines and the Linux listener pass their smoke tests. The marketplace install arrives with v0.1.

## Install

In Claude Code (2.1.275 or later):

```
/plugin install readback --marketplace badedokun/readback
```

Or from a shell: `claude plugin marketplace add badedokun/readback`, then `claude plugin install readback@readback`. To run from a clone instead: `claude --plugin-dir /path/to/readback`.

Then type `/readback:test`.

**macOS:** speech works out of the box. For voice approval, `brew install sox whisper-cpp`. macOS asks your terminal for microphone access the first time you answer by voice.

**Linux:** install `espeak-ng` for speech, or [Piper](https://github.com/rhasspy/piper) for a natural voice (`pip install piper-tts`, then put a voice's `.onnx` and `.onnx.json` in `~/.local/share/readback/voices/`). For voice approval you need `pulseaudio-utils` (works with PipeWire too) and `whisper-cli` built from [whisper.cpp](https://github.com/ggml-org/whisper.cpp).

With voice approval available, the first session downloads the speech model once: Whisper `base.en` (148 MB) on macOS, `tiny.en` (75 MB) on Linux. The URL is pinned and the SHA-256 checked. When Claude asks for permission, Readback reads the request aloud. Say **"yes"** or **"no"**, or just answer on screen: the keyboard always wins. Destructive commands (`rm -rf`, `git push --force`, `sudo`, …) are never approved by voice.

## Configure

Commands work in any session: `/readback:stop`, `/readback:mute`, `/readback:unmute`, `/readback:mode alerts|brief|chatty`, `/readback:voice <name>`, `/readback:rate <words per minute>`, `/readback:repeat`, `/readback:status`, `/readback:test`. Add `--save` to `mode`, `voice` or `rate` to keep the setting.

Settings live in `~/.config/readback/config.toml`:

```toml
mode = "brief"              # alerts | brief | chatty
engine = "auto"             # auto | say | piper | espeak
voice = ""                  # engine voice; empty = the engine's default
rate = 190                  # words per minute
summarizer = "rules"        # rules | claude-haiku | off
min_turn_seconds = 10       # brief mode: stay quiet for quick turns
quiet_hours = ""            # e.g. "22:00-07:00"; permission prompts still speak
voice_approval = true
never_by_voice = []         # extra regexes that always need the keyboard
```

A project can add `.claude/readback.toml`, but it may only set `mode`, `min_turn_seconds`, `voice_approval` (only to turn it off) and extra `never_by_voice` patterns.

**Privacy.** With the default settings nothing about your sessions leaves your machine. The only network call is the one-time model download above. `summarizer = "claude-haiku"` is opt-in: it sends each final message to Claude Haiku through your own `claude` CLI and account, for a more natural summary (about 1 second per turn).

## Develop

```bash
npm install            # dev only: typescript + @types/node for the type check
npm test               # unit, golden, contract, end-to-end and no-network tests (no audio)
npm run typecheck
node test/smoke/engines.mjs    # each local TTS engine speaks one line
node test/audio/record-sets.mjs <dir> && node test/audio/score-sets.mjs <dir> <model.bin>   # voice-approval audio sets (macOS, test plan §4)
python3 spike/run_m1_live.py   # live run: real Claude Code, speakers and mic (~5 min)
```

Readback has **no runtime dependencies**. It is plain ES modules with JSDoc types, so the plugin runs straight from the repository with no build step.

## Documentation

| Doc | Contents |
|---|---|
| [01 Requirements](docs/01-requirements.md) | Functional and non-functional requirements, speech rules, acceptance criteria |
| [02 Architecture](docs/02-architecture.md) | Context, components, hook map, flows, risks |
| [03 Detailed design](docs/03-detailed-design.md) | Hook contracts, IPC protocol, summarizer, queue, broker, listener, config |
| [04 Security and privacy](docs/04-security-privacy.md) | Voice-approval threat model, IPC, supply chain, privacy |
| [05 Test plan](docs/05-test-plan.md) | Golden corpus, traceability matrix, audio release gates |
| [06 Implementation plan](docs/06-implementation-plan.md) | Milestones M0–M3 with gates |
| [07 Release and operations](docs/07-release-and-operations.md) | Distribution, versioning, CI, support, troubleshooting |
| [ADRs](docs/adr/) | Key decisions and why |
| [Diagrams](docs/diagrams/) | SVG + PNG. Regenerate with `node docs/diagrams/src/build.mjs` |

## License

MIT. See [LICENSE](LICENSE).
