// Creator OS API client for the Agent Posts skill. Node 20+, zero deps.
import { createReadStream, statSync } from 'node:fs';
import { Readable } from 'node:stream';
import { basename } from 'node:path';

export const BASE = (process.env.CREATOR_OS_API_URL || 'https://creatoros-production-5658.up.railway.app').replace(/\/$/, '');
export const KEY = process.env.CREATOR_OS_API_KEY || '';

export function requireKey() {
  if (!KEY) {
    console.error(
      'Missing CREATOR_OS_API_KEY. Get it at https://www.creatoros.ca/app/settings (API key),\n' +
      'put it in .env.local as CREATOR_OS_API_KEY=... and run with: node --env-file=.env.local <script>',
    );
    process.exit(2);
  }
}

export async function api(path, init = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}`, ...(init.headers || {}) },
  });
  let body = null;
  try { body = await res.json(); } catch {}
  if (!res.ok) {
    const msg = body?.message || body?.error || `http_${res.status}`;
    throw new Error(`${init.method || 'GET'} ${path} failed: ${msg}`);
  }
  return body;
}

let me = null;
export async function whoami() {
  if (!me) me = await api('/auth/whoami');
  return me;
}

export async function userPath(suffix) {
  const w = await whoami();
  const qs = w.workspace_id ? `${suffix.includes('?') ? '&' : '?'}workspace=${w.workspace_id}` : '';
  return `/users/${w.user_id}${suffix}${qs}`;
}

const MIME = { mp4: 'video/mp4', mov: 'video/quicktime', m4v: 'video/x-m4v', webm: 'video/webm', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' };

// Upload a local file to Creator OS (streamed; nothing is buffered in memory).
// Returns the Creator OS media URL to pass as the video/image URL.
export async function uploadFile(file) {
  const ext = file.split('.').pop().toLowerCase();
  const contentType = MIME[ext];
  if (!contentType) throw new Error(`Unsupported file type .${ext}. Use MP4, MOV, WebM (video) or PNG, JPG, WebP (image).`);
  const size = statSync(file).size;
  const res = await fetch(`${BASE}/v1/media`, {
    method: 'POST',
    headers: { authorization: `Bearer ${KEY}`, 'content-type': contentType, 'content-length': String(size), 'x-filename': basename(file) },
    body: Readable.toWeb(createReadStream(file)),
    duplex: 'half',
  });
  let body = null;
  try { body = await res.json(); } catch {}
  if (!res.ok) throw new Error(`Upload failed: ${body?.error?.message || body?.error || `HTTP ${res.status}`}`);
  return body.url;
}

export function args(argv = process.argv.slice(2)) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) out[k] = true;
      else { out[k] = next; i++; }
    } else out._.push(a);
  }
  return out;
}

export function fmtSlot(iso, tz) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleString('en-US', { timeZone: tz || 'America/New_York', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  } catch { return iso; }
}
