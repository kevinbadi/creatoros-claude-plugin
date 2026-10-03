#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { requireKey, api, userPath, uploadFile, args } from './lib.mjs';

requireKey();
const a = args();
const cmd = a._[0];
try {
  if (cmd === 'get' || !cmd) {
    const res = await api(await userPath('/agent-setup'));
    console.log(JSON.stringify(res.setup, null, 2));
  } else if (cmd === 'set') {
    const file = a._[1];
    if (!file) { console.error('Usage: brand-kit.mjs set kit.json'); process.exit(2); }
    const kit = JSON.parse(readFileSync(file, 'utf8'));
    const res = await api(await userPath('/agent-setup'), { method: 'PUT', body: JSON.stringify(kit) });
    console.log(`Saved. ${res.setup.logos.length} logo(s), ${res.setup.photos.length} photo(s), ${res.setup.postingHours.length} slots/day in ${res.setup.timezone}.`);
  } else if (cmd === 'add-photo' || cmd === 'add-logo') {
    // Upload a local image and attach it to the kit in one go.
    const file = a._[1];
    if (!file) { console.error(`Usage: brand-kit.mjs ${cmd} ./image.png`); process.exit(2); }
    const url = await uploadFile(file);
    const cur = (await api(await userPath('/agent-setup'))).setup;
    const name = file.split('/').pop().replace(/\.[a-z0-9]+$/i, '');
    if (cmd === 'add-photo') cur.photos = [...cur.photos, { url, name }].slice(0, 4);
    else cur.logos = [...cur.logos, { url, name, kind: a.icon ? 'icon' : 'logo' }].slice(0, 12);
    const res = await api(await userPath('/agent-setup'), { method: 'PUT', body: JSON.stringify(cur) });
    console.log(`Added. ${res.setup.photos.length} photo(s), ${res.setup.logos.length} logo(s).`);
  } else {
    console.error('Usage: brand-kit.mjs get | set kit.json | add-photo ./me.jpg | add-logo ./logo.png [--icon]');
    process.exit(2);
  }
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
