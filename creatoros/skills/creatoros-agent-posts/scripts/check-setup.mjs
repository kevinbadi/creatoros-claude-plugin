#!/usr/bin/env node
import { requireKey, whoami, api, userPath, fmtSlot } from './lib.mjs';

requireKey();
try {
  const me = await whoami();
  const [posts, kit] = await Promise.all([api(await userPath('/agent-posts')), api(await userPath('/agent-setup'))]);
  const s = kit.setup;
  console.log(`Creator OS: @${me.handle ?? '?'}${me.workspace_id ? ` (workspace ${me.workspace_id.slice(0, 8)})` : ''}`);
  if (posts.needs_setup) {
    console.log('No Creator OS profile on this workspace yet. Connect a social at https://www.creatoros.ca/app/connect');
    process.exit(1);
  }
  console.log(`Connected video platforms: ${posts.targets.length ? posts.targets.map((t) => t.platform + (t.username ? ` (@${t.username})` : '')).join(', ') : 'none. Connect one at https://www.creatoros.ca/app/connect'}`);
  console.log(`Next open slot: ${posts.next_slot ? fmtSlot(posts.next_slot, s.timezone) + ' ' + s.timezone : 'n/a'}`);
  console.log(`Transcription: ${posts.transcription_available ? 'on' : 'off (pass --caption)'}`);
  console.log(`Covers: ${!s.coverEnabled ? 'off in brand kit' : s.photos.length ? `on (${s.photos.length} reference photo${s.photos.length > 1 ? 's' : ''})` : 'need reference photos: add them at https://www.creatoros.ca/app/agent-setup'}`);
  console.log(`Brand kit: ${s.brandName || '(no name)'} · ${s.logos.length} logo(s) · ${Object.keys(s.colors).length} colour(s) · voice notes ${s.voiceNotes ? 'set' : 'empty'} · ${s.postingHours.length} slots/day`);
  console.log(`Cut sheet: ${posts.jobs.length} job(s), ${posts.jobs.filter((j) => j.status === 'scheduled').length} scheduled, ${posts.jobs.filter((j) => j.status === 'failed').length} failed`);
  if (posts.targets.length === 0) process.exit(1);
  console.log('Ready.');
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
