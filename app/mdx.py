"""Run an MDX-Net ONNX separation model (the UVR family) without the audio-separator package.

Used for the lead/backing vocal split: UVR-MDX-NET Karaoke 2 takes a vocal stem and
returns everything except the lead voice (harmonies, doubles, gang vocals); the lead
is what's left when that is subtracted.

The chunking, STFT layout and compensation follow audio-separator's MDX separator
(MIT, github.com/nomadkaraoke/python-audio-separator), which follows UVR (MIT,
github.com/Anjok07/ultimatevocalremovergui). The Karaoke 2 model was trained by the
UVR project; MIT with credit to UVR and its developers.
"""
from __future__ import annotations

import numpy as np

# Per-model settings, from UVR's mdx_model_data (keyed there by the model file's hash).
MODELS = {
    "UVR_MDXNET_KARA_2.onnx": {"n_fft": 5120, "dim_f": 2048, "dim_t": 256, "compensate": 1.065},
}
HOP = 1024
OVERLAP = 0.25
SR = 44100


class MDX:
    def __init__(self, path: str, threads: int = 4):
        import onnxruntime as ort
        import torch

        name = path.rsplit("/", 1)[-1]
        cfg = MODELS[name]
        self.n_fft, self.dim_f, self.dim_t, self.compensate = cfg["n_fft"], cfg["dim_f"], cfg["dim_t"], cfg["compensate"]
        opts = ort.SessionOptions()
        opts.intra_op_num_threads = threads
        opts.log_severity_level = 3
        self.sess = ort.InferenceSession(path, sess_options=opts, providers=["CPUExecutionProvider"])
        self.torch = torch
        self.window = torch.hann_window(self.n_fft, periodic=True)
        self.trim = self.n_fft // 2
        self.chunk = HOP * (self.dim_t - 1)

    def _stft(self, x):  # x: (2, n) -> (1, 4, dim_f, t)
        t = self.torch
        s = t.stft(x, n_fft=self.n_fft, hop_length=HOP, window=self.window, center=True, return_complex=True)
        s = t.view_as_real(s).permute(0, 3, 1, 2).reshape(1, 4, s.shape[1], s.shape[2])
        return s[:, :, : self.dim_f, :]

    def _istft(self, s):  # (1, 4, dim_f, t) -> (2, n)
        t = self.torch
        bins = self.n_fft // 2 + 1
        s = t.cat([s, t.zeros(1, 4, bins - s.shape[2], s.shape[3])], 2)
        s = s.reshape(2, 2, bins, -1).permute(0, 2, 3, 1).contiguous()
        return t.istft(t.view_as_complex(s), n_fft=self.n_fft, hop_length=HOP, window=self.window, center=True)

    def model_stem(self, mix: np.ndarray) -> np.ndarray:
        """The model's own output for a stereo (2, n) float32 mix at 44.1 kHz."""
        t = self.torch
        peak = float(np.abs(mix).max()) or 1.0
        scale = 0.9 / peak if peak > 0.9 else 1.0
        x = mix.astype(np.float32) * scale
        n = x.shape[1]
        gen = self.chunk - 2 * self.trim
        pad = gen + self.trim - (n % gen)
        xp = np.concatenate([np.zeros((2, self.trim), np.float32), x, np.zeros((2, pad), np.float32)], 1)
        out = np.zeros_like(xp)
        div = np.zeros_like(xp)
        step = int((1 - OVERLAP) * self.chunk)
        with t.no_grad():
            for i in range(0, xp.shape[1], step):
                end = min(i + self.chunk, xp.shape[1])
                part = xp[:, i:end]
                size = part.shape[1]
                if size < self.chunk:
                    part = np.concatenate([part, np.zeros((2, self.chunk - size), np.float32)], 1)
                spec = self._stft(t.from_numpy(part))
                spec[:, :, :3, :] = 0
                pred = self.sess.run(None, {"input": spec.numpy()})[0]
                wav = self._istft(t.from_numpy(pred)).numpy()[:, :size]
                w = np.hanning(size)[None, :]
                out[:, i:end] += wav * w
                div[:, i:end] += w
        out = out / np.maximum(div, 1e-8)
        return out[:, self.trim: self.trim + n] / scale

    def split(self, mix: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        """Karaoke split of a vocal stem: returns (lead, backing), both (2, n)."""
        backing = self.model_stem(mix)
        lead = mix - backing * self.compensate
        return lead, backing
