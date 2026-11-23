// Clippy render: one ffmpeg pass from a cut source clip to the finished edit.
//
// The clip is split into pieces: the layout plan's segments (analyze.py)
// intersected with the kept ranges (dead air cut out). Each piece is its own
// input (-ss/-t on the same file, so nothing is buffered across the clip),
// framed per its segment kind (single-speaker stretches alternate wide and
// punched in, see punchIns), then all pieces are concatenated with their
// audio (sync can't drift), captions (ASS) burned in, reaction GIFs overlaid,
// loudness normalised to -14 LUFS, H.264 + AAC with fast start.

import fs from 'node:fs';
import { FONTS_DIR } from './captions.mjs';

export const OUTPUT = { '9:16': [1080, 1920], '4:5': [1080, 1350], '1:1': [1080, 1080], '16:9': [1920, 1080] };
const even = (n) => Math.max(2, Math.round(n / 2) * 2);

/** The part of `box` at aspect `a` (w/h), cropped inside it around its centre. */
export function fitInside([x, y, w, h], a, W, H) {
  let cw = w;
  let ch = w / a;
  if (ch > h) { ch = h; cw = h * a; }
  const cx = x + w / 2;
  const cy = y + h / 2;
  const nx = Math.min(Math.max(0, cx - cw / 2), W - cw);
  const ny = Math.min(Math.max(0, cy - ch / 2), H - ch);
  return [even(nx), even(ny), even(Math.min(cw, W)), even(Math.min(ch, H))];
}

/** Output-timeline pieces: segments x kept ranges. */
export function piecesOf(segments, keep) {
  const out = [];
  for (const [a, b] of keep) {
    for (const s of segments) {
      const lo = Math.max(a, s.start);
      const hi = Math.min(b, s.end);
      if (hi - lo >= 0.08) out.push({ a: lo, b: hi, seg: s });
    }
  }
  out.sort((p, q) => p.a - q.a);
  return out;
}

/** Map a source-clip time to the output timeline (null when it was cut). */
export function mapTime(t, keep) {
  let acc = 0;
  for (const [a, b] of keep) {
    if (t < a) return null;
    if (t <= b) return acc + (t - a);
    acc += b - a;
  }
  return null;
}

// Gaming split: gameplay on top, the streamer's camera below it, taking this share of the height
// (analyze.py's GAMING_TOP is the same numbers: it sizes the facecam panel).
export const GAMING_CAM = { '9:16': 0.42, '4:5': 0.4, '1:1': 0.4 };

/** Split layouts whose seam sits at seamOf(): gameplay over facecam, talking head over chat. */
export const SEAMED = new Set(['gaming', 'camchat']);

/** y of the line between gameplay and facecam, where the captions sit. */
export function seamOf(aspect) {
  const [, H] = OUTPUT[aspect] ?? OUTPUT['9:16'];
  return GAMING_CAM[aspect] ? H - even(H * GAMING_CAM[aspect]) : null;
}

/** Punch-in: `box` zoomed by z around its upper middle (where the face sits). */
function zoomBox([x, y, w, h], z) {
  if (!z || z <= 1) return [x, y, w, h];
  const nw = w / z;
  const nh = h / z;
  const cx = x + w / 2;
  const cy = y + h * 0.42;
  return [Math.min(Math.max(x, cx - nw / 2), x + w - nw), Math.min(Math.max(y, cy - nh / 2), y + h - nh), nw, nh];
}

/**
 * Podcast punch-ins: a single-speaker stretch is split every ~`every` s at a
 * word gap and alternates wide / punched in, so the frame resets the way a hand
 * edit does (a static shot for 50 s is where viewers swipe). A speaker change
 * is a cut of its own, so it starts wide again.
 */
export function punchIns(pieces, words = [], { every = 3.2, zoom = 1.2 } = {}) {
  const gaps = [];
  for (let i = 1; i < words.length; i++) if (words[i][1] - words[i - 1][2] >= 0.04) gaps.push((words[i][1] + words[i - 1][2]) / 2);
  const out = [];
  let n = 0;
  let prev = null;
  for (const p of pieces) {
    if (p.seg.kind !== 'single' && p.seg.kind !== 'follow') { out.push(p); prev = null; continue; }
    // The clip opens on the close shot (a static wide first frame costs the hook); a speaker change starts wide.
    if (p.seg !== prev) n = prev === null && !out.length ? 1 : 0;
    prev = p.seg;
    let a = p.a;
    while (p.b - a > every * 1.5) {
      const target = a + every;
      const cut = gaps.filter((g) => g > a + 1.6 && g < p.b - 1.6 && Math.abs(g - target) <= 1.4)
        .sort((x, y) => Math.abs(x - target) - Math.abs(y - target))[0];
      if (cut == null) break;
      out.push({ ...p, a, b: cut, zoom: n++ % 2 ? zoom : 1 });
      a = cut;
    }
    out.push({ ...p, a, zoom: n++ % 2 ? zoom : 1 });
  }
  return out;
}

