"""Note transcription with GAME (Generative Adaptive MIDI Extractor), run from its ONNX release.

GAME (MIT, github.com/openvpi/GAME, Team OpenVPI) turns a singing voice into notes: it finds
note boundaries (roughly one per sung syllable) with a few denoising steps, then estimates each
note's pitch. Model files: GAME-1.0.3-small-onnx from the GAME releases. The ONNX workflow
(encoder -> segmenter loop -> bd2dur -> estimator) follows GAME's ONNX.md.

Long vocals are cut into phrases at the silences first, as GAME's own command line does.
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np


class Game:
    def __init__(self, model_dir: str | Path, threads: int = 4, steps: int = 8,
                 seg_threshold: float = 0.2, radius: int = 2, est_threshold: float = 0.2):
        import onnxruntime as ort

        self.ort = ort
        d = Path(model_dir)
        self.cfg = json.loads((d / "config.json").read_text())
        self.sr = int(self.cfg["samplerate"])
        self.step = float(self.cfg["timestep"])
        opts = ort.SessionOptions()
        opts.intra_op_num_threads = threads
        opts.log_severity_level = 3

        def load(name):
            return ort.InferenceSession(str(d / f"{name}.onnx"), sess_options=opts, providers=["CPUExecutionProvider"])

        self._load = load
        self.enc, self.seg, self.est = load("encoder"), load("segmenter"), load("estimator")
        self.d2b, self.b2d = load("dur2bd"), load("bd2dur")
        self.seg_inputs = {i.name for i in self.seg.get_inputs()}
        self.ts = [i / steps for i in range(steps)] if self.cfg.get("loop") else [None]
        self.seg_threshold, self.radius, self.est_threshold = seg_threshold, radius, est_threshold

    def phrase(self, wav: np.ndarray, language: int = 0) -> list[tuple[float, float, float]]:
        """Notes in one phrase (mono float32 at self.sr): [(t0, t1, midi), ...], times from its start."""
        dur = len(wav) / self.sr
        x_seg, x_est, mask = self.enc.run(None, {
            "waveform": wav[None].astype(np.float32), "duration": np.array([dur], np.float32)})
        known = self.d2b.run(None, {"durations": np.array([[dur]], np.float32), "maskT": mask})[0]
        bd = known
        for t in self.ts:
            feed = {"x_seg": x_seg, "known_boundaries": known, "maskT": mask,
                    "threshold": np.array(self.seg_threshold, np.float32), "radius": np.array(self.radius, np.int64)}
            if "language" in self.seg_inputs:
                feed["language"] = np.array([language], np.int64)
            if t is not None:
                feed["prev_boundaries"] = bd
                feed["t"] = np.array([t], np.float32)
            bd = self.seg.run(None, feed)[0]
        durs, mask_n = self.b2d.run(None, {"boundaries": bd, "maskT": mask})
        presence, scores = self.est.run(None, {
            "x_est": x_est, "boundaries": bd, "maskT": mask, "maskN": mask_n,
            "threshold": np.array(self.est_threshold, np.float32)})
        out, t = [], 0.0
        for d_, ok, voiced, s in zip(durs[0], mask_n[0], presence[0], scores[0]):
            if not ok:
                break
            if voiced:
                out.append((t, t + float(d_), float(s)))
            t += float(d_)
        return out

    def transcribe(self, wav: np.ndarray, phrases: list[tuple[int, int]], language: int = 0):
        """Notes over a whole vocal. phrases: [(start_sample, end_sample)] at self.sr."""
        # The segmenter's denoising steps draw random numbers (a RandomUniformLike with no seed),
        # and its generator carries on from song to song. Reloading it with a fixed seed per song
        # makes the same song give the same notes every time (~0.3 s).
        self.ort.set_seed(1234)
        self.seg = self._load("segmenter")
        notes = []
        for a, b in phrases:
            if b - a < int(0.2 * self.sr):
                continue
            for t0, t1, m in self.phrase(wav[a:b], language):
                notes.append((a / self.sr + t0, a / self.sr + t1, m))
        return notes


def phrases_from_gate(gate: np.ndarray, hop_s: float, sr: int, rms_db: np.ndarray,
                      join_s=0.3, pad_s=0.1, max_s=25.0) -> list[tuple[int, int]]:
    """Cut the vocal at its silences (gate = frames loud enough to be singing), joining short
    gaps and splitting anything longer than max_s at its quietest frame."""
    idx = np.flatnonzero(gate)
    if not len(idx):
        return []
    runs, a, prev = [], idx[0], idx[0]
    join = int(join_s / hop_s)
    for i in idx[1:]:
        if i - prev > join:
            runs.append((a, prev + 1))
            a = i
        prev = i
    runs.append((a, prev + 1))
    pad, maxf = int(pad_s / hop_s), int(max_s / hop_s)
    out = []

    def split(a, b):
        if b - a <= maxf:
            out.append((a, b))
            return
        lo, hi = a + maxf // 3, min(b - maxf // 6, a + maxf)
        cut = lo + int(np.argmin(rms_db[lo:hi]))
        split(a, cut)
        split(cut, b)

    for a, b in runs:
        split(max(0, a - pad), min(len(gate), b + pad))
    k = sr * hop_s
    return [(int(a * k), int(b * k)) for a, b in out]
