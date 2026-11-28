#!/usr/bin/env python3
"""M1 live acceptance run: the real Readback plugin in real interactive Claude Code sessions,
with real `say` output and the real microphone. Voice answers are played through the
speakers with `say`, so the whole path (speaker → mic → sox → whisper → broker → hook) runs.

Usage:  python3 spike/run_m1_live.py [scenario ...]
Needs:  macOS, sox, whisper-cpp, the base.en model (the macOS default) at ~/.cache/readback-dev/models, mic access
        for the terminal running this script, and the speakers on.
"""
import fcntl, json, os, pty, re, select, signal, struct, subprocess, sys, termios, time
from datetime import datetime
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
PLAY = Path.home() / "readback-spike-play"
RUN = REPO / "spike" / "fixtures" / "raw" / f"live-{datetime.now():%Y%m%d-%H%M%S}"
MODEL = Path.home() / ".cache" / "readback-dev" / "models" / "ggml-base.en.bin"
PROBE = PLAY / "probe.txt"
SETTINGS = json.dumps({"permissions": {"ask": ["Write", "Bash"]}})
WRITE_PROMPT = ("Use only the Write tool to create the file probe.txt containing: hi. "
                "Do not use any other tool. If it is denied, say DENIED and stop.")
ESC, ENTER = "\x1b", "\r"
ANSI = re.compile(rb"\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07|\x1b[()][A-Z0-9]")

ENV = {
    "READBACK_SOCKET": str(RUN / "rb.sock"),
    "READBACK_DATA_DIR": str(RUN / "data"),
    "READBACK_CONFIG": str(RUN / "config.toml"),
    "READBACK_MODEL": str(MODEL),
}


def log_events():
    f = RUN / "data" / "readback.log"
    return [json.loads(l) for l in f.read_text().splitlines() if l] if f.exists() else []


def events(name, since=0):
    return [e for e in log_events()[since:] if e["ev"] == name]


class Session:
    def __init__(self, name):
        self.screen_path = RUN / f"{name}.screen"
        self.screen = open(self.screen_path, "wb")
        env = dict(os.environ, TERM="xterm-256color", **ENV)
        argv = ["claude", "--plugin-dir", str(REPO), "--permission-mode", "default",
                "--model", "haiku", "--settings", SETTINGS]
        self.pid, self.fd = pty.fork()
        if self.pid == 0:
            os.chdir(PLAY)
            os.execvpe(argv[0], argv, env)
        fcntl.ioctl(self.fd, termios.TIOCSWINSZ, struct.pack("HHHH", 45, 140, 0, 0))
        self.mark = len(log_events())

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
        for ch in text:
            os.write(self.fd, ch.encode())
            self.pump(0.02)

    def say(self, prompt):
        self.send(prompt)
        self.pump(0.3)
        self.send(ENTER)

    def wait(self, pred, timeout, label):
        end = time.time() + timeout
        while time.time() < end:
            v = pred()
            if v:
                return v
            self.pump(0.2)
        print(f"    ! timed out waiting for {label}", flush=True)
        return None

    def ev(self, name):
        return events(name, self.mark)

    def text(self):
        self.screen.flush()
        return ANSI.sub(b"", self.screen_path.read_bytes()).decode("utf8", "replace")

    def close(self):
        for _ in range(2):
            self.send("\x03")
            self.pump(0.5)
        self.pump(1.5)
        # SIGTERM, then SIGKILL after 5 s: with a permission dialog still open, Claude Code can
        # ignore SIGTERM, and a blocking waitpid hung a whole run.
        try:
            os.kill(self.pid, signal.SIGTERM)
            end = time.time() + 5
            while time.time() < end and os.waitpid(self.pid, os.WNOHANG) == (0, 0):
                self.pump(0.2)
            if os.waitpid(self.pid, os.WNOHANG) == (0, 0):
                os.kill(self.pid, signal.SIGKILL)
                os.waitpid(self.pid, 0)
        except (ProcessLookupError, ChildProcessError):
            pass
        self.screen.close()


def speak_through_speakers(text):
    subprocess.Popen(["say", "-r", "170", text])


def record(seconds, path):
    return subprocess.Popen(["rec", "-q", "-c", "1", "-r", "16000", "-b", "16", str(path), "trim", "0", str(seconds)],
                            stderr=subprocess.DEVNULL)


def transcribe(path):
    out = subprocess.run(["whisper-cli", "-m", str(MODEL), "-f", str(path), "-np", "-nt"],
                         capture_output=True, text=True).stdout
    return " ".join(out.split())


def ready(s):
    # The session is up once the daemon has seen this session's hello (first hook to run).
    ok = s.wait(lambda: Path(ENV["READBACK_SOCKET"]).exists(), 30, "daemon socket")
    s.pump(4)
    return bool(ok)