// Layout "follow" (stand-up): the face sits centred across and this far down the frame.
const FOLLOW_FACE_Y = 0.3;

/** A piecewise-linear ffmpeg expression of t (seconds into the piece) through [[t, v], ...]. */
function lerpExpr(points) {
  if (points.length === 1) return points[0][1].toFixed(1);
  let expr = points[points.length - 1][1].toFixed(1);
  for (let i = points.length - 2; i >= 0; i--) {
    const [t0, v0] = points[i];
    const [t1, v1] = points[i + 1];
    const seg = t1 - t0 > 1e-3 ? `${v0.toFixed(1)}+(${(v1 - v0).toFixed(1)})*(t-${t0.toFixed(3)})/${(t1 - t0).toFixed(3)}` : v1.toFixed(1);
    expr = `if(lt(t,${t1.toFixed(3)}),${seg},${expr})`;
  }
  return expr;
}

/** The face path of a follow segment inside one piece, re-timed to the piece (t = 0 at its start), ~3 points a second. */
function piecePath(path, a, b) {
  const at = (t) => {
    if (t <= path[0][0]) return [path[0][1], path[0][2]];
    for (let i = 1; i < path.length; i++) {
      if (t <= path[i][0]) {
        const [t0, x0, y0] = path[i - 1];
        const [t1, x1, y1] = path[i];
        const k = t1 > t0 ? (t - t0) / (t1 - t0) : 0;
        return [x0 + (x1 - x0) * k, y0 + (y1 - y0) * k];
      }
    }
    const l = path[path.length - 1];
    return [l[1], l[2]];
  };
  const n = Math.max(2, Math.ceil((b - a) * 3) + 1);
  return Array.from({ length: n }, (_, i) => {
    const t = a + ((b - a) * i) / (n - 1);
    const [x, y] = at(t);
    return [t - a, x, y];
  });
}

