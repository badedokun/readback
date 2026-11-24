# M0 spike

A throwaway plugin (named `readback`) that logs every hook payload and checks the hook behaviour the design depends on. See [docs/06-implementation-plan.md](../docs/06-implementation-plan.md) §M0.

- `capture-plugin/`: the plugin. `bin/capture.mjs` is the only code.
- `fixtures/raw/`: captured payloads. This folder is gitignored because it holds real session data. Scrub fixtures before promoting them to test fixtures.
- `report.mjs`: summarises the captures.
- `.mode` (gitignored): the PermissionRequest behaviour, read on every call. Values: `allow`, `deny`, `none` or `wait20`.

## Results (Claude Code 2.1.330, 2026-11-24): M0 gate passed

Run it yourself: `python3 spike/run_m0.py`. It drives a real interactive `claude` TUI through a pty, uses Haiku, and takes about 6 minutes. Results go to `fixtures/raw/run-*/results.json`.

| # | Check | Result |
|---|---|---|
| 1 | Capture payloads | ✅ All events captured. Notification types seen: `permission_prompt` and `idle_prompt`. |
| 2 | Stop has `last_assistant_message` | ✅ 27 of 27. The transcript matched at Stop time in only 2 of 22 manual turns; in the scripted runs the transcript file was **never created**. ADR-0003 holds. |
| 3 | PermissionRequest allow / deny / none | ✅ allow: no dialog, tool ran. deny: no dialog, tool blocked, Claude told. none: normal dialog. Each hook took 2–3 ms. The hook fires only when a dialog *would* appear, so allowlisted tools never reach it; it never fires in `-p`. |
| 4 | `/readback:stop` is blocked | ✅ Intercepted on UserPromptSubmit; Claude never replies. |
| 5 | Sync PermissionRequest can wait 20 s | ✅ 20,008 ms. **But:** Claude Code shows the dialog at **6.0 s** while the hook is still waiting. Answering on screen **kills the hook**, and a late `allow` is never applied. A hook decision sent while the dialog is up, with no keypress, **is** applied. |
| 6 | Speak from an async Stop hook | ✅ Interactive: works. Headless `-p`: the hook is cancelled after 7 ms. Stop does not fire when the user interrupts with Esc. |

Design docs updated: FR-24a/24b, the detailed design §7 (CANCELLED state), and ADR-0003/0005.

## Manual steps (superseded by `run_m0.py`)

Run this in a scratch directory, not in a real repo:

```bash
mkdir -p ~/readback-spike-play && cd ~/readback-spike-play
claude --plugin-dir ~/readback/spike/capture-plugin --permission-mode default
```

1. **Stop and speech (#2, #6):** have about 20 normal exchanges. Each time a reply finishes, you should hear its last sentence.
2. **Stop command (#4):** while it is speaking, type `/readback:stop`. You should hear "Stopped.", and Claude should not reply. If Claude replies `HOOK-MISSED`, the intercept failed.
3. **Permissions (#3, #5):** in a second terminal, write the mode to the file, then ask Claude to run a command that needs approval, for example *"create a file probe.txt containing hi"*:
   - `echo allow > ~/readback/spike/.mode`: no dialog appears and the file is created.
   - `echo deny > ~/readback/spike/.mode`: no dialog appears and Claude is told "Denied by readback spike".
   - `echo none > ~/readback/spike/.mode`: the normal dialog appears.
   - `echo wait20 > ~/readback/spike/.mode`: about 20 s pass, then the normal dialog appears, with no error.
4. **Notification:** leave Claude idle at the prompt for at least 60 s.
5. Exit, then run `node ~/readback/spike/report.mjs`.