# ------------------------------------------------------------------ scenarios
def sc_turn_spoken(s):
    wav = RUN / "turn.wav"
    rec = record(30, wav)
    s.say("Reply with exactly this sentence and nothing else: The build is green and all tests pass.")
    s.wait(lambda: s.ev("turn"), 60, "turn")
    s.pump(5)
    rec.terminate(); rec.wait()
    heard = transcribe(wav)
    t = s.ev("turn")
    return {"turn_logged": bool(t), "words_out": t[0].get("words_out") if t else None,
            "mic_heard": heard, "pass": bool(t) and "green" in heard.lower()}


def voice_answer(s, answer):
    PROBE.unlink(missing_ok=True)
    wav = RUN / f"voice-{answer}.wav"
    rec = record(60, wav)                    # what the mic heard, for diagnosing a miss
    t0 = time.time()
    s.say(WRITE_PROMPT)
    listening = s.wait(lambda: s.ev("permission.listening"), 60, "listening")
    t_listen = round(time.time() - t0, 1)
    if listening:
        s.pump(0.3)
        speak_through_speakers(answer)
    perm = s.wait(lambda: s.ev("permission"), 30, "decision")
    s.pump(8)
    heard = s.ev("listener.heard")
    rec.terminate(); rec.wait()
    return {"mic_heard": transcribe(wav), "listening_at_s": t_listen, "decision": perm[0]["decision"] if perm else None,
            "reason": perm[0]["reason"] if perm else None, "decided_after_ms": perm[0]["ms"] if perm else None,
            "heard": [(h["answer"], h["confidence"]) for h in heard], "file_created": PROBE.exists()}


def sc_voice_yes(s):
    r = voice_answer(s, "yes")
    r["pass"] = r["decision"] == "allow" and r["file_created"]
    return r


def sc_voice_no(s):
    r = voice_answer(s, "no")
    r["pass"] = r["decision"] == "deny" and not r["file_created"]
    return r


def sc_keyboard_wins(s):
    PROBE.unlink(missing_ok=True)
    s.say(WRITE_PROMPT)
    s.wait(lambda: s.ev("permission.listening"), 60, "listening")
    s.pump(3.5)                                        # dialog is up at ~6 s; answer it there
    s.send(ESC)
    perm = s.wait(lambda: s.ev("permission"), 30, "decision")
    s.pump(3)
    speak_through_speakers("yes")                       # a late "yes" must change nothing
    s.pump(6)
    r = {"decision": perm[0]["decision"] if perm else None, "reason": perm[0]["reason"] if perm else None,
         "file_created": PROBE.exists()}
    r["pass"] = r["reason"] == "cancelled" and not r["file_created"]
    return r


def sc_stop_command(s):
    (RUN / "config.toml").write_text("min_turn_seconds = 0\nmode = \"chatty\"\n")
    s.say("In four sentences, explain what a hash table is. Plain prose, no lists.")
    s.wait(lambda: s.ev("turn"), 90, "turn")
    s.pump(1.5)
    s.say("/readback:stop")
    stopped = s.wait(lambda: s.ev("speech.stop"), 10, "speech.stop")
    (RUN / "config.toml").write_text("min_turn_seconds = 0\n")
    return {"speech_stopped": bool(stopped), "claude_replied_to_stop": "HOOK" in s.text()[-400:],
            "pass": bool(stopped)}


def sc_status(s):
    s.say("/readback:status")
    s.pump(4)
    screen = s.text()
    m = re.search(r"readback: (engine[^\n]*)", screen)
    line = m.group(1).strip() if m else ""
    return {"status": line, "pass": "engine say" in line and "voice approval ready" in line}


SCENARIOS = {
    "status": sc_status,
    "turn_spoken": sc_turn_spoken,
    "voice_yes": sc_voice_yes,
    "voice_no": sc_voice_no,
    "keyboard_wins": sc_keyboard_wins,
    "stop_command": sc_stop_command,
}


def main():
    names = sys.argv[1:] or list(SCENARIOS)
    RUN.mkdir(parents=True)
    PLAY.mkdir(exist_ok=True)
    (RUN / "config.toml").write_text("min_turn_seconds = 0\n")
    results = {}
    try:
        for name in names:
            print(f"== {name}", flush=True)
            s = Session(name)
            try:
                results[name] = SCENARIOS[name](s) if ready(s) else {"pass": False, "error": "no daemon"}
            except Exception as e:
                results[name] = {"pass": False, "error": repr(e)}
            finally:
                s.close()
                PROBE.unlink(missing_ok=True)
            print("   ", json.dumps(results[name]), flush=True)
    finally:
        lock = Path(ENV["READBACK_SOCKET"]).with_suffix(".lock")
        if lock.exists():
            try:
                os.kill(int(lock.read_text()), signal.SIGTERM)
            except (ValueError, ProcessLookupError):
                pass
    (RUN / "results.json").write_text(json.dumps(results, indent=2) + "\n")
    print(f"\n{sum(r['pass'] for r in results.values())}/{len(results)} passed. Details: {RUN}")


if __name__ == "__main__":
    main()
