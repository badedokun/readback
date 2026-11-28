#!/bin/sh
# Linux listener loop with no microphone: Piper speaks into a null sink and the listener
# records that sink's monitor through PulseAudio (`parec`), then whisper.cpp recognises it.
set -eu
pulseaudio --check 2>/dev/null || pulseaudio -D --exit-idle-time=-1
for i in 1 2 3 4 5 6 7 8 9 10; do pactl info >/dev/null 2>&1 && break; sleep 0.5; done
pactl unload-module module-suspend-on-idle 2>/dev/null || true   # a suspended null sink feeds its monitor nothing
pactl load-module module-null-sink sink_name=null >/dev/null
pactl set-default-sink null
pactl set-default-source null.monitor
# A real microphone streams constantly; a null-sink monitor only while something plays.
pacat --raw --rate=16000 --format=s16le --channels=1 < /dev/zero >/dev/null 2>&1 &
FEED=$!
# Stop the feed on exit: it inherits stdout, and a caller piping our output would wait on it forever.
trap 'kill $FEED 2>/dev/null' EXIT
sleep 0.5
# Phrases are spoken with Piper (a natural voice); espeak's robotic voice is not what users sound like.
export READBACK_DATA_DIR="${READBACK_DATA_DIR:-/tmp/rb-data}"
mkdir -p "$READBACK_DATA_DIR/voices" && cp "${VOICES_DIR:-/voices}"/* "$READBACK_DATA_DIR/voices/"
node test/smoke/listener.mjs piper