function frameChain(seg, src, W, H, aspect, fps, label, zoom = 1, start = 0, end = 0) {
  const tail = `setsar=1,fps=${fps},format=yuv420p`;
  const crop = (b) => `crop=${b[2]}:${b[3]}:${b[0]}:${b[1]}`;
  const sc = (w, h) => `scale=${w}:${h}:flags=lanczos`;
  const [sw, sh] = [src.w, src.h];
  const i = label;
  switch (seg.kind) {
    case 'single':
    case 'full': {
      const b = fitInside(zoomBox(seg.box, seg.kind === 'single' ? zoom : 1), W / H, sw, sh);
      return `[${i}:v]${crop(b)},${sc(W, H)},${tail}[v${i}]`;
    }
    case 'split': {
      const h1 = even(H / 2);
      const [t, bt] = seg.boxes.map((b) => fitInside(b, W / h1, sw, sh));
      return `[${i}:v]split=2[a${i}][b${i}];[a${i}]${crop(t)},${sc(W, h1)}[at${i}];[b${i}]${crop(bt)},${sc(W, H - h1)}[bt${i}];[at${i}][bt${i}]vstack,${tail}[v${i}]`;
    }
    case 'gaming': {
      if (!GAMING_CAM[aspect]) {
        // Landscape: gameplay fills, the facecam sits top-left.
        const g = fitInside([0, 0, sw, sh], W / H, sw, sh);
        const cw = even(W * 0.28);
        const fc = seg.facecam;
        const ch = even(cw * (fc[3] / fc[2]));
        return `[${i}:v]split=2[g${i}][c${i}];[g${i}]${crop(g)},${sc(W, H)}[gs${i}];[c${i}]${crop(fc)},${sc(cw, ch)}[cs${i}];[gs${i}][cs${i}]overlay=24:24,${tail}[v${i}]`;
      }
      const camH = even(H * GAMING_CAM[aspect]);
      const cam = fitInside(seg.facecam, W / camH, sw, sh);
      const game = fitInside(seg.gameplay, W / (H - camH), sw, sh);
      return `[${i}:v]split=2[c${i}][g${i}];[c${i}]${crop(cam)},${sc(W, camH)}[ct${i}];[g${i}]${crop(game)},${sc(W, H - camH)}[gt${i}];[gt${i}][ct${i}]vstack,${tail}[v${i}]`;
    }
    case 'camchat': {
      // The streamer's camera full screen: talking head on top, the chat feed below at
      // a readable size on a dark panel (never cropped: chat is text). Landscape: head only.
      if (!GAMING_CAM[aspect]) {
        const b = fitInside(seg.box, W / H, sw, sh);
        return `[${i}:v]${crop(b)},${sc(W, H)},${tail}[v${i}]`;
      }
      const chatH = even(H * GAMING_CAM[aspect]);
      const head = fitInside(seg.box, W / (H - chatH), sw, sh);
      const c = [even(seg.chat[0]), even(seg.chat[1]), even(Math.min(seg.chat[2], sw - seg.chat[0])), even(Math.min(seg.chat[3], sh - seg.chat[1]))];
      const pad = 36;
      return `[${i}:v]split=2[h${i}][c${i}];[h${i}]${crop(head)},${sc(W, H - chatH)}[ht${i}];`
        + `[c${i}]${crop(c)},scale=${W - pad * 2}:${chatH - pad * 2}:force_original_aspect_ratio=decrease:flags=lanczos,`
        + `pad=${W}:${chatH}:(ow-iw)/2:(oh-ih)/2:color=0x0b0f14[cb${i}];[ht${i}][cb${i}]vstack,${tail}[v${i}]`;
    }
    case 'follow': {
      // Crop size fixed for the shot (zoomed for punch-ins), its position follows the face.
      const z = zoom && zoom > 1 ? zoom : 1;
      const cw = even(Math.min(sw, seg.size[0] / z));
      const ch = even(Math.min(sh, seg.size[1] / z));
      const pts = piecePath(seg.path, start, end);
      const xe = `clip(${lerpExpr(pts.map(([t, x]) => [t, x]))}-${cw / 2},0,${sw - cw})`;
      const ye = `clip(${lerpExpr(pts.map(([t, , y]) => [t, y]))}-${(ch * FOLLOW_FACE_Y).toFixed(1)},0,${sh - ch})`;
      return `[${i}:v]crop=w=${cw}:h=${ch}:x='${xe}':y='${ye}',${sc(W, H)},${tail}[v${i}]`;
    }
    default: { // blur
      const bw = even(W / 4);
      const bh = even(H / 4);
      return `[${i}:v]split=2[bg${i}][fg${i}];[bg${i}]scale=${bw}:${bh}:force_original_aspect_ratio=increase,crop=${bw}:${bh},gblur=sigma=12,eq=brightness=-0.08,scale=${W}:${H}[bb${i}];`
        + `[fg${i}]scale=${W}:${H}:force_original_aspect_ratio=decrease:force_divisible_by=2[fs${i}];[bb${i}][fs${i}]overlay=(W-w)/2:(H-h)/2,${tail}[v${i}]`;
    }
  }
}

const q = (p) => `'${String(p).replace(/\\/g, '/').replace(/'/g, "'\\''").replace(/:/g, '\\:')}'`;

/**
 * Render the edit. gifs: [{ file, at, dur }] on the output timeline. hookImg: { file, y, end },
 * the hook as TikTok's text box (a PNG from hookbox.py), shown from 0 to `end` s. logoImg:
 * { file, width, y } (fractions of the frame), a brand logo kept on screen for the whole clip,
 * drawn last so captions, the hook and GIFs never cover it. Returns the ffmpeg args (caller runs them).
 */
