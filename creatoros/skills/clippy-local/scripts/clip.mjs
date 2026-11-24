#!/usr/bin/env node
// Clippy, local: the clipping engine on the user's own machine, driven by their own Claude
// (Claude Code reads the transcript and picks the moments; nothing here calls an AI model).
//
//   node clip.mjs prepare <url|file> --out <dir> [--from s] [--to s]
//   node clip.mjs render <dir> [--picks picks.json] [--style podcast|gaming] [--layout auto] [--aspect 9:16]
//                        [--design design.json | --autopilot <id>] [--min-s 20] [--names "Astra, Sinaloa"]
//   node clip.mjs upload <dir> [--autopilot <id>] [--yes] [--api https://mcp.creatoros.ca]
//
// The engine (captions.mjs, edits.mjs, render.mjs, analyze.py, transcribe.py, hookbox.py, the face
// model and the fonts) is a copy of worker/clipper + worker/variations/fonts, laid next to this file by
// plugin/scripts/sync-skills.mjs. `render` mirrors renderVersion in processClip
// (worker/src/clipper.mjs) minus every Claude step (proofread, facecam locate, scoring, polish) and
// the Giphy GIFs: when that function changes, change this one too.
//
// Times in picks.json are seconds in the ORIGINAL video (the marks in transcript.txt).
// Needs: node 20+, ffmpeg with libass (the `subtitles` filter), python3 with numpy, opencv-python,
// Pillow and faster-whisper, and yt-dlp for links. Upload needs CREATOROS_API_KEY (a cos_live_ key).

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FFMPEG = process.env.FFMPEG_BIN || 'ffmpeg';
const FFPROBE = process.env.FFPROBE_BIN || 'ffprobe';
const PYTHON = process.env.CLIPPY_PYTHON || 'python3';

// The engine: next to this file in the plugin, else the repo's worker/clipper (running from the source).
function engineDir() {
  const cands = [process.env.CLIPPY_ENGINE, path.join(HERE, 'clipper'), path.join(HERE, '..', '..', '..', '..', 'worker', 'clipper')].filter(Boolean);
  const dir = cands.find((d) => fs.existsSync(path.join(d, 'render.mjs')));
  if (!dir) die('Could not find the clipping engine (clipper/render.mjs next to clip.mjs). Reinstall the creatoros plugin or set CLIPPY_ENGINE.');
  return dir;
}

function die(msg) {
  console.error(`clip: ${msg}`);
  process.exit(1);
}

function args(argv) {
  const pos = [];
  const opt = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const v = argv[i + 1];
      if (v == null || v.startsWith('--')) opt[k] = true;
      else { opt[k] = v; i++; }
    } else pos.push(a);
  }
  return { pos, opt };
}

/** Runs a command; resolves stdout, rejects with the tail of stderr. `passErr` streams stderr through. */
function run(cmd, argv, { passErr = false, timeout = 3 * 3600_000 } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, argv, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const t = setTimeout(() => p.kill('SIGKILL'), timeout);
    p.stdout.on('data', (b) => { out += b; });
    p.stderr.on('data', (b) => {
      err = (err + b).slice(-4000);
      if (passErr) process.stderr.write(b);
    });
    p.on('error', (e) => { clearTimeout(t); reject(new Error(`${cmd}: ${e.message}`)); });
    p.on('close', (code) => {
      clearTimeout(t);
      if (code === 0) resolve(out);
      else reject(new Error(`${path.basename(cmd)} failed: ${err.trim().split('\n').slice(-3).join(' ')}`));
    });
  });
}

