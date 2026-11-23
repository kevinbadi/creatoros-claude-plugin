// Clippy captions: word-by-word animated captions + the hook title as an ASS
// subtitle file, burned in by ffmpeg's libass (`subtitles` filter, fontsdir =
// worker/variations/fonts). The design comes from the API (services/clipper/
// designs.ts) already resolved; only the font id is mapped to a file here.

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const FONTS_DIR = path.join(HERE, '..', 'variations', 'fonts');

// font id -> [file, family name libass matches on]
export const FONT_FILES = {
  tiktok_sans_bold: ['TikTokSans-Bold.ttf', 'TikTok Sans Bold'],
  tiktok_sans_semibold: ['TikTokSans-SemiBold.ttf', 'TikTok Sans SemiBold'],
  montserrat_bold: ['Montserrat-Bold.ttf', 'Montserrat'],
  poppins_black: ['Poppins-Black.ttf', 'Poppins Black'],
  anton: ['Anton-Regular.ttf', 'Anton'],
  bebas_neue: ['BebasNeue-Regular.ttf', 'Bebas Neue'],
  oswald_bold: ['Oswald-Bold.ttf', 'Oswald'],
  archivo_black: ['ArchivoBlack-Regular.ttf', 'Archivo Black'],
  bangers: ['Bangers-Regular.ttf', 'Bangers'],
  luckiest_guy: ['LuckiestGuy-Regular.ttf', 'Luckiest Guy'],
  permanent_marker: ['PermanentMarker-Regular.ttf', 'Permanent Marker'],
  capcut_bold: ['CapCutClassic-Bold.ttf', 'CapCut Classic Bold'],
};

export const DEFAULT_DESIGN = {
  preset: 'bold_pop', captions: true, font: 'montserrat_bold', size: 78,
  text_color: '#FFFFFF', highlight_color: '#FFE500', outline_color: '#000000', outline: 6, shadow: true, box: false,
  position: 'bottom', uppercase: true, words_per_line: 3, animation: 'pop',
  hook: true, hook_seconds: 3, hook_font: 'tiktok_sans_semibold', hook_color: '#000000', hook_background: '#FFFFFF',
  cut_silence: true, gifs: false, fps: 30, punch_in: true,
};

const HEX = /^#[0-9a-f]{6}$/i;
/** A partial design (from the "say what to change" planner) merged over the current one, bad values dropped. */
export function mergeDesign(base, patch) {
  const d = { ...DEFAULT_DESIGN, ...(base ?? {}) };
  for (const [k, v] of Object.entries(patch ?? {})) {
    if (v == null) continue;
    if (['font', 'hook_font'].includes(k)) { if (FONT_FILES[v]) d[k] = v; continue; }
    if (['text_color', 'highlight_color', 'outline_color', 'hook_color'].includes(k)) { if (HEX.test(v)) d[k] = v.toUpperCase(); continue; }
    if (k === 'hook_background') { if (v === '' || HEX.test(v)) d[k] = String(v).toUpperCase(); continue; }
    if (['captions', 'shadow', 'box', 'uppercase', 'hook', 'cut_silence', 'gifs', 'punch_in'].includes(k)) { d[k] = v === true; continue; }
    const clamp = (lo, hi) => Math.min(hi, Math.max(lo, Math.round(Number(v)) || lo));
    if (k === 'size') d.size = clamp(40, 140);
    else if (k === 'outline') d.outline = clamp(0, 12);
    else if (k === 'words_per_line') d.words_per_line = clamp(1, 6);
    else if (k === 'hook_seconds') d.hook_seconds = clamp(1, 120);
    else if (k === 'position' && ['top', 'middle', 'bottom'].includes(v)) d.position = v;
    else if (k === 'animation' && ['pop', 'none'].includes(v)) d.animation = v;
    else if (k === 'fps') d.fps = Number(v) === 60 ? 60 : 30;
  }
  return d;
}

const assColor = (hex, alpha = 0) => {
  const h = String(hex || '#FFFFFF').replace('#', '');
  return `&H${alpha.toString(16).padStart(2, '0').toUpperCase()}${h.slice(4, 6)}${h.slice(2, 4)}${h.slice(0, 2)}`.toUpperCase();
};
const ts = (t) => {
  const v = Math.max(0, t);
  const h = Math.floor(v / 3600);
  const m = Math.floor((v % 3600) / 60);
  const s = v % 60;
  return `${h}:${String(m).padStart(2, '0')}:${s.toFixed(2).padStart(5, '0')}`;
};
const esc = (s) => String(s).replace(/\\/g, '').replace(/[{}]/g, '').replace(/\n/g, ' ');
const noDash = (s) => String(s ?? '').replace(/\s*[—–]\s*/g, ', ');

