#!/usr/bin/env python3
"""Clippy layout analysis: where the people are in a clip, and who is talking.

usage: analyze.py <clip.mp4> --style podcast|gaming --aspect 9:16 --layout auto
                  [--boxes '{"crop": {x,y,w,h}, ...}']   (fractions of the frame)

Prints one JSON plan on stdout:
  { "source": {w, h, duration}, "facecam": [x,y,w,h] | null, "faces": n,
    "segments": [ {start, end, kind, ...}, ... ] }   (boxes in source pixels)
kinds:
  single  {box}               one crop that follows the speaker (exact output aspect)
  split   {boxes: [top, bot]} two people stacked (each box at the half-panel aspect)
  gaming  {facecam, gameplay} streamer's camera over the gameplay (renderer fits panels)
  camchat {box, chat}         the streamer full screen: talking head on top, the stream's chat below
  full    {box}               gameplay / center crop filling the frame
  blur    {}                  the whole frame over a blurred copy
  follow  {size, path}        layout "follow" (stand-up): a crop of `size` [w, h] that moves with the
                              performer's face, path [[t, cx, cy], ...] (face centre, source px);
                              the renderer keeps the face centred across and FOLLOW_FACE_Y down

Faces: OpenCV's YuNet (models/face_detection_yunet_2023mar.onnx, MIT), sampled
at SAMPLE_FPS on a 640-wide copy. Speakers: mouth-region motion per face track
(the mouth corners YuNet returns), 1 s windows, held at least MIN_HOLD seconds.
Facecams: a face that sits in the same place in most samples; its overlay box
comes from the persistent straight edges around it (gameplay edges move and
average out, a webcam border doesn't), else a fixed expansion of the face.
"""
import argparse
import json
import os
import sys

import cv2
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
MODEL = os.path.join(HERE, 'models', 'face_detection_yunet_2023mar.onnx')
WORK_W = 640
SAMPLE_FPS = 6.0
MIN_HOLD = 2.0
CUT_DIFF = 0.45


def parse_aspect(a):
    w, h = a.split(':')
    return float(w) / float(h)


def read_samples(path, fps, work_w=None):
    cap = cv2.VideoCapture(path)
    src_fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    n = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    W = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    H = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    step = max(1, int(round(src_fps / fps)))
    frames, times = [], []
    i = 0
    while True:
        ok = cap.grab()
        if not ok:
            break
        if i % step == 0:
            ok, f = cap.retrieve()
            if not ok:
                break
            ww = work_w or WORK_W
            scale = ww / f.shape[1]
            frames.append(cv2.resize(f, (ww, int(round(f.shape[0] * scale)))))
            times.append(i / src_fps)
        i += 1
    cap.release()
    duration = (n / src_fps) if n else (times[-1] if times else 0)
    return frames, times, W, H, max(duration, times[-1] if times else 0)


