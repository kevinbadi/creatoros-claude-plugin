#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { requireKey, api, userPath, uploadFile, args, fmtSlot } from './lib.mjs';

requireKey();
const a = args();
if (!a.video) {
  console.error('Usage: node --env-file=.env.local scripts/post.mjs --video <file|url> [--caption ..] [--title ..] [--keyword WORD] [--link URL] [--dm ..] [--platforms a,b] [--wait]');
  process.exit(2);
}
try {
  const videoUrl = /^https?:\/\//i.test(a.video) ? a.video : await (async () => {
    if (!existsSync(a.video)) throw new Error(`No such file: ${a.video}`);
    process.stderr.write('Uploading video… ');
    const url = await uploadFile(a.video);
    process.stderr.write('done\n');
    return url;
  })();

  const body = { videoUrl };
  if (a.caption) body.caption = String(a.caption);
  if (a.title) body.title = String(a.title);
  if (a.keyword) body.keyword = String(a.keyword);
  if (a.link) body.resourceUrl = String(a.link);
  if (a.dm) body.dmNote = String(a.dm);
  if (a.platforms) body.platforms = String(a.platforms).split(',').map((p) => p.trim().toLowerCase()).filter(Boolean);

  const created = await api(await userPath('/agent-posts'), { method: 'POST', body: JSON.stringify(body) });
  let job = created.job;
  console.log(`Queued ${job.id}`);
  if (!a.wait) { console.log(JSON.stringify(job, null, 2)); process.exit(0); }

  const kit = await api(await userPath('/agent-setup'));
  let lastStep = '';
  for (let i = 0; i < 120; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    const res = await api(await userPath('/agent-posts'));
    job = res.jobs.find((j) => j.id === job.id) ?? job;
    if (job.step !== lastStep) { lastStep = job.step; process.stderr.write(`  ${job.status}: ${job.step}\n`); }
    if (job.status === 'scheduled' || job.status === 'published' || job.status === 'failed') break;
  }
  if (job.status === 'failed') { console.error(`Failed: ${job.error}`); process.exit(1); }
  console.log(`Scheduled for ${fmtSlot(job.scheduledFor, kit.setup.timezone)} ${kit.setup.timezone} → ${job.platforms.map((p) => p.platform).join(', ')}`);
  if (job.keyword) console.log(`Keyword: ${job.keyword} · DM funnel: ${job.commentDmStatus}`);
  if (job.thumbnailUrl) console.log(`Cover: ${job.thumbnailUrl}`); else if (job.coverStatus) console.log(`Cover: ${job.coverStatus}`);
  console.log(`\n${job.caption}`);
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
