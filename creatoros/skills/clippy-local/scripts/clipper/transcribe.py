#!/usr/bin/env python3
"""Clippy transcription (faster-whisper on CPU, no PyTorch).

usage: transcribe.py <audio.wav> [--words] [--offset S] [--model base.en] [--loud-only]

Prints JSON on stdout:
  { "segments": [[start, end, text], ...],      (seconds, + offset)
    "words": [[word, start, end], ...],         (--words only)
    "loud": [[t, db], ...] }                    (loudest seconds: shouting, big reactions)
Progress goes to stderr as "progress <0..1>" lines while it works.
"""
import argparse
import json
import sys
import wave

import numpy as np


def loud_peaks(path, offset):
    """dB per second; seconds well above the stream's own normal are peaks."""
    try:
        with wave.open(path, 'rb') as w:
            rate = w.getframerate()
            n = w.getnframes()
            out = []
            sec = 0
            while sec * rate < n:
                buf = w.readframes(rate)
                if not buf:
                    break
                a = np.frombuffer(buf, dtype=np.int16).astype(np.float32) / 32768.0
                rms = float(np.sqrt(np.mean(a * a)) + 1e-9)
                out.append(20 * np.log10(rms))
                sec += 1
    except Exception:
        return []
    if len(out) < 10:
        return []
    db = np.array(out)
    floor = np.median(db)
    thresh = max(floor + 9.0, np.percentile(db, 97))
    peaks = [(i, float(v)) for i, v in enumerate(db) if v >= thresh]
    # One peak per 20 s stretch (the loudest), at most 60.
    kept = []
    for i, v in sorted(peaks, key=lambda p: -p[1]):
        if all(abs(i - k) >= 20 for k, _ in kept):
            kept.append((i, v))
        if len(kept) >= 60:
            break
    return [[round(i + offset, 1), round(v - floor, 1)] for i, v in sorted(kept)]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('audio')
    ap.add_argument('--words', action='store_true')
    ap.add_argument('--offset', type=float, default=0.0)
    ap.add_argument('--model', default='base.en')
    ap.add_argument('--prompt', default=None, help='context for spelling (names, places), Whisper initial_prompt')
    ap.add_argument('--loud-only', action='store_true', help='only the loud moments (the transcript came from captions)')
    a = ap.parse_args()
    if a.loud_only:
        print(json.dumps({'segments': [], 'loud': loud_peaks(a.audio, a.offset)}))
        return
    from faster_whisper import WhisperModel
    model = WhisperModel(a.model, device='cpu', compute_type='int8')
    segs, info = model.transcribe(a.audio, beam_size=1 if not a.words else 3, vad_filter=True,
                                  word_timestamps=a.words, condition_on_previous_text=False, initial_prompt=a.prompt or None)
    total = float(getattr(info, 'duration', 0) or 0)
    segments, words = [], []
    last = 0.0
    for s in segs:
        t = s.text.strip()
        if t:
            segments.append([round(s.start + a.offset, 2), round(s.end + a.offset, 2), t])
        if a.words:
            for w in (s.words or []):
                tok = w.word.strip()
                if tok:
                    words.append([tok, round(w.start + a.offset, 3), round(w.end + a.offset, 3)])
        if total and s.end - last > 30:
            last = s.end
            print(f'progress {min(1.0, s.end / total):.3f}', file=sys.stderr, flush=True)
    out = {'segments': segments, 'loud': loud_peaks(a.audio, a.offset)}
    if a.words:
        out['words'] = words
    print(json.dumps(out))


if __name__ == '__main__':
    main()
