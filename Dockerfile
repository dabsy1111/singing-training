FROM python:3.13-slim

# Deno: yt-dlp needs a JavaScript runtime to solve YouTube's player challenges.
COPY --from=denoland/deno:bin /deno /usr/local/bin/deno

RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
 && rm -rf /var/lib/apt/lists/*

ENV PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1 \
    TORCH_HOME=/models/torch HF_HOME=/models/hf \
    DATA_DIR=/data PYTHONUNBUFFERED=1

# CPU-only PyTorch (the OptiPlex has no GPU; this saves ~2 GB)
RUN pip install torch==2.15.0 torchaudio==2.11.1 --index-url https://download.pytorch.org/whl/cpu

WORKDIR /srv
COPY requirements.txt .
RUN pip install -r requirements.txt

# Bake the separation model into the image so the first song doesn't wait on a download.
RUN python -c "from demucs.pretrained import get_model; get_model('htdemucs')"

COPY app ./app
ARG VL_VERSION=""
ARG VL_BUILT=""
ENV VL_VERSION=$VL_VERSION VL_BUILT=$VL_BUILT
COPY entrypoint.sh .
RUN chmod +x entrypoint.sh

EXPOSE 8000
VOLUME /data
HEALTHCHECK --interval=60s --timeout=10s CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8000/api/health')"
ENTRYPOINT ["./entrypoint.sh"]