async function probe(file) {
  const j = JSON.parse(await run(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,width,height,avg_frame_rate,start_time', '-of', 'json', file]));
  const v = (j.streams ?? []).find((s) => s.codec_type === 'video');
  const [a, b] = String(v?.avg_frame_rate ?? '30/1').split('/').map(Number);
  const au = (j.streams ?? []).find((s) => s.codec_type === 'audio');
  return { w: v?.width ?? 0, h: v?.height ?? 0, fps: b ? a / b : 30, duration: Number(j.format?.duration ?? 0), audio: !!au,
    vstart: Number(v?.start_time ?? 0) || 0, astart: Number(au?.start_time ?? 0) || 0 };
}

const stamp = (t) => {
  const s = Math.max(0, t);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = (s % 60).toFixed(1).padStart(4, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
};
const noDash = (s) => String(s ?? '').replace(/\s*[—–]\s*/g, ', ').trim();
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));

// ── prepare ──────────────────────────────────────────────────────────────────

async function prepare(input, opt) {
  if (!input) die('prepare needs a video link or file.');
  const dir = path.resolve(opt.out || 'clippy-job');
  fs.mkdirSync(dir, { recursive: true });
  const ENGINE = engineDir();
  const from = opt.from != null ? Number(opt.from) : null;
  const to = opt.to != null ? Number(opt.to) : null;
  if ((from != null && !(from >= 0)) || (to != null && !(to > (from ?? 0)))) die('--from / --to are seconds, --to after --from.');

  let video;
  let offset = 0; // where the local file starts in the original video
  let meta = { title: null, creator: null, url: null };
  if (fs.existsSync(input)) {
    // A local file is read in place (no copy: source videos are big).
    video = path.resolve(input);
    meta.title = path.basename(input).replace(/\.[^.]+$/, '');
  } else if (/^https?:\/\//i.test(input)) {
    console.error('Downloading the video (up to 1080p)...');
    const section = from != null || to != null ? ['--download-sections', `*${from ?? 0}-${to ?? 'inf'}`, '--force-keyframes-at-cuts'] : [];
    const out = await run('yt-dlp', [
      '--no-warnings', '--no-playlist', '-f', 'bv*[height<=1080][ext=mp4]+ba[ext=m4a]/bv*[height<=1080]+ba/b[height<=1080]/best',
      '--merge-output-format', 'mp4', ...section, '-o', path.join(dir, 'source.%(ext)s'),
      '--print', 'before_dl:%(title)s\t%(uploader)s\t%(webpage_url)s', '--print', 'after_move:filepath', input,
    ], { passErr: true });
    const lines = out.trim().split('\n');
    const [title, creator, url] = (lines[0] ?? '').split('\t');
    meta = { title: title || null, creator: creator && creator !== 'NA' ? creator : null, url: url || input };
    video = lines[lines.length - 1].trim();
    if (!fs.existsSync(video)) die('yt-dlp did not produce a file.');
    if (section.length) offset = from ?? 0;
  } else die(`${input} is not a file or an http(s) link.`);

  const info = await probe(video);
  if (!info.w) die('That file has no video stream.');
  // The part to transcribe, in file time.
  const a = from != null && offset === 0 ? from : 0;
  const b = to != null && offset === 0 ? Math.min(to, info.duration) : info.duration;
  const wav = path.join(dir, 'scan.wav');
  console.error(`Extracting ${Math.round(b - a)} s of audio...`);
  await run(FFMPEG, ['-y', '-loglevel', 'error', '-ss', String(a), '-t', String(b - a), '-i', video, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', wav]);
  console.error('Transcribing (faster-whisper on this machine; about 5x faster than real time on a laptop)...');
  const tr = JSON.parse(await run(PYTHON, [path.join(ENGINE, 'transcribe.py'), wav, '--offset', String(a + offset), '--model', process.env.CLIPPY_WHISPER_MODEL || 'base.en'], { passErr: false }));
  fs.rmSync(wav, { force: true });

  const segments = tr.segments ?? [];
  const loud = tr.loud ?? [];
  fs.writeFileSync(path.join(dir, 'transcript.json'), JSON.stringify({ segments, loud }));
  const lines = [
    ...segments.map(([s, , t]) => ({ t: s, line: `[${stamp(s)} | ${s.toFixed(1)}s] ${t}` })),
    ...loud.map(([t, db]) => ({ t, line: `[${stamp(t)} | ${Number(t).toFixed(1)}s] LOUD +${Math.round(db)} dB` })),
  ].sort((x, y) => x.t - y.t).map((x) => x.line);
  fs.writeFileSync(path.join(dir, 'transcript.txt'), lines.join('\n') + '\n');
  const source = { ...meta, video, offset, duration: info.duration + offset, scanned: { from: a + offset, to: b + offset }, width: info.w, height: info.h };
  fs.writeFileSync(path.join(dir, 'source.json'), JSON.stringify(source, null, 2));
  console.log(JSON.stringify({ dir, title: meta.title, duration_s: Math.round(source.duration), scanned: source.scanned, lines: segments.length, transcript: path.join(dir, 'transcript.txt') }, null, 2));
}

// ── render ───────────────────────────────────────────────────────────────────

const ASPECTS = { '9:16': [1080, 1920], '4:5': [1080, 1350], '1:1': [1080, 1080], '16:9': [1920, 1080] };

async function apiGet(p, opt) {
  const key = process.env.CREATOROS_API_KEY;
  if (!key) die('Set CREATOROS_API_KEY (your cos_live_ key) to read an autopilot.');
  const base = String(opt.api || process.env.CREATOROS_API_URL || 'https://mcp.creatoros.ca').replace(/\/$/, '');
  const res = await fetch(`${base}${p}`, { headers: { authorization: `Bearer ${key}` } });
  const j = await res.json().catch(() => null);
  if (!res.ok) die(`${p}: ${j?.error?.message ?? res.status}`);
  return j;
}

async function render(dirArg, opt) {
  const dir = path.resolve(dirArg || '.');
  if (!fs.existsSync(path.join(dir, 'source.json'))) die(`${dir} has no source.json: run prepare first.`);
  const ENGINE = engineDir();
  const imp = (f) => import(pathToFileURL(path.join(ENGINE, f)).href);
  const { buildAss, FONT_FILES, FONTS_DIR, mergeDesign } = await imp('captions.mjs');
  const { applyFixes, findPhrase, intersect, subtract } = await imp('edits.mjs');
  const { SEAMED, alignArgs, keepRanges, mapTime, renderArgs, seamOf } = await imp('render.mjs');

  const source = readJson(path.join(dir, 'source.json'));
  const segments = fs.existsSync(path.join(dir, 'transcript.json')) ? readJson(path.join(dir, 'transcript.json')).segments ?? [] : [];
  const picksFile = path.resolve(opt.picks || path.join(dir, 'picks.json'));
  if (!fs.existsSync(picksFile)) die(`No picks at ${picksFile}. Write your picks there (see the skill) and run render again.`);
  const raw = readJson(picksFile);
  const picks = (Array.isArray(raw) ? raw : raw.clips ?? []).slice(0, 10);
  if (!picks.length) die('picks.json has no clips.');

  // Settings: an autopilot's (its design and length), then the flags.
  let design = {};
  let minS = 20;
  let style = 'podcast';
  let layout = 'auto';
  let aspect = '9:16';
  if (opt.autopilot) {
    const { autopilots } = await apiGet('/v1/clipper/autopilots', opt);
    const ap = (autopilots ?? []).find((x) => x.id === opt.autopilot);
    if (!ap) die(`No autopilot ${opt.autopilot} in this workspace.`);
    design = ap.design ?? {};
    minS = Number(ap.min_s) || minS;
    style = ap.style || style;
    layout = ap.layout || layout;
  }
  if (opt.design) design = { ...design, ...readJson(path.resolve(opt.design)) };
  if (opt['min-s']) minS = Number(opt['min-s']);
  if (opt.style) style = String(opt.style);
  if (opt.layout) layout = String(opt.layout);
  if (opt.aspect) aspect = String(opt.aspect);
  if (!['podcast', 'gaming'].includes(style)) die('--style is podcast or gaming.');
  if (!ASPECTS[aspect]) die(`--aspect is one of ${Object.keys(ASPECTS).join(', ')}.`);

  const outDir = path.join(dir, 'out');
  fs.mkdirSync(outDir, { recursive: true });
  const manifest = { source: { title: source.title, creator: source.creator, url: source.url }, style, aspect, clips: [] };
  let n = 0;
  for (const pick of picks) {
    n += 1;
    const label = `clip ${n}/${picks.length} ${JSON.stringify(pick.title ?? '')}`;
    const work = path.join(dir, `work_${n}`);
    fs.mkdirSync(work, { recursive: true });
    try {
      const k = { ...pick, design: mergeDesign(design, pick.design ?? {}), aspect, layout: pick.layout ?? layout, trims: pick };
      const trims = k.trims;
      // Source time -> file time.
      const start = Number(pick.start) - source.offset;
      const end = Number(pick.end) - source.offset;
      if (!(end > start) || start < 0) throw new Error('start / end are seconds in the original video, end after start.');
      // Word anchors may sit a little outside the rough times: cut with room.
      const pad = trims.start_words || trims.end_words || trims.drops?.length ? 3 : 0;
      const cutFrom = Math.max(0, start - pad);
      const minLen = Math.max(8, minS);
      const dropped = (trims.drops ?? []).reduce((s, d) => s + Math.max(0, Number(d.end_s) - Number(d.start_s)), 0);
      const tail = end - start - dropped < minLen + 4 ? minLen + 10 - (end - start - dropped) : 0;

      console.error(`${label}: cutting`);
      const src = path.join(work, 'src.mp4');
      const dur = end + pad + tail - cutFrom;
      await run(FFMPEG, ['-y', '-loglevel', 'error', '-ss', cutFrom.toFixed(3), '-i', source.video, '-t', dur.toFixed(3), '-map', '0:v:0', '-map', '0:a:0?',
        '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '16', '-c:a', 'aac', '-b:a', '192k', src]);
      let info = await probe(src);
      if (!info.w || info.duration < 1) throw new Error('Could not cut that part of the video.');
      // Same sync check as Creator OS: a start gap between audio and video plays as broken lip sync.
      const fix = alignArgs(src, path.join(work, 'src-aligned.mp4'), info);
      if (fix) {
        await run(FFMPEG, fix);
        fs.renameSync(path.join(work, 'src-aligned.mp4'), src);
        console.error(`${label}: lined up audio and video (${Math.abs(info.vstart - info.astart).toFixed(2)} s apart)`);
        info = await probe(src);
      }

      console.error(`${label}: captioning`);
      const wav = path.join(work, 'words.wav');
      await run(FFMPEG, ['-y', '-loglevel', 'error', '-i', src, '-t', '400', '-vn', '-ac', '1', '-ar', '16000', wav]);
      // Whisper's prompt is spelling help only (--names "Astra, Sinaloa"). No titles: a prompt that
      // reads like the speech (the clip's title) or a file name made it skip the opening words or
      // return nothing (seen 2026-11-22), so the server's title prompt isn't copied here.
      const prompt = typeof opt.names === 'string' ? opt.names.slice(0, 300) : '';
      // numpy on Apple's Accelerate sometimes garbles Whisper's mel features ("overflow encountered in
      // matmul"): words go missing or come back as noise. Check against the coarse transcript of the
      // same stretch and try again (up to 3 times), keeping the best take.
      const expected = segments.filter(([s, e]) => e > cutFrom + source.offset && s < cutFrom + dur + source.offset)
        .reduce((x, [, , t]) => x + t.split(/\s+/).filter(Boolean).length, 0);
      let heard = [];
      for (let attempt = 1; attempt <= 3; attempt++) {
        let got = [];
        try {
          got = JSON.parse(await run(PYTHON, [path.join(ENGINE, 'transcribe.py'), wav, '--words', '--model', process.env.CLIPPY_CAPTION_MODEL || 'small.en', ...(prompt ? ['--prompt', prompt] : [])])).words ?? [];
        } catch (e) {
          console.error(`${label}: transcription failed (${e.message.slice(0, 120)})`);
        }
        const clean = got.filter((w) => w[0].length <= 25);
        if (clean.length > heard.length) heard = clean;
        if (clean.length === got.length && clean.length >= expected * 0.75) break;
        if (attempt < 3) console.error(`${label}: the word timings came back short (${got.length} of ~${expected} words), transcribing again`);
      }
      const allWords = applyFixes(heard, trims.fixes);

      // Snap the start / end / drops onto the spoken words (same rules as the server).
      let a = start - cutFrom;
      let b = Math.min(info.duration, end - cutFrom);
      const sw = trims.start_words ? findPhrase(allWords, trims.start_words, a) : null;
      if (sw) a = Math.max(0, allWords[sw.first][1] - 0.12, sw.first > 0 ? allWords[sw.first - 1][2] + 0.03 : 0);
      const ew = trims.end_words ? findPhrase(allWords, trims.end_words, b) : null;
      if (ew && allWords[ew.last][2] > a + 3) b = Math.min(info.duration, allWords[ew.last][2] + 0.35);
      // Never start or end inside a word.
      const lastIn = [...allWords].reverse().find((w) => w[2] <= b + 0.15 && w[1] >= a);
      if (lastIn) {
        const next = allWords[allWords.indexOf(lastIn) + 1];
        b = Math.min(b, lastIn[2] + 0.35, next ? Math.max(lastIn[2] + 0.04, next[1] - 0.04) : Infinity);
      }
      const firstIn = allWords.find((w) => w[2] > a + 0.05);
      if (firstIn && firstIn[1] < a) a = Math.max(0, firstIn[1] - 0.08);
      const drops = [];
      for (const d of trims.drops ?? []) {
        let x = Number(d.start_s) - source.offset - cutFrom;
        let y = Number(d.end_s) - source.offset - cutFrom;
        const f = d.first_words ? findPhrase(allWords, d.first_words, x) : null;
        if (f) x = allWords[f.first][1] - 0.05;
        const l = d.last_words ? findPhrase(allWords, d.last_words, y) : null;
        if (l) y = allWords[l.last][2] + 0.05;
        if (y - x >= 1 && x > a && y < b) drops.push([x, y]);
      }
      const span = (r) => r.reduce((s, [p, q]) => s + (q - p), 0);
      let base = subtract([[a, b]], drops);
      // Under the minimum: run on to the end of the sentence that reaches it.
      if (span(base) < minLen && b < info.duration - 0.5) {
        const want = b + (minLen - span(base));
        const after = allWords.filter((w) => w[2] >= want && w[2] <= info.duration);
        const stop = after.find((w) => /[.!?]["')]*$/.test(w[0])) ?? after[0];
        if (stop && stop[2] - want < 12) {
          const next = allWords[allWords.indexOf(stop) + 1];
          b = Math.min(info.duration, stop[2] + 0.35, next ? Math.max(stop[2] + 0.04, next[1] - 0.04) : Infinity);
        } else b = Math.min(info.duration, want + 0.5);
        base = subtract([[a, b]], drops);
      }
      const inBase = ([, s0, e0]) => base.some(([p, q]) => s0 >= p - 0.05 && e0 <= q + 0.1);
      const words = allWords.filter(inBase);
      const dsg = k.design;
      // Cut the pauses, never below the minimum or more than a third of the moment.
      let keep = base;
      if (dsg.cut_silence && words.length) {
        const total0 = span(base);
        for (const gap of style === 'gaming' ? [1.5, 3] : [0.7, 1.5, 3]) {
          const cut = intersect(keepRanges(words, info.duration, { cut: true, gap }), base);
          if (cut.length && span(cut) >= Math.min(minLen, total0) && span(cut) >= total0 * 0.67) { keep = cut; break; }
        }
      }
      if (!keep.length) throw new Error('Nothing left of that moment after trimming it.');

      console.error(`${label}: ${style === 'gaming' ? 'finding the facecam' : 'tracking the speaker'}`);
      const plan = JSON.parse(await run(PYTHON, [path.join(ENGINE, 'analyze.py'), src, '--style', style, '--aspect', aspect, '--layout', k.layout, '--boxes', JSON.stringify(pick.boxes ?? {})], { timeout: 10 * 60_000 }));
      if (plan.error) throw new Error(`Layout: ${plan.error}`);
      if (style === 'gaming') { plan.facecam_hint = pick.boxes?.facecam ?? null; plan.chat_hint = pick.boxes?.chat ?? null; }

      // Captions on the output timeline.
      const outWords = [];
      for (const [w, s0, e0] of words) {
        const ms = mapTime(s0, keep);
        const me = mapTime(e0, keep);
        if (ms != null) outWords.push([w, ms, me ?? ms + 0.25]);
      }
      const total = span(keep);
      const kind = plan.segments?.[0]?.kind;
      const seam = SEAMED.has(kind) ? seamOf(aspect) : null;
      const [W, H] = ASPECTS[aspect];
      const splitOut = [];
      if (dsg.position !== 'top') {
        for (const sg of plan.segments ?? []) {
          const y = SEAMED.has(sg.kind) ? seamOf(aspect) : sg.kind === 'split' ? H / 2 : null;
          if (y == null) continue;
          for (const [p, q] of keep) {
            const s0 = Math.max(p, sg.start);
            const e0 = Math.min(q, sg.end);
            if (e0 > s0) splitOut.push([mapTime(s0, keep), mapTime(e0, keep), y]);
          }
        }
      }
      const seamAt = splitOut.length ? (t) => splitOut.find(([p, q]) => t >= p - 0.05 && t < q)?.[2] ?? null : null;
      let hookImg = null;
      const hook = noDash(pick.hook);
      if (dsg.hook && hook && dsg.hook_background) {
        const png = path.join(work, 'hook.png');
        try {
          await run(PYTHON, [path.join(ENGINE, 'hookbox.py'), hook, png, '--width', String(W),
            '--font', path.join(FONTS_DIR, (FONT_FILES[dsg.hook_font] ?? FONT_FILES.tiktok_sans_semibold)[0]),
            '--color', dsg.hook_color, '--background', dsg.hook_background, '--size', '62']);
          hookImg = { file: png, y: Math.round(H * (SEAMED.has(kind) ? 0.05 : 0.11)), end: Math.min(total, dsg.hook_seconds) };
        } catch (e) {
          console.error(`${label}: hook box failed, using the caption style (${e.message})`);
        }
      }
      const ass = buildAss({ words: outWords, design: dsg, W, H, hook: hookImg ? null : hook, duration: total, seamY: seam ?? (kind === 'split' ? H / 2 : null), seamAt, kind });
      const assPath = path.join(work, 'captions.ass');
      fs.writeFileSync(assPath, ass);

      console.error(`${label}: rendering`);
      const out = path.join(outDir, `clip_${n}.mp4`);
      const r = renderArgs({ src, srcInfo: info, out, plan, keep, aspect, design: dsg, assPath, gifs: [], captionsAt: dsg.position, words, hookImg });
      await run(FFMPEG, r.args, { timeout: 30 * 60_000 });
      const cover = path.join(outDir, `cover_${n}.jpg`);
      await run(FFMPEG, ['-y', '-loglevel', 'error', '-ss', String(Math.min(1.2, r.duration / 3)), '-i', out, '-frames:v', '1', '-q:v', '3', cover]);

      const at = (t) => Number((cutFrom + t + source.offset).toFixed(2));
      manifest.clips.push({
        file: path.basename(out), cover: path.basename(cover),
        title: noDash(pick.title).slice(0, 200) || `Clip ${n}`, hook: hook.slice(0, 120) || null, reason: noDash(pick.reason).slice(0, 500) || null,
        score: Number.isFinite(Number(pick.score)) ? Math.max(0, Math.min(100, Math.round(Number(pick.score)))) : null,
        start_s: at(a), end_s: at(b), duration_s: Number(r.duration.toFixed(2)),
        transcript: words.map((w) => w[0]).join(' ').slice(0, 20000),
      });
      console.error(`${label}: done (${r.duration.toFixed(1)} s) -> ${out}`);
    } catch (e) {
      console.error(`${label}: FAILED ${e.message}`);
      manifest.clips.push({ title: pick.title ?? `Clip ${n}`, error: e.message });
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
    }
  }
  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  const ok = manifest.clips.filter((c) => c.file);
  console.log(JSON.stringify({ out: outDir, rendered: ok.length, failed: manifest.clips.length - ok.length, clips: ok.map((c) => ({ file: path.join(outDir, c.file), title: c.title, duration_s: c.duration_s, score: c.score })) }, null, 2));
}

// ── upload ───────────────────────────────────────────────────────────────────

async function upload(dirArg, opt) {
  const dir = path.resolve(dirArg || '.');
  const outDir = fs.existsSync(path.join(dir, 'out', 'manifest.json')) ? path.join(dir, 'out') : dir;
  const mf = path.join(outDir, 'manifest.json');
  if (!fs.existsSync(mf)) die(`No manifest.json in ${outDir}: run render first.`);
  const manifest = readJson(mf);
  const clips = manifest.clips.filter((c) => c.file).slice(0, 10);
  if (!clips.length) die('Nothing rendered to upload.');
  const key = process.env.CREATOROS_API_KEY;
  if (!key) die('Set CREATOROS_API_KEY to your cos_live_ key (Creator OS: Settings, API key).');
  // With an autopilot the clips go into its pages' posting queue: say so and wait for --yes.
  if (opt.autopilot && opt.yes !== true) {
    console.log(`Uploading ${clips.length} clip(s) to autopilot ${opt.autopilot} puts them in its pages' posting queue: the ones scoring at or above its bar get posted (and submitted to its campaign, if it has one). Run again with --yes to go ahead.`);
    return;
  }
  const base = String(opt.api || process.env.CREATOROS_API_URL || 'https://mcp.creatoros.ca').replace(/\/$/, '');
  const auth = { authorization: `Bearer ${key}` };

  const sendFile = async (file, type) => {
    const size = fs.statSync(file).size;
    const res = await fetch(`${base}/v1/media`, {
      method: 'POST',
      headers: { ...auth, 'content-type': type, 'content-length': String(size), 'x-filename': path.basename(file) },
      body: fs.createReadStream(file),
      duplex: 'half',
    });
    const j = await res.json().catch(() => null);
    if (!res.ok || !j?.id) throw new Error(`upload ${path.basename(file)}: ${j?.error?.message ?? res.status}`);
    return j.id;
  };

  const body = {
    source_url: manifest.source?.url ?? undefined, source_title: manifest.source?.title ?? undefined, creator_name: manifest.source?.creator ?? undefined,
    autopilot_id: opt.autopilot || undefined, style: manifest.style, clips: [],
  };
  for (const c of clips) {
    console.error(`Uploading ${c.file}...`);
    const video = await sendFile(path.join(outDir, c.file), 'video/mp4');
    const cover = c.cover && fs.existsSync(path.join(outDir, c.cover)) ? await sendFile(path.join(outDir, c.cover), 'image/jpeg').catch(() => null) : null;
    body.clips.push({
      video_url: video, cover_url: cover ?? undefined, title: c.title, hook: c.hook ?? undefined, reason: c.reason ?? undefined,
      start_s: c.start_s, end_s: c.end_s, duration_s: c.duration_s, score: c.score ?? undefined, transcript: c.transcript || undefined,
    });
  }
  const res = await fetch(`${base}/v1/clipper/clips/import`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j = await res.json().catch(() => null);
  if (!res.ok) die(`import: ${j?.error?.message ?? res.status}`);
  fs.writeFileSync(path.join(outDir, 'uploaded.json'), JSON.stringify(j, null, 2));
  console.log(JSON.stringify({ run_id: j?.run?.id, clips: (j?.run?.clips ?? []).map((c) => ({ id: c.id, title: c.title, status: c.status, virality_score: c.virality_score })) }, null, 2));
}

// ── main ─────────────────────────────────────────────────────────────────────

const [cmd, ...rest] = process.argv.slice(2);
const { pos, opt } = args(rest);
try {
  if (cmd === 'prepare') await prepare(pos[0], opt);
  else if (cmd === 'render') await render(pos[0], opt);
  else if (cmd === 'upload') await upload(pos[0], opt);
  else {
    console.log('Usage:\n  clip.mjs prepare <url|file> --out <dir> [--from s] [--to s]\n  clip.mjs render <dir> [--picks picks.json] [--style podcast|gaming] [--layout auto] [--aspect 9:16] [--design design.json | --autopilot <id>] [--min-s 20] [--names "A, B"]\n  clip.mjs upload <dir> [--autopilot <id>] [--yes] [--api https://mcp.creatoros.ca]');
    process.exit(cmd ? 1 : 0);
  }
} catch (e) {
  die(e.message);
}
