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

# Lead/backing vocal split: UVR-MDX-NET Karaoke 2 (MIT, trained by the Ultimate Vocal Remover
# project, github.com/Anjok07/ultimatevocalremovergui). Checked against a known hash.
RUN python -c "import urllib.request; urllib.request.urlretrieve('https://github.com/TRvlvr/model_repo/releases/download/all_public_uvr_models/UVR_MDXNET_KARA_2.onnx', '/models/UVR_MDXNET_KARA_2.onnx')" \
 && echo "bf32e15105a09c0f7dddd2b67346146334d6f3ecb399ed7638eba2ab07cbf5f4  /models/UVR_MDXNET_KARA_2.onnx" | sha256sum -c -

# Note finder: GAME small (MIT, Team OpenVPI, github.com/openvpi/GAME), ONNX release 1.0.3.
RUN python -c "import urllib.request; urllib.request.urlretrieve('https://github.com/openvpi/GAME/releases/download/v1.0.3/GAME-1.0.3-small-onnx.zip', '/tmp/game.zip')" \
 && echo "00ba0c64115b6b874d9ea4afd3e6cf822abda2a04e52569233b0a044fd40e4e8  /tmp/game.zip" | sha256sum -c - \
 && python -c "import zipfile; zipfile.ZipFile('/tmp/game.zip').extractall('/models')" \
 && rm /tmp/game.zip && test -f /models/GAME-1.0.3-small-onnx/encoder.onnx

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
