// Minimal static server to test the site locally: node scripts/serve.js [port]
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const root = new URL('../site/', import.meta.url).pathname;
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
const port = Number(process.argv[2] || 8080);
createServer(async (req, res) => {
  let p = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^(\.\.[/\\])+/, '');
  if (p.endsWith('/')) p += 'index.html';
  try {
    const body = await readFile(join(root, p));
    res.writeHead(200, { 'content-type': types[extname(p)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end('not found');
  }
}).listen(port, () => console.log(`http://localhost:${port}/`));
