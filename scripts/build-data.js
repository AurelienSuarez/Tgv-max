// Downloads the `tgvmax` dataset and writes site/data/ (one JSON file per day).
// Usage: node scripts/build-data.js [--csv local-file.csv] [--out site/data]
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { parseCsv, buildDataset } from './lib/ingest.js';

const API = 'https://ressources.data.sncf.com/api/explore/v2.1/catalog/datasets/tgvmax';
const args = process.argv.slice(2);
const opt = (name, def) => (args.includes(name) ? args[args.indexOf(name) + 1] : def);
const out = opt('--out', 'site/data');

async function fetchRetry(url, as = 'text', tries = 5) {
  for (let i = 1; ; i++) {
    try {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return as === 'json' ? await r.json() : await r.text();
    } catch (e) {
      if (i >= tries) throw e;
      const wait = 2 ** i * 1000;
      console.warn(`${url}: ${e.message}, retrying in ${wait / 1000} s`);
      await new Promise((res) => setTimeout(res, wait));
    }
  }
}

const local = opt('--csv');
const [csv, metaSrc] = await Promise.all([
  local ? readFile(local, 'utf8') : fetchRetry(`${API}/exports/csv?delimiter=%3B`),
  local ? Promise.resolve(null) : fetchRetry(API, 'json').catch(() => null),
]);

const rows = parseCsv(csv);
if (rows.length < 1000 && !local) throw new Error(`Suspicious export: ${rows.length} rows`);
const ds = buildDataset(rows);

await rm(out, { recursive: true, force: true });
await mkdir(join(out, 'days'), { recursive: true });
await writeFile(join(out, 'stations.json'), JSON.stringify({ stations: ds.stations, axes: ds.axes }));
for (const date of ds.dates) {
  await writeFile(join(out, 'days', `${date}.json`), JSON.stringify(ds.days[date]));
}
const meta = {
  generatedAt: new Date().toISOString(),
  sourceModified: metaSrc?.metas?.default?.modified ?? null,
  rows: rows.length,
  seats: Object.values(ds.days).reduce((n, l) => n + l.length, 0),
  dates: ds.dates,
  attribution: 'Données © SNCF Voyageurs, licence ODbL. Source : ressources.data.sncf.com, dataset tgvmax.',
};
await writeFile(join(out, 'meta.json'), JSON.stringify(meta, null, 1));
console.log(`${meta.rows} rows → ${meta.seats} OUI connections over ${meta.dates.length} days, ${ds.stations.length} stations. Source updated: ${meta.sourceModified}`);
