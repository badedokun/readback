# Contributing to Readback

Thanks for helping. Readback is a small community project, and contributions of every size are welcome.

## Good first contributions

- **Speech-rule misses.** Paste a Claude message that was spoken badly, along with what it should have said. Each one becomes a golden test case.
- **New voice engines.** Implement the `speak(text, opts)` / `stop()` interface in `src/daemon/tts/`. That is about 50 lines, plus one smoke test.
- **Docs and setup guides** for your platform.

## Ground rules

- Read [docs/04-security-privacy.md](docs/04-security-privacy.md) before touching the permission broker or the listener. Any path that can produce `allow` needs a reviewer and tests.
- Every failure must fall back to "no decision" or "silent", never to approval.
- No telemetry and no network calls in the default configuration.
- Keep the hook shims light. They have a 50 ms budget.

## Development

```
npm ci
npm test               # unit, golden, contract, queue, broker
npm run lint && npm run typecheck
node docs/diagrams/src/build.mjs   # regenerate diagrams after editing them
```

## Pull requests

- Link the requirement or issue ID (for example FR-21).
- Add or update tests and keep CI green on macOS and Linux.
- Update the docs if behaviour changes.

## Code of conduct

This project follows the [Contributor Covenant 2.1](https://www.contributor-covenant.org/version/2/1/code_of_conduct/).
