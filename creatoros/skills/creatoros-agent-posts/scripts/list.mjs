#!/usr/bin/env node
import { requireKey, api, userPath, fmtSlot, args } from './lib.mjs';

requireKey();
const a = args();
try {
  const [res, kit] = await Promise.all([api(await userPath('/agent-posts')), api(await userPath('/agent-setup'))]);
  if (a.json) { console.log(JSON.stringify(res.jobs, null, 2)); process.exit(0); }
  if (!res.jobs.length) { console.log('Cut sheet is empty.'); process.exit(0); }
  for (const j of res.jobs) {
    const when = j.scheduledFor ? fmtSlot(j.scheduledFor, kit.setup.timezone) : '';
    console.log(`${j.status.padEnd(9)} ${when.padEnd(22)} ${j.platforms.map((p) => p.platform).join(',') || (j.selectedPlatforms || []).join(',')}`);
    console.log(`  ${j.id}  ${j.youtubeTitle || j.step || ''}${j.keyword ? `  [${j.keyword}]` : ''}${j.thumbnailUrl ? '  cover ✓' : ''}`);
    if (j.error) console.log(`  ! ${j.error}`);
  }
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