def detect(frames):
    if not frames:
        return []
    h, w = frames[0].shape[:2]
    # YuNet's feature maps need both sides divisible by 32 (a 640x358 frame
    # crashes OpenCV's DNN): pad bottom / right with black, coords unchanged.
    ph, pw = -(-h // 32) * 32, -(-w // 32) * 32
    det = cv2.FaceDetectorYN.create(MODEL, '', (pw, ph), 0.72, 0.3, 5000)
    out = []
    for f in frames:
        if (ph, pw) != f.shape[:2]:
            f = cv2.copyMakeBorder(f, 0, ph - f.shape[0], 0, pw - f.shape[1], cv2.BORDER_CONSTANT, value=(0, 0, 0))
        _, faces = det.detect(f)
        lst = []
        if faces is not None:
            for r in faces:
                x, y, fw, fh = [float(v) for v in r[:4]]
                if fw < 12 or fh < 12:
                    continue
                lst.append({'box': (x, y, fw, fh), 'mouth': (float(r[10]), float(r[11]), float(r[12]), float(r[13])), 'score': float(r[14])})
        out.append(lst)
    return out


def detect_in(frames, dets, box):
    """A second, closer look inside the webcam overlay: a facecam's face is
    often ~30 px wide in the 640 px working copy, below what YuNet finds
    reliably, so the overlay is cut out, enlarged and searched again. Faces
    found are added to `dets` in working-copy coordinates."""
    if not frames or not box:
        return dets
    fh_, fw_ = frames[0].shape[:2]
    bx, by, bw, bh = box
    x0, y0 = int(max(0, bx - bw * 0.1)), int(max(0, by - bh * 0.1))
    x1, y1 = int(min(fw_, bx + bw * 1.1)), int(min(fh_, by + bh * 1.1))
    if x1 - x0 < 16 or y1 - y0 < 16:
        return dets
    k = min(5.0, 512 / (x1 - x0))
    if k <= 1.2:
        return dets  # already big enough for the first pass
    cw, ch = int(round((x1 - x0) * k)), int(round((y1 - y0) * k))
    pw, ph = -(-cw // 32) * 32, -(-ch // 32) * 32
    det = cv2.FaceDetectorYN.create(MODEL, '', (pw, ph), 0.6, 0.3, 5000)
    out = []
    for f, lst in zip(frames, dets):
        crop = cv2.resize(f[y0:y1, x0:x1], (cw, ch), interpolation=cv2.INTER_CUBIC)
        crop = cv2.copyMakeBorder(crop, 0, ph - ch, 0, pw - cw, cv2.BORDER_CONSTANT, value=(0, 0, 0))
        _, faces = det.detect(crop)
        extra = []
        for r in (faces if faces is not None else []):
            x, y, w, h = [float(v) / k for v in r[:4]]
            x, y = x + x0, y + y0
            if w < 6 or any(iou((x, y, w, h), d['box']) > 0.3 for d in lst):
                continue
            m = [float(v) / k for v in r[10:14]]
            extra.append({'box': (x, y, w, h), 'mouth': (m[0] + x0, m[1] + y0, m[2] + x0, m[3] + y0), 'score': float(r[14]), 'cam': True})
        out.append(lst + extra)
    return out


def scene_cuts(frames):
    """Indices where a new shot starts (histogram jump between samples)."""
    cuts = [0]
    prev = None
    for i, f in enumerate(frames):
        hsv = cv2.cvtColor(cv2.resize(f, (160, 90)), cv2.COLOR_BGR2HSV)
        hist = cv2.calcHist([hsv], [0, 1], None, [32, 32], [0, 180, 0, 256])
        cv2.normalize(hist, hist)
        if prev is not None and cv2.compareHist(prev, hist, cv2.HISTCMP_BHATTACHARYYA) > CUT_DIFF:
            if i - cuts[-1] >= 3:
                cuts.append(i)
        prev = hist
    return cuts


def iou(a, b):
    ax, ay, aw, ah = a
    bx, by, bw, bh = b
    ix = max(0, min(ax + aw, bx + bw) - max(ax, bx))
    iy = max(0, min(ay + ah, by + bh) - max(ay, by))
    inter = ix * iy
    return inter / (aw * ah + bw * bh - inter + 1e-6)


def tracks_for(frames, dets, lo, hi):
    """Greedy IoU / distance tracking inside one shot."""
    tracks = []
    for i in range(lo, hi):
        used = set()
        for d in sorted(dets[i], key=lambda d: -d['box'][2]):
            best, best_s = None, 0.0
            for t in tracks:
                if t['last'] < i - 4 or id(t) in used:
                    continue
                s = iou(t['boxes'][-1][1], d['box'])
                cx = abs((t['boxes'][-1][1][0] + t['boxes'][-1][1][2] / 2) - (d['box'][0] + d['box'][2] / 2))
                if s < 0.2 and cx < d['box'][2] * 0.6:
                    s = 0.2
                if s > best_s:
                    best, best_s = t, s
            if best is None or best_s < 0.15:
                best = {'boxes': [], 'motion': [], 'last': i, 'prev_mouth': None}
                tracks.append(best)
            used.add(id(best))
            best['boxes'].append((i, d['box']))
            best['last'] = i
            # mouth patch motion
            x1, y1, x2, y2 = d['mouth']
            fw, fh = d['box'][2], d['box'][3]
            mx0 = int(max(0, min(x1, x2) - fw * 0.08))
            mx1 = int(min(frames[i].shape[1], max(x1, x2) + fw * 0.08))
            my0 = int(max(0, min(y1, y2) - fh * 0.12))
            my1 = int(min(frames[i].shape[0], max(y1, y2) + fh * 0.28))
            if mx1 - mx0 >= 4 and my1 - my0 >= 4:
                patch = cv2.cvtColor(frames[i][my0:my1, mx0:mx1], cv2.COLOR_BGR2GRAY)
                patch = cv2.resize(patch, (32, 20)).astype(np.float32)
                patch = (patch - patch.mean()) / (patch.std() + 1e-3)
                if best['prev_mouth'] is not None and best['prev_mouth'][0] >= i - 2:
                    best['motion'].append((i, float(np.abs(patch - best['prev_mouth'][1]).mean())))
                best['prev_mouth'] = (i, patch)
    # Drop flickers: a real person is in a good part of the shot.
    n = hi - lo
    return [t for t in tracks if len(t['boxes']) >= max(3, n * 0.25)]


def clamp_box(x, y, w, h, W, H):
    w = min(w, W)
    h = min(h, H)
    x = min(max(0, x), W - w)
    y = min(max(0, y), H - h)
    return [int(round(x)), int(round(y)), int(round(w)), int(round(h))]


def crop_around(cx, cy, aspect, W, H, height_frac=1.0):
    """The largest box at `aspect` (w/h) centred on (cx, cy), `height_frac` of the frame tall."""
    h = H * height_frac
    w = h * aspect
    if w > W:
        w = W
        h = w / aspect
    return clamp_box(cx - w / 2, cy - h * 0.42, w, h, W, H)


def median_center(boxes, s):
    xs = [(b[0] + b[2] / 2) / s for _, b in boxes]
    ys = [(b[1] + b[3] / 2) / s for _, b in boxes]
    hs = [b[3] / s for _, b in boxes]
    return float(np.median(xs)), float(np.median(ys)), float(np.median(hs))


def speaker_per_window(tracks, t_of, lo, hi):
    """Which track talks in each ~1 s window of a shot (None = nobody / unclear)."""
    if not tracks:
        return []
    per = max(1, int(round(SAMPLE_FPS)))
    out = []
    for w0 in range(lo, hi, per):
        w1 = min(hi, w0 + per)
        scores = []
        for k, t in enumerate(tracks):
            m = [v for i, v in t['motion'] if w0 <= i < w1]
            present = any(w0 <= i < w1 for i, _ in t['boxes'])
            scores.append(float(np.mean(m)) if m and present else (0.0 if present else -1.0))
        order = np.argsort(scores)[::-1]
        top = scores[order[0]]
        second = scores[order[1]] if len(order) > 1 else 0.0
        who = int(order[0]) if top > 0 and (top > second * 1.25 or second <= 0) else None
        out.append((t_of(w0), t_of(w1 - 1) + 1 / SAMPLE_FPS, who, scores))
    return out


FOLLOW_W = 1280     # stand-up: a wide shot's face is ~15 px at 640, so look at twice the size
FOLLOW_FACE_Y = 0.30  # face this far down the frame (70% up), Kevin 2026-11-22
FOLLOW_MIN_H = 0.87   # zoom at most ~1.15x: a 1080p source is already enlarged 1.8x for 9:16


def smooth(vals, k):
    """Centred moving average over k samples (edges use what they have)."""
    out = []
    for i in range(len(vals)):
        lo, hi = max(0, i - k // 2), min(len(vals), i + k // 2 + 1)
        out.append(float(np.mean(vals[lo:hi])))
    return out


def follow_plan(frames, times, dets, W, H, aspect, s):
    """Stand-up: per shot, lock on to the performer (the biggest, steadiest face) and follow the
    face every sample, so they never walk out of frame. A shot where no face is found shows the
    whole frame over a blur (never an empty stage)."""
    cuts = scene_cuts(frames) + [len(frames)]
    t_of = lambda i: times[min(i, len(times) - 1)]
    segs = []
    for lo, hi in zip(cuts[:-1], cuts[1:]):
        start, end = t_of(lo), (t_of(hi) if hi < len(times) else times[-1] + 1 / SAMPLE_FPS)
        tracks = tracks_for(frames, dets, lo, hi)
        if not tracks:
            segs.append({'start': start, 'end': end, 'kind': 'blur'})
            continue
        # The performer: biggest median face among the longer tracks (the audience is small and brief).
        tracks.sort(key=lambda t: -(len(t['boxes']) * median_center(t['boxes'], s)[2]))
        t = tracks[0]
        seen = {i: b for i, b in t['boxes']}
        idx = list(range(lo, hi))
        known = [i for i in idx if i in seen]
        cx, cy = [], []
        for i in idx:
            # Missing samples take the nearest known one (held, not drifting).
            j = i if i in seen else min(known, key=lambda k: abs(k - i))
            b = seen[j]
            cx.append((b[0] + b[2] / 2) / s)
            cy.append((b[1] + b[3] / 2) / s)
        cx = smooth(cx, 5)
        cy = smooth(cy, 9)
        # One crop size per shot: as tall as the frame allows with the face FOLLOW_FACE_Y down.
        fy = float(np.median(cy))
        h = min(H, fy / FOLLOW_FACE_Y if FOLLOW_FACE_Y else H, (H - fy) / (1 - FOLLOW_FACE_Y))
        h = max(H * FOLLOW_MIN_H, min(H, h))
        w = h * aspect
        if w > W:
            w = W
            h = w / aspect
        path = [[round(t_of(i), 3), round(x, 1), round(y, 1)] for i, x, y in zip(idx, cx, cy)]
        segs.append({'start': start, 'end': end, 'kind': 'follow', 'size': [int(round(w)), int(round(h))], 'path': path})
    return merge(segs)


def podcast_plan(frames, times, dets, W, H, aspect, layout, s):
    cuts = scene_cuts(frames) + [len(frames)]
    t_of = lambda i: times[min(i, len(times) - 1)]
    segs = []
    for lo, hi in zip(cuts[:-1], cuts[1:]):
        tracks = tracks_for(frames, dets, lo, hi)
        start, end = t_of(lo), (t_of(hi) if hi < len(times) else times[-1] + 1 / SAMPLE_FPS)
        if not tracks:
            segs.append({'start': start, 'end': end, 'kind': 'blur' if layout in ('auto', 'blur') else 'full',
                         'box': crop_around(W / 2, H / 2, aspect, W, H)})
            continue
        tracks.sort(key=lambda t: -len(t['boxes']))
        if layout == 'blur':
            segs.append({'start': start, 'end': end, 'kind': 'blur'})
            continue
        two = len(tracks) >= 2 and len(tracks[1]['boxes']) >= (hi - lo) * 0.5
        windows = speaker_per_window(tracks[:3], t_of, lo, hi)
        talkers = [w[2] for w in windows if w[2] is not None]
        share = [talkers.count(k) / max(1, len(talkers)) for k in range(min(3, len(tracks)))]
        switches = sum(1 for a, b in zip(talkers, talkers[1:]) if a != b)
        want_split = layout == 'split' or (layout == 'auto' and two and len(share) > 1 and min(share[0], share[1]) >= 0.25
                                           and switches >= max(2, (end - start) / 4))
        if two and want_split:
            # Left person on top, right person below, each at the half-panel aspect.
            a, b = sorted(tracks[:2], key=lambda t: median_center(t['boxes'], s)[0])
            boxes = []
            for t in (a, b):
                cx, cy, fh = median_center(t['boxes'], s)
                frac = min(1.0, max(0.45, fh * 3.0 / H))
                boxes.append(crop_around(cx, cy, aspect * 2, W, H, frac))
            segs.append({'start': start, 'end': end, 'kind': 'split', 'boxes': boxes})
            continue
        if layout == 'center':
            segs.append({'start': start, 'end': end, 'kind': 'single', 'box': crop_around(W / 2, H / 2, aspect, W, H)})
            continue
        # Follow the speaker, holding each crop at least MIN_HOLD seconds.
        cur, cur_start = None, start
        pieces = []
        for (ws, we, who, _) in windows:
            who = who if who is not None else cur if cur is not None else 0
            if cur is None:
                cur = who
            elif who != cur and ws - cur_start >= MIN_HOLD:
                pieces.append((cur_start, ws, cur))
                cur, cur_start = who, ws
        pieces.append((cur_start, end, cur if cur is not None else 0))
        for ps, pe, k in pieces:
            t = tracks[min(k, len(tracks) - 1)]
            inside = [(i, b) for i, b in t['boxes'] if ps <= t_of(i) < pe] or t['boxes']
            cx, cy, fh = median_center(inside, s)
            frac = min(1.0, max(0.62, fh * 4.2 / H))
            segs.append({'start': ps, 'end': pe, 'kind': 'single', 'box': crop_around(cx, cy, aspect, W, H, frac)})
    return merge(segs)


def merge(segs):
    out = []
    for g in segs:
        if g['end'] - g['start'] < 0.05:
            continue
        if out and out[-1]['kind'] == g['kind'] and g['kind'] != 'follow' and all(out[-1].get(k) == g.get(k) for k in ('box', 'boxes', 'facecam')):
            out[-1]['end'] = g['end']
        else:
            out.append(dict(g))
    for g in out:
        g['start'] = round(g['start'], 3)
        g['end'] = round(g['end'], 3)
    return out


def find_facecam(frames, dets, s, W, H):
    """A face in the same spot in most samples, and the overlay box around it."""
    pts = []
    for i, lst in enumerate(dets):
        for d in lst:
            x, y, w, h = d['box']
            pts.append((i, x + w / 2, y + h / 2, w, h))
    if not pts:
        return None
    best = None
    for _, cx, cy, w, _h in pts[:: max(1, len(pts) // 60)]:
        near = [p for p in pts if abs(p[1] - cx) < w * 0.6 and abs(p[2] - cy) < w * 0.6]
        frames_hit = len({p[0] for p in near})
        if not best or frames_hit > best[0]:
            best = (frames_hit, near)
    hits, near = best
    if hits < len(frames) * 0.35:
        return None
    cx = float(np.median([p[1] for p in near]))
    cy = float(np.median([p[2] for p in near]))
    fw = float(np.median([p[3] for p in near]))
    fh = float(np.median([p[4] for p in near]))
    fx0, fy0, fx1, fy1 = cx - fw / 2, cy - fh / 2, cx + fw / 2, cy + fh / 2
    fh_frame = frames[0].shape[0]
    fw_frame = frames[0].shape[1]
    # A face filling much of the frame is a talking head, not a webcam overlay.
    if fw > fw_frame * 0.28:
        return None
    pick = frames[:: max(1, len(frames) // 24)]
    gx = np.zeros((fh_frame, fw_frame), np.float32)
    gy = np.zeros((fh_frame, fw_frame), np.float32)
    for f in pick:
        g = cv2.cvtColor(f, cv2.COLOR_BGR2GRAY).astype(np.float32)
        gx += np.abs(cv2.Sobel(g, cv2.CV_32F, 1, 0, ksize=3))
        gy += np.abs(cv2.Sobel(g, cv2.CV_32F, 0, 1, ksize=3))
    gx /= len(pick)
    gy /= len(pick)

    def edge(profile, lo, hi, reverse, limit):
        idx = range(hi, lo - 1, -1) if reverse else range(lo, hi + 1)
        vals = [(i, profile(i)) for i in idx if 0 <= i < limit]
        if not vals:
            return None
        med = float(np.median([v for _, v in vals])) + 1e-3
        # The overlay border is the strongest straight edge around the face
        # (the webcam's own background is static too, so its edges persist).
        i, v = max(vals, key=lambda p: p[1])
        return i if v > med * 3.0 else None

    ys0, ys1 = int(max(0, fy0 - fh * 0.6)), int(min(fh_frame, fy1 + fh * 0.6))
    xs0, xs1 = int(max(0, fx0 - fw * 0.6)), int(min(fw_frame, fx1 + fw * 0.6))
    colv = lambda c: float(gx[ys0:ys1, c].mean())
    rowv = lambda r: float(gy[r, xs0:xs1].mean())
    left = edge(colv, int(fx0 - fw * 3.5), int(fx0 - fw * 0.25), True, fw_frame)
    right = edge(colv, int(fx1 + fw * 0.25), int(fx1 + fw * 3.5), False, fw_frame)
    top = edge(rowv, int(fy0 - fh * 2.5), int(fy0 - fh * 0.2), True, fh_frame)
    bottom = edge(rowv, int(fy1 + fh * 0.3), int(fy1 + fh * 3.0), False, fh_frame)
    # Missing edges: the frame border if it's close, else a fixed expansion.
    left = left if left is not None else (0 if fx0 < fw * 3.5 else fx0 - fw * 1.4)
    right = right if right is not None else (fw_frame if fw_frame - fx1 < fw * 3.5 else fx1 + fw * 1.4)
    top = top if top is not None else (0 if fy0 < fh * 2.5 else fy0 - fh * 0.9)
    bottom = bottom if bottom is not None else (fh_frame if fh_frame - fy1 < fh * 3.0 else fy1 + fh * 1.3)
    x0, y0, x1, y1 = [v / s for v in (left, top, right, bottom)]
    box = clamp_box(x0, y0, x1 - x0, y1 - y0, W, H)
    if box[2] < W * 0.06 or box[3] < H * 0.06:
        return None
    return box


def _unused_face_hits(dets, lo, hi, box, s):
    """Samples in [lo, hi) with a face centred inside `box` (source px)."""
    x, y, w, h = [v * s for v in box]
    n = 0
    for i in range(lo, hi):
        for d in dets[i]:
            fx, fy, fw, fh = d['box']
            cx, cy = fx + fw / 2, fy + fh / 2
            if x <= cx <= x + w and y <= cy <= y + h:
                n += 1
                break
    return n


GAMING_TOP = {'9:16': 0.42, '4:5': 0.40, '1:1': 0.40}  # facecam panel's share of the height (it sits under the gameplay; render.mjs GAMING_CAM)


def gaming_plan(frames, times, dets, W, H, aspect, layout, s, boxes, aspect_name='9:16'):
    """Streamer over gameplay, with the top panel cropped around the streamer's
    FACE (wherever it is and however big: editors zoom and move the cam), so
    the talking head is always in frame. Each sample is 'cam' (the streamer's
    face), 'big' (the streamer full screen) or 'none' (no face: gameplay
    alone). States are smoothed (a face must be gone 1.5 s before its panel
    goes; runs under 0.7 s join their neighbour) and a cam run is split when
    the face moves. The facecam box (Claude, or edge detection) only picks the
    streamer's face over faces in the game."""
    cam = boxes.get('facecam')
    # facecam False = Claude saw no webcam overlay (the camera is the whole
    # frame): don't go looking for one with edges either.
    hint = [int(cam['x'] * W), int(cam['y'] * H), int(cam['w'] * W), int(cam['h'] * H)] if cam else None if cam is False else find_facecam(frames, dets, s, W, H)
    # An "overlay" covering most of the frame is the camera itself.
    if hint and (hint[2] > W * 0.45 or hint[3] > H * 0.6):
        hint = None
    ch = boxes.get('chat')
    # The stream's chat overlay (Claude, on a full-camera frame): shown under the talking head.
    chat = clamp_box(ch['x'] * W, ch['y'] * H, ch['w'] * W, ch['h'] * H, W, H) if ch else None
    gp = boxes.get('gameplay')
    gameplay = [int(gp['x'] * W), int(gp['y'] * H), int(gp['w'] * W), int(gp['h'] * H)] if gp else clamp_box(W * 0.14, 0, W * 0.72, H, W, H)
    # The bottom strip of a game frame is its own subtitles, minimap and HUD: they'd sit right
    # under our captions on the seam, so the gameplay panel leaves them out.
    if gameplay[3] >= H * 0.9:
        gameplay[3] = int(gameplay[3] * 0.86)
    end = (times[-1] + 1 / SAMPLE_FPS) if times else 0.0
    if layout == 'blur':
        return hint, [{'start': 0.0, 'end': end, 'kind': 'blur'}]
    gcx = gameplay[0] + gameplay[2] / 2
    work_w = frames[0].shape[1]
    panel_aspect = aspect / GAMING_TOP.get(aspect_name, 0.42)  # W / facecam-panel height
    use_cam = layout in ('auto', 'split', 'speaker')
    hb = [v * s for v in hint] if hint else None
    if hb:
        dets = detect_in(frames, dets, hb)

    def in_overlay(d):
        if not hb:
            return False
        x, y, w, h = d['box']
        return hb[0] <= x + w / 2 <= hb[0] + hb[2] and hb[1] <= y + h / 2 <= hb[1] + hb[3]

    def streamer(lst):
        """The streamer's face in one sample and whether it's in the webcam
        overlay: inside / near the cam box first, else the largest real face."""
        # Any size inside the webcam overlay (a small cam's face can be ~2% of
        # the frame); elsewhere only real-sized faces (not crowds in the game).
        faces = [d for d in lst if d['box'][2] >= work_w * 0.035 or d.get('cam') or in_overlay(d)]
        if not faces:
            return None, False
        if hb:
            # With a webcam overlay on screen, the streamer is the face in it. Faces elsewhere are
            # people in the game (cutscenes put big faces right next to the cam), never the streamer.
            hx, hy, hw, hh = hb
            pad = 0.15
            near = [d for d in faces if hx - hw * pad <= d['box'][0] + d['box'][2] / 2 <= hx + hw * (1 + pad) and hy - hh * pad <= d['box'][1] + d['box'][3] / 2 <= hy + hh * (1 + pad)]
            if near:
                return max(near, key=lambda d: d['box'][2]), True
            return None, False
        return max(faces, key=lambda d: d['box'][2]), False

    found = [streamer(lst) for lst in dets]
    picks = [f for f, _ in found]
    # A face outside any webcam overlay is the streamer's camera full screen
    # (an IRL / just chatting stream, or the stream cut to the cam): there is
    # no gameplay to stack it on, so it's one shot following the face. With
    # no overlay found at all, a face that big is that too (a webcam overlay's
    # face is a few percent of the frame; a small one stays a facecam).
    in_cam = [near if hb else (cam is not False and f is not None and f['box'][2] < work_w * 0.09) for f, near in found]
    # The cam's usual face size; a face far bigger is the editor zooming the
    # cam in: a talking-head moment (crop on the face), not facecam + gameplay.
    widths = sorted(f['box'][2] for f, near in found if f is not None and near)
    typical = widths[len(widths) // 2] if widths else 0
    states = []
    for f in picks:
        if f is None and hb and use_cam:
            states.append('cam')  # the overlay is still on screen (streamer looked away): keep the cam panel
        elif f is None or not use_cam and layout not in ('auto',):
            states.append('none')
        elif not in_cam[len(states)] or f['box'][2] > work_w * 0.22 or (typical and f['box'][2] > typical * 1.7):
            states.append('big')
        else:
            states.append('cam')
    if layout in ('center', 'full'):
        states = ['none'] * len(states)

    half = int(SAMPLE_FPS / 2)
    smooth = []
    for i in range(len(states)):
        win = states[max(0, i - half): i + half + 1]
        smooth.append(max(set(win), key=win.count))
    hold = int(SAMPLE_FPS * 1.5)
    for i in range(len(smooth)):
        if smooth[i] == 'none' and any(x != 'none' for x in smooth[max(0, i - hold):i]) and any(x != 'none' for x in smooth[i + 1:i + 1 + hold]):
            prev = next(x for x in reversed(smooth[max(0, i - hold):i]) if x != 'none')
            smooth[i] = prev

    # Runs, split where the face jumps (an editor moving or zooming the cam).
    runs = []
    for i, st in enumerate(smooth):
        f = picks[i]
        c = (f['box'][0] + f['box'][2] / 2, f['box'][2]) if f else None
        if runs and runs[-1]['st'] == st:
            r = runs[-1]
            if st != 'none' and c and r['c'] and (abs(c[0] - r['c'][0]) > r['c'][1] * 0.8 or not 0.6 < c[1] / r['c'][1] < 1.6) and i - r['lo'] >= SAMPLE_FPS * 0.7:
                runs.append({'st': st, 'lo': i, 'hi': i + 1, 'c': c})
            else:
                r['hi'] = i + 1
                if c and not r['c']:
                    r['c'] = c
        else:
            runs.append({'st': st, 'lo': i, 'hi': i + 1, 'c': c})
    min_n = max(1, int(SAMPLE_FPS * 0.7))
    merged = []
    for r in runs:
        if merged and r['hi'] - r['lo'] < min_n:
            merged[-1]['hi'] = r['hi']
        else:
            merged.append(r)
    if len(merged) > 1 and merged[0]['hi'] - merged[0]['lo'] < min_n:
        merged[1]['lo'] = merged[0]['lo']
        merged.pop(0)

    t_of = lambda i: times[i] if i < len(times) else end
    segs = []
    first_cam = None
    for r in merged:
        seg = {'start': t_of(r['lo']), 'end': t_of(r['hi'])}
        faces = [(0, picks[i]['box']) for i in range(r['lo'], r['hi']) if picks[i] is not None]
        if r['st'] == 'cam' and not faces and hint:
            # No face found this stretch, but the webcam overlay is there: show it as it sits.
            hx, hy, hw, hh = hint
            pw2, ph2 = hw, hw / panel_aspect
            if ph2 > hh:
                ph2, pw2 = hh, hh * panel_aspect
            box = clamp_box(hx + (hw - pw2) / 2, hy + (hh - ph2) * 0.3, pw2, ph2, W, H)
            seg.update({'kind': 'gaming', 'facecam': first_cam or box, 'gameplay': gameplay})
            first_cam = first_cam or box
        elif r['st'] != 'none' and faces:
            cx, cy, fh = median_center(faces, s)
            if r['st'] == 'cam':
                # Head and shoulders, cropped from the top of the head: the panel sits under the
                # captions on the seam and the platforms' own buttons and text cover the bottom
                # of the screen, so the head goes right under the captions (~7% headroom for
                # the half of the caption that overlaps the panel). The hair is ~0.45 face
                # heights above the detected face box.
                head_top = cy - fh * 0.95
                ph = min(H, max(fh * 2.6, H * 0.14))
                pw = ph * panel_aspect
                if pw > W:
                    pw, ph = W, W / panel_aspect
                box = clamp_box(cx - pw / 2, head_top - ph * 0.07, pw, ph, W, H)
                if hint and hint[0] <= cx <= hint[0] + hint[2] and hint[1] <= cy <= hint[1] + hint[3]:
                    # Inside the webcam overlay: stay inside it (no gameplay bleeding into the panel).
                    hx, hy, hw, hh = hint
                    ph2 = min(ph, hh)
                    pw2 = ph2 * panel_aspect
                    if pw2 > hw:
                        pw2, ph2 = hw, hw / panel_aspect
                    bx = min(max(hx, cx - pw2 / 2), hx + hw - pw2)
                    by = min(max(hy, head_top - ph2 * 0.07), hy + hh - ph2)
                    box = clamp_box(bx, by, pw2, ph2, W, H)
                seg.update({'kind': 'gaming', 'facecam': box, 'gameplay': gameplay})
                first_cam = first_cam or box
            elif chat and r['st'] == 'big' and not in_cam[r['lo']]:
                # The streamer's camera full screen: their talking head over the chat feed.
                top_aspect = aspect / (1 - GAMING_TOP.get(aspect_name, 0.42))
                seg.update({'kind': 'camchat', 'box': crop_around(cx, cy, top_aspect, W, H, min(1.0, max(0.55, fh * 3.6 / H))), 'chat': chat})
            else:
                seg.update({'kind': 'single', 'box': crop_around(cx, cy, aspect, W, H, min(1.0, max(0.62, fh * 4.2 / H)))})
        else:
            seg.update({'kind': 'full', 'box': crop_around(gcx, H / 2, aspect, W, H)})
        segs.append(seg)
    return first_cam or hint, merge(segs)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('clip')
    ap.add_argument('--style', default='podcast')
    ap.add_argument('--aspect', default='9:16')
    ap.add_argument('--layout', default='auto')
    ap.add_argument('--boxes', default='{}')
    a = ap.parse_args()
    aspect = parse_aspect(a.aspect)
    boxes = json.loads(a.boxes or '{}')
    frames, times, W, H, duration = read_samples(a.clip, SAMPLE_FPS)
    if not frames:
        print(json.dumps({'error': 'no frames'}))
        sys.exit(1)
    s = WORK_W / W
    end = duration
    plan = {'source': {'w': W, 'h': H, 'duration': round(duration, 3)}, 'facecam': None}

    # A crop box the user set wins for the whole clip.
    if boxes.get('crop'):
        c = boxes['crop']
        plan['segments'] = [{'start': 0.0, 'end': end, 'kind': 'single', 'box': [int(c['x'] * W), int(c['y'] * H), int(c['w'] * W), int(c['h'] * H)]}]
        print(json.dumps(plan))
        return
    if boxes.get('top') and boxes.get('bottom'):
        bx = [[int(b['x'] * W), int(b['y'] * H), int(b['w'] * W), int(b['h'] * H)] for b in (boxes['top'], boxes['bottom'])]
        plan['segments'] = [{'start': 0.0, 'end': end, 'kind': 'split', 'boxes': bx}]
        print(json.dumps(plan))
        return
    if a.layout == 'blur':
        plan['segments'] = [{'start': 0.0, 'end': end, 'kind': 'blur'}]
        print(json.dumps(plan))
        return

    if a.layout == 'follow':
        big, _, _, _, _ = read_samples(a.clip, SAMPLE_FPS, FOLLOW_W)
        dets = detect(big)
        plan['faces'] = int(max((len(d) for d in dets), default=0))
        plan['segments'] = follow_plan(big, times, dets, W, H, aspect, FOLLOW_W / W)
        if plan['segments']:
            plan['segments'][0]['start'] = 0.0
            plan['segments'][-1]['end'] = round(max(end, plan['segments'][-1]['end']), 3)
        print(json.dumps(plan))
        return

    dets = detect(frames)
    plan['faces'] = int(max((len(d) for d in dets), default=0))
    if a.style == 'gaming':
        plan['facecam'], plan['segments'] = gaming_plan(frames, times, dets, W, H, aspect, a.layout, s, boxes, a.aspect)
    else:
        if boxes.get('face'):
            f = boxes['face']
            cx, cy = (f['x'] + f['w'] / 2) * W, (f['y'] + f['h'] / 2) * H
            plan['segments'] = [{'start': 0.0, 'end': end, 'kind': 'single', 'box': crop_around(cx, cy, aspect, W, H, min(1.0, max(0.62, f['h'] * 4.2)))}]
        else:
            plan['segments'] = podcast_plan(frames, times, dets, W, H, aspect, a.layout, s)
    if plan['segments']:
        plan['segments'][0]['start'] = 0.0
        plan['segments'][-1]['end'] = round(max(end, plan['segments'][-1]['end']), 3)
    print(json.dumps(plan))


if __name__ == '__main__':
    main()
