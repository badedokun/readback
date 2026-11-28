#!/bin/sh
# Runs inside the Linux smoke image (or a CI runner with the same packages).
set -eu
pulseaudio --check 2>/dev/null || pulseaudio -D --exit-idle-time=-1
for i in 1 2 3 4 5 6 7 8 9 10; do pactl info >/dev/null 2>&1 && break; sleep 0.5; done
pactl unload-module module-suspend-on-idle 2>/dev/null || true   # a suspended null sink feeds its monitor nothing
pactl load-module module-null-sink sink_name=null >/dev/null
pactl set-default-sink null
export READBACK_DATA_DIR="${READBACK_DATA_DIR:-/tmp/rb-data}"
mkdir -p "$READBACK_DATA_DIR/voices"
VOICES_DIR="${VOICES_DIR:-/voices}"
[ -d "$VOICES_DIR" ] && cp "$VOICES_DIR"/* "$READBACK_DATA_DIR/voices/" || true
node test/smoke/engines.mjs
node --test test/*.test.mjs
