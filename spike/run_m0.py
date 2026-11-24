#!/usr/bin/env python3
"""Scripted M0 spike: drives a real interactive `claude` TUI through a pseudo-terminal.

Each scenario starts a fresh `claude` process with the capture plugin, types a prompt,
optionally presses a key when the approval dialog appears, then checks the outcome from
the hook logs and the filesystem. Nothing here depends on parsing the TUI's screen.

Usage:  python3 spike/run_m0.py [scenario ...]      (default: all)
Output: spike/fixtures/raw/run-<timestamp>/{<scenario>/..., results.json}
"""
import fcntl, json, os, pty, select, signal, struct, sys, termios, time
from datetime import datetime
from pathlib import Path

SPIKE = Path(__file__).resolve().parent
PLUGIN = SPIKE / "capture-plugin"
PLAY = Path.home() / "readback-spike-play"      # already a trusted folder
RUN = SPIKE / "fixtures" / "raw" / f"run-{datetime.now():%Y%m%d-%H%M%S}"
PROBE = PLAY / "probe.txt"
SETTINGS = json.dumps({"permissions": {"ask": ["Write", "Bash"]}})
WRITE_PROMPT = ("Use only the Write tool to create the file probe.txt containing: hi. "
                "Do not use any other tool. If it is denied, say DENIED and stop.")
ESC, ENTER = "\x1b", "\r"


