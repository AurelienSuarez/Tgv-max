// Tells the workflow whether SNCF published a dataset version the live site
// does not have yet. Writes "changed=true|false" to $GITHUB_OUTPUT.
// Any error counts as "changed": better an extra deploy than a stale site.
import { appendFile } from 'node:fs/promises';

const API = 'https://ressources.data.sncf.com/api/explore/v2.1/catalog/datasets/tgvmax';
const SITE = process.env.SITE_URL || 'https://aureliensuarez.github.io/Tgv-max/';

async function json(url) {
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return r.json();
}

let changed = true;
try {
  const [src, live] = await Promise.all([json(API), json(`${SITE}data/meta.json?t=${Date.now()}`)]);
  const sncf = src.metas.default.modified;
  changed = sncf !== live.sourceModified;
  console.log(`SNCF: ${sncf} · live site: ${live.sourceModified} → ${changed ? 'update' : 'nothing new'}`);
} catch (e) {
  console.log(`Check failed (${e.message}): updating anyway.`);
}
if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `changed=${changed}\n`);