// Group words into caption lines: N words, a pause or the end of a sentence breaks a line.
export function groupWords(words, perLine) {
  const groups = [];
  let cur = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const prev = cur[cur.length - 1];
    if (cur.length && (cur.length >= perLine || w[1] - prev[2] > 0.5 || /[.?!]$/.test(prev[0]))) {
      groups.push(cur);
      cur = [];
    }
    cur.push(w);
  }
  if (cur.length) groups.push(cur);
  return groups;
}

function wrapHook(text, maxChars) {
  const words = esc(noDash(text)).split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const w of words) {
    if (line && (line + ' ' + w).length > maxChars) { lines.push(line); line = w; } else line = line ? `${line} ${w}` : w;
  }
  if (line) lines.push(line);
  return lines.slice(0, 3).join('\\N');
}

/**
 * words: [[word, start, end]] on the OUTPUT timeline. seamY: y of the panel
 * seam (gaming split) where "middle" captions sit. seamAt(t): the seam's y while
 * the screen is split at output time t (null otherwise): those captions sit on it.
 */
export function buildAss({ words, design, W, H, hook, duration, seamY = null, seamAt = null, kind = 'single' }) {
  const d = mergeDesign(design, {});
  const k = W / 1080;
  const [, family] = FONT_FILES[d.font] ?? FONT_FILES.montserrat_bold;
  const [, hookFamily] = FONT_FILES[d.hook_font] ?? FONT_FILES.tiktok_sans_bold;
  const size = Math.round(d.size * k);
  // "middle" sits a little under the centre (bottom of the text at ~64% of the height: Kevin,
  // 2026-11-22), except on a split screen, where it is centred on the seam.
  const onSeam = d.position === 'middle' && seamY != null;
  const align = d.position === 'top' ? 8 : onSeam ? 5 : 2;
  const marginV = d.position === 'top' || d.position === 'bottom' ? Math.round(H * 0.2) : onSeam ? 0 : Math.round(H * 0.36);
  const hookBox = !!d.hook_background;
  const hookSize = Math.round(58 * k);
  const styles = [
    `Style: Caption,${family},${size},${assColor(d.text_color)},${assColor(d.highlight_color)},${assColor(d.outline_color)},${assColor('#000000', 0x70)},0,0,0,0,100,100,0,0,1,${Math.round(d.outline * k)},${d.shadow ? Math.round(3 * k) : 0},${align},${Math.round(70 * k)},${Math.round(70 * k)},${marginV},1`,
    `Style: Hook,${hookFamily},${hookSize},${assColor(d.hook_color)},${assColor(d.hook_color)},${assColor(hookBox ? d.hook_background : '#000000')},${assColor('#000000', 0x80)},0,0,0,0,100,100,0,0,${hookBox ? 3 : 1},${hookBox ? Math.round(16 * k) : Math.round(5 * k)},0,8,${Math.round(80 * k)},${Math.round(80 * k)},${Math.round(H * (kind === 'gaming' ? 0.05 : 0.11))},1`,
  ];
  const events = [];
  if (d.hook && hook) {
    const end = Math.min(duration, d.hook_seconds);
    events.push(`Dialogue: 1,${ts(0)},${ts(end)},Hook,,0,0,0,,{\\fad(80,200)}${wrapHook(hook, 24)}`);
  }
  if (d.captions && words?.length) {
    const at = (y) => `\\an5\\pos(${Math.round(W / 2)},${Math.round(y)})`;
    const fixed = d.position === 'middle' && seamY != null ? at(seamY) : '';
    const groups = groupWords(words, d.words_per_line);
    for (let g = 0; g < groups.length; g++) {
      const grp = groups[g];
      const y = seamAt?.(grp[0][1]);
      const pos = y != null ? at(y) : fixed;
      const nextStart = groups[g + 1]?.[0]?.[1] ?? duration;
      for (let i = 0; i < grp.length; i++) {
        const start = grp[i][1];
        const end = i + 1 < grp.length ? grp[i + 1][1] : Math.min(nextStart, grp[i][2] + 0.35);
        if (end - start < 0.02) continue;
        const parts = grp.map(([w], j) => {
          const word = esc(d.uppercase ? w.toUpperCase() : w);
          if (j !== i) return word;
          const pop = d.animation === 'pop' ? `\\fscx114\\fscy114\\t(0,110,\\fscx100\\fscy100)` : '';
          const hl = d.box ? `\\3c${assColor(d.highlight_color)}\\bord${Math.round(Math.max(10, d.outline * 2.2) * k)}` : `\\c${assColor(d.highlight_color)}`;
          return `{${hl}${pop}}${word}{\\r}`;
        });
        events.push(`Dialogue: 0,${ts(start)},${ts(end)},Caption,,0,0,0,,${pos ? `{${pos}}` : ''}${parts.join(' ')}`);
      }
    }
  }
  return [
    '[Script Info]', 'ScriptType: v4.00+', `PlayResX: ${W}`, `PlayResY: ${H}`, 'WrapStyle: 0', 'ScaledBorderAndShadow: yes', '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    ...styles, '',
    '[Events]', 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    ...events, '',
  ].join('\n');
}