class Session:
    """One interactive claude process on a pty."""

    def __init__(self, name, mode):
        self.dir = RUN / name
        self.dir.mkdir(parents=True)
        self.screen = open(self.dir / "screen.raw", "wb")
        env = dict(os.environ, TERM="xterm-256color",
                   READBACK_SPIKE_DIR=str(self.dir), READBACK_SPIKE_MODE=mode)
        argv = ["claude", "--plugin-dir", str(PLUGIN), "--permission-mode", "default",
                "--model", "haiku", "--settings", SETTINGS]
        self.pid, self.fd = pty.fork()
        if self.pid == 0:
            os.chdir(PLAY)
            os.execvpe(argv[0], argv, env)
        fcntl.ioctl(self.fd, termios.TIOCSWINSZ, struct.pack("HHHH", 45, 140, 0, 0))

    def pump(self, seconds):
        end = time.time() + seconds
        while time.time() < end:
            r, _, _ = select.select([self.fd], [], [], 0.1)
            if r:
                try:
                    self.screen.write(os.read(self.fd, 65536))
                except OSError:
                    return

    def send(self, text):
        for ch in text:                      # typed, not pasted
            os.write(self.fd, ch.encode())
            self.pump(0.02)

    def say(self, prompt):
        self.send(prompt)
        self.pump(0.3)
        self.send(ENTER)

    def rows(self, event):
        f = self.dir / f"{event}.jsonl"
        return [json.loads(l) for l in f.read_text().splitlines() if l] if f.exists() else []

    def decisions(self):
        f = self.dir / "PermissionRequest.decisions.jsonl"
        return [json.loads(l) for l in f.read_text().splitlines() if l] if f.exists() else []

    def wait_for(self, pred, timeout, label):
        end = time.time() + timeout
        while time.time() < end:
            if pred():
                return True
            self.pump(0.2)
        print(f"    ! timed out waiting for {label}")
        return False

    def ready(self):
        ok = self.wait_for(lambda: self.rows("SessionStart"), 30, "SessionStart")
        self.pump(3)                         # let the input box render
        return ok

    def close(self):
        for _ in range(2):
            self.send("\x03")
            self.pump(0.5)
        self.pump(2)
        try:
            os.kill(self.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        try:
            os.waitpid(self.pid, 0)
        except ChildProcessError:
            pass
        self.screen.close()


def notif(s, kind):
    return [r for r in s.rows("Notification") if r["input"].get("notification_type") == kind]


def write_turn(s, key=None, key_on="permission_prompt"):
    """Ask for the Write; optionally press `key` as soon as the dialog notification fires."""
    PROBE.unlink(missing_ok=True)
    t0 = time.time()
    s.say(WRITE_PROMPT)
    s.wait_for(lambda: s.rows("PermissionRequest"), 60, "PermissionRequest")
    t_req = time.time()
    pressed_at = None
    if key:
        if s.wait_for(lambda: notif(s, key_on), 30, key_on):
            s.pump(0.5)
            s.send(key)
            pressed_at = round(time.time() - t_req, 2)
    s.wait_for(lambda: s.rows("Stop"), 90, "Stop")
    s.pump(1)
    lam = (s.rows("Stop") or [{}])[-1].get("input", {}).get("last_assistant_message", "")
    req = s.rows("PermissionRequest")
    prompt_notes = notif(s, "permission_prompt")
    dialog_after = None
    if prompt_notes and req:
        dialog_after = round((datetime.fromisoformat(prompt_notes[0]["ts"].replace("Z", "+00:00"))
                              - datetime.fromisoformat(req[0]["ts"].replace("Z", "+00:00"))).total_seconds(), 2)
    return {
        "tools_requested": [r["input"].get("tool_name") for r in req],
        "hook_decisions": [{k: d[k] for k in ("mode", "tool", "waited_ms")} for d in s.decisions()],
        "hook_finished": len(s.decisions()) == len(req) and bool(req),
        "dialog_shown": bool(prompt_notes),
        "dialog_after_s": dialog_after,
        "key_pressed_after_s": pressed_at,
        "file_created": PROBE.exists(),
        "reply_says_denied": "DENIED" in lam,
        "turn_s": round(time.time() - t0, 1),
    }


# ---------------------------------------------------------------- scenarios
def sc_allow(s):
    r = write_turn(s)
    r["pass"] = r["file_created"] and not r["dialog_shown"] and r["hook_finished"]
    return r

def sc_deny(s):
    r = write_turn(s)
    r["pass"] = not r["file_created"] and not r["dialog_shown"] and r["hook_finished"]
    return r

def sc_none(s):
    r = write_turn(s, key=ENTER)                          # dialog default = Yes
    r["pass"] = r["dialog_shown"] and r["file_created"]
    return r

def sc_wait20(s):
    r = write_turn(s, key=ENTER)                          # answer the dialog by keyboard
    r["pass"] = r["dialog_shown"] and r["file_created"]
    return r

def sc_keyboard_no_vs_late_allow(s):
    # The race that matters: user presses No on screen; the hook later returns allow.
    r = write_turn(s, key=ESC)
    s.pump(22)                                            # outlive the hook's 20 s wait
    r["file_created"] = PROBE.exists()
    r["hook_decisions"] = [{k: d[k] for k in ("mode", "tool", "waited_ms")} for d in s.decisions()]
    r["hook_finished"] = bool(r["hook_decisions"])
    r["pass"] = not r["file_created"]                     # late allow must NOT win
    return r

def sc_late_allow_no_key(s):
    # Nobody touches the keyboard; the hook answers allow at 20 s while the dialog is up.
    r = write_turn(s)
    r["pass"] = r["file_created"] and r["hook_finished"]
    return r

def sc_stop_command(s):
    before = len(s.rows("Stop"))
    s.say("/readback:stop")
    s.pump(8)
    hits = [json.loads(l) for l in (s.dir / "prompt.intercepts.jsonl").read_text().splitlines()
            if json.loads(l).get("hit")] if (s.dir / "prompt.intercepts.jsonl").exists() else []
    stops = len(s.rows("Stop")) - before
    return {"intercepted": len(hits), "claude_replied": stops > 0,
            "pass": len(hits) >= 1 and stops == 0}

def sc_turns(s, n=5):
    for i in range(n):
        before = len(s.rows("Stop"))
        s.say(f"Reply with one short sentence about the number {i + 3}.")
        s.wait_for(lambda: len(s.rows("Stop")) > before, 60, f"Stop {i}")
        s.pump(3)                                         # let the 2 s compare finish
    f = s.dir / "Stop.compare.jsonl"
    rows = [json.loads(l) for l in f.read_text().splitlines()] if f.exists() else []
    return {"turns": len(rows), "with_lam": sum(r["has_lam"] for r in rows),
            "transcript_match_at_stop": sum(r["transcript_at_stop_matches"] for r in rows),
            "transcript_match_after_2s": sum(r["transcript_after_2s_matches"] for r in rows),
            "pass": len(rows) == n and all(r["has_lam"] for r in rows)}


SCENARIOS = {
    "allow": ("allow", sc_allow),
    "deny": ("deny", sc_deny),
    "none": ("none", sc_none),
    "wait20": ("wait20", sc_wait20),
    "keyboard_no_vs_late_allow": ("wait20:allow", sc_keyboard_no_vs_late_allow),
    "late_allow_no_key": ("wait20:allow", sc_late_allow_no_key),
    "stop_command": ("none", sc_stop_command),
    "turns": ("none", sc_turns),
}


def main():
    names = sys.argv[1:] or list(SCENARIOS)
    PLAY.mkdir(exist_ok=True)
    RUN.mkdir(parents=True)
    results = {}
    for name in names:
        mode, fn = SCENARIOS[name]
        print(f"== {name} (mode={mode})", flush=True)
        s = Session(name, mode)
        try:
            results[name] = fn(s) if s.ready() else {"pass": False, "error": "session did not start"}
        except Exception as e:                            # keep going; record the failure
            results[name] = {"pass": False, "error": repr(e)}
        finally:
            s.close()
            PROBE.unlink(missing_ok=True)
        print("   ", json.dumps(results[name]), flush=True)
    (RUN / "results.json").write_text(json.dumps(results, indent=2) + "\n")
    print(f"\n{sum(r['pass'] for r in results.values())}/{len(results)} passed. Details: {RUN}")


if __name__ == "__main__":
    main()
