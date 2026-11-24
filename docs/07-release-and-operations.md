# Readback — Release, Distribution and Maintenance

| | |
|---|---|
| Version | 1.0 |
| Date | 2026-11-24 |

## 1. Distribution

- **Repository:** public GitHub repo `readback`, MIT license. The owner account is decided at publish time.
- **Marketplace:** the repo hosts its own `.claude-plugin/marketplace.json`, so users install with:
  ```
  claude plugin marketplace add <owner>/readback
  claude plugin install readback@readback
  ```
- **Community listing:** after v0.1, submit to community plugin directories and the awesome-claude-code lists.

## 2. Versioning

Semantic versioning:

- **MAJOR:** a config key is removed or renamed, or a default safety behaviour changes.
- **MINOR:** a new engine, command or mode.
- **PATCH:** fixes and speech-rule improvements.

`plugin.json` `version` and the git tag must match. CI fails the release if they don't.

## 3. Release process

1. Update `CHANGELOG.md` (Keep a Changelog format).
2. Pass the release gates:
    - CI green on the macOS and Linux matrix.
    - Audio-set results attached to the release PR.
    - Security checklist ticked ([04-security-privacy.md](04-security-privacy.md) §7).
    - Dogfood note written.
3. Tag `vX.Y.Z` (signed) and push. A GitHub Actions release job builds `bin/` and the daemon bundle, verifies the version match, and creates a GitHub Release with notes.
4. Update the "tested with Claude Code" range in the README from the nightly contract job.

## 4. CI pipelines

| Workflow | Trigger | Jobs |
|---|---|---|
| `ci.yml` | PR, push to main | lint, typecheck, unit, golden, contract, queue/broker, engine smoke (macOS + Ubuntu), no-network test |
| `nightly-contract.yml` | Daily | Install latest Claude Code, record hook payloads, diff against fixtures, open an issue on drift |
| `release.yml` | Tag `v*` | Build, verify, publish the GitHub Release |

## 5. Support and maintenance

- **Issue templates:** bug, speech-rule miss (paste the message and what was said), new engine, Claude Code compatibility.
- **Compatibility policy:** support the latest Claude Code and the previous minor version. When the nightly job flags drift, fix it within 7 days or pin the README range.
- **Security reports:** `SECURITY.md` with a private advisory channel (GitHub Security Advisories). A false-approval bug is treated as high severity.
- **Deprecation:** config keys get one minor release of warning before removal.

## 6. Upstreaming

If Claude Code adds native spoken replies, Readback will:

1. Contribute the speech rules and the golden corpus upstream (an issue or discussion on anthropics/claude-code).
2. Keep only the features that are still missing, such as voice approval, or archive the repo with a pointer to the native feature.

## 7. Operational runbook (user-facing troubleshooting)

| Symptom | Check |
|---|---|
| No speech at all | `/readback:status`; run `/readback:test`; check the system volume and output device |
| Speech but no voice approval | `/readback:test`. Is sox or whisper-cpp missing? Is mic permission granted to the terminal app? |
| Speech plays on the wrong machine | You are in an SSH session. Readback disables itself there by design. |
| Daemon stuck | `pkill -f readback-daemon`. The next hook restarts it. |
| Something spoken badly | File a "speech-rule miss" issue with the message text |