export function renderArgs({ src, srcInfo, out, plan, keep, aspect, design, assPath, gifs = [], captionsAt = 'bottom', words = [], hookImg = null, logoImg = null }) {
  const [W, H] = OUTPUT[aspect] ?? OUTPUT['9:16'];
  const fps = design?.fps === 60 && (srcInfo.fps ?? 30) > 45 ? 60 : 30;
  let pieces = piecesOf(plan.segments, keep);
  if (design?.punch_in !== false) pieces = punchIns(pieces, words);
  if (!pieces.length) throw new Error('Nothing left to render after cutting the pauses.');
  // Every piece is its own input, and each input's decoder starts a thread per CPU the container reports:
  // 4 renders at once ran the worker out of threads ("Resource temporarily unavailable", which libx264
  // reports as -22, 2026-11-23). Two decode threads per input and a capped filter graph / encoder.
  const T = String(process.env.CLIPPER_RENDER_THREADS ?? 2);
  const args = ['-y', '-hide_banner', '-loglevel', 'error', '-nostdin', '-filter_complex_threads', T];
  for (const p of pieces) args.push('-threads', T, '-ss', p.a.toFixed(3), '-t', (p.b - p.a).toFixed(3), '-i', src);
  const g0 = pieces.length;
  for (const g of gifs) args.push('-stream_loop', '-1', '-t', g.dur.toFixed(2), '-i', g.file);
  const hi = g0 + gifs.length;
  if (hookImg) args.push('-loop', '1', '-framerate', String(fps), '-t', hookImg.end.toFixed(2), '-i', hookImg.file);
  const li = hi + (hookImg ? 1 : 0);
  const outDur = pieces.reduce((acc, p) => acc + (p.b - p.a), 0);
  if (logoImg) args.push('-loop', '1', '-framerate', String(fps), '-t', (outDur + 1).toFixed(2), '-i', logoImg.file);
  const chains = [];
  const concatIn = [];
  pieces.forEach((p, i) => {
    chains.push(frameChain(p.seg, srcInfo, W, H, aspect, fps, i, p.zoom, p.a, p.b));
    chains.push(srcInfo.audio
      ? `[${i}:a]aresample=48000,aformat=channel_layouts=stereo,asetpts=PTS-STARTPTS[a${i}]`
      : `aevalsrc=0|0:d=${(p.b - p.a).toFixed(3)}:s=48000[a${i}]`);
    concatIn.push(`[v${i}][a${i}]`);
  });
  chains.push(`${concatIn.join('')}concat=n=${pieces.length}:v=1:a=1[vc][ac]`);
  let last = 'vc';
  if (assPath) {
    chains.push(`[vc]subtitles=filename=${q(assPath)}:fontsdir=${q(FONTS_DIR)}[vs]`);
    last = 'vs';
  }
  if (hookImg) {
    const fadeOut = Math.max(0.1, hookImg.end - 0.2);
    chains.push(`[${hi}:v]format=rgba,fade=t=in:st=0:d=0.08:alpha=1,fade=t=out:st=${fadeOut.toFixed(2)}:d=0.2:alpha=1[hk]`);
    chains.push(`[${last}][hk]overlay=(W-w)/2:${Math.round(hookImg.y)}:eof_action=pass[hko]`);
    last = 'hko';
  }
  const gifY = captionsAt === 'top' ? Math.round(H * 0.58) : Math.round(H * 0.3);
  gifs.forEach((g, k) => {
    const idx = g0 + k;
    chains.push(`[${idx}:v]scale=${even(W * 0.5)}:-2,setpts=PTS-STARTPTS+${g.at.toFixed(3)}/TB[gf${k}]`);
    chains.push(`[${last}][gf${k}]overlay=(W-w)/2:${gifY}:enable='between(t,${g.at.toFixed(2)},${(g.at + g.dur).toFixed(2)})':eof_action=pass[go${k}]`);
    last = `go${k}`;
  });
  if (logoImg) {
    chains.push(`[${li}:v]format=rgba,scale=${even(W * logoImg.width)}:-2[lg]`);
    chains.push(`[${last}][lg]overlay=(W-w)/2:${Math.round(H * logoImg.y)}:shortest=1[lgo]`);
    last = 'lgo';
  }
  chains.push(`[${last}]format=yuv420p[vout]`);
  chains.push(`[ac]loudnorm=I=-14:TP=-1.5:LRA=11,aresample=48000[aout]`);
  args.push('-filter_complex', chains.join(';'), '-map', '[vout]', '-map', '[aout]',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-r', String(fps), '-threads', String(process.env.CLIPPER_ENCODE_THREADS ?? 4),
    '-c:a', 'aac', '-b:a', '160k', '-ar', '48000', '-movflags', '+faststart', out);
  return { args, W, H, fps, pieces: pieces.length, duration: keep.reduce((s, [a, b]) => s + (b - a), 0) };
}

/** Kept ranges: the words with pauses longer than `gap` cut down to `pad` each side. */
export function keepRanges(words, duration, { cut = true, gap = 0.7, pad = 0.18 } = {}) {
  if (!cut || !words?.length) return [[0, duration]];
  const out = [];
  let a = Math.max(0, words[0][1] - pad);
  let b = Math.min(duration, words[0][2] + pad);
  for (const [, s, e] of words.slice(1)) {
    if (s - b > gap) {
      out.push([a, b]);
      a = Math.max(b, s - pad);
    }
    b = Math.min(duration, Math.max(b, e + pad));
  }
  out.push([a, Math.min(duration, b + 0.25)]);
  // Too many tiny pieces makes a choppy edit: keep pauses under 1.2 s if so.
  if (out.length > 40 && gap < 1.2) return keepRanges(words, duration, { cut, gap: 1.2, pad });
  return out.filter(([x, y]) => y - x > 0.05);
}

export function fileExists(p) {
  try { return fs.statSync(p).size > 0; } catch { return false; }
}
