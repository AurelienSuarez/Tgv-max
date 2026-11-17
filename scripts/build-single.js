// Builds a self-contained HTML version (data snapshot included) to share as a
// single page, without a server. Requires site/data/ (npm run build:data first).
// Usage: node scripts/build-single.js [out.html]
import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

const site = new URL('../site/', import.meta.url);
const read = (p) => readFile(new URL(p, site), 'utf8');
const strip = (src) => src.replace(/^import .*;$/gm, '').replace(/^export /gm, '');
const out = process.argv[2] || 'dist/max-relais.html';

const [stationsJs, csaJs, geoJs, mapJs, workerJs, appJs, css, html] = await Promise.all(
  ['lib/stations.js', 'lib/csa.js', 'lib/geo-data.js', 'map.js', 'worker.js', 'app.js', 'style.css', 'index.html'].map(read),
);
const meta = JSON.parse(await read('data/meta.json'));
const stations = JSON.parse(await read('data/stations.json'));
const days = {};
for (const f of (await readdir(new URL('data/days/', site))).sort()) days[f.replace('.json', '')] = JSON.parse(await read(`data/days/${f}`));

const lib = strip(stationsJs) + '\n' + strip(csaJs);
const workerSource = `(() => {\n${lib}\n${strip(workerJs)}\n})();`;
const data = { meta, stations, days, workerSource };
const body = html.match(/<!--app-->([\s\S]*)<!--\/app-->/)[1];
const fonts = html.match(/<link rel="stylesheet" href="https:\/\/fonts[^>]+>/)[0];
const safe = (s) => s.replace(/<\/(script)/gi, '<\\/$1');

const page = `<title>Max Relais</title>
<meta name="claude:viewport-fit-sides" content="cover">
${fonts}
<style>
${css}
</style>
${body}
<script>window.__MAXRELAIS__ = ${safe(JSON.stringify(data))};</script>
<script>
(() => {
${safe(lib)}
${safe(strip(geoJs))}
${safe(strip(mapJs))}
${safe(strip(appJs))}
})();
</script>
`;
await mkdir(dirname(out), { recursive: true });
await writeFile(out, page);
console.log(`${out}: ${(page.length / 1e6).toFixed(2)} MB`);
