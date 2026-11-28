# Linux engine smoke-test image (test plan §1 "Engine smoke"): PulseAudio with a null sink,
# espeak-ng, Piper with one pinned voice, sox. Build from the repo root:
#   docker build -f test/smoke/linux.Dockerfile -t readback-linux .
FROM node:20-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
      espeak-ng pulseaudio pulseaudio-utils sox libsox-fmt-pulse python3-pip curl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
RUN pip3 install --break-system-packages --no-cache-dir piper-tts==1.2.0
# One Piper voice, pinned by revision and checked by hash.
ARG VOICE_REV=5ec43b186ef915a195d3ddbcfd9916e76c503c3f
RUN mkdir -p /voices && cd /voices \
  && curl -fsSL -o en_US-lessac-low.onnx "https://huggingface.co/rhasspy/piper-voices/resolve/${VOICE_REV}/en/en_US/lessac/low/en_US-lessac-low.onnx" \
  && curl -fsSL -o en_US-lessac-low.onnx.json "https://huggingface.co/rhasspy/piper-voices/resolve/${VOICE_REV}/en/en_US/lessac/low/en_US-lessac-low.onnx.json" \
  && sha256sum en_US-lessac-low.onnx
WORKDIR /readback
COPY . .
CMD ["sh", "test/smoke/linux.sh"]
