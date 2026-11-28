# Linux listener image: the smoke image plus whisper.cpp built from a pinned tag and the
# pinned tiny.en model. GGML_NATIVE=OFF: gcc 12's native detection breaks the aarch64 fp16
# build inside Docker, so the ARM features are named explicitly. Build from the repo root after readback-linux:
#   docker build -f test/smoke/listener.Dockerfile -t readback-linux-listener .
FROM node:20-bookworm-slim AS whisper
RUN apt-get update && apt-get install -y --no-install-recommends build-essential cmake git ca-certificates \
  && rm -rf /var/lib/apt/lists/*
RUN git clone --depth 1 --branch v1.9.6 https://github.com/ggml-org/whisper.cpp /src \
  && ARM=$([ "$(uname -m)" = aarch64 ] && echo "-DGGML_CPU_ARM_ARCH=armv8.2-a+dotprod+fp16" || true) \
  && cmake -S /src -B /build -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF -DWHISPER_BUILD_TESTS=OFF -DGGML_NATIVE=OFF $ARM \
  && cmake --build /build -j --target whisper-cli

FROM readback-linux
COPY --from=whisper /build/bin/whisper-cli /usr/local/bin/whisper-cli
RUN mkdir -p /models && curl -fsSL -o /models/ggml-tiny.en.bin \
      https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-tiny.en.bin \
  && echo "921e4cf8686fdd993dcd081a5da5b6c365bfde1162e72b08d75ac75289920b1f  /models/ggml-tiny.en.bin" | sha256sum -c
ENV READBACK_MODEL=/models/ggml-tiny.en.bin
COPY . .
CMD ["sh", "test/smoke/linux-listener.sh"]
