import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverProjects } from './scanner.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, '..');
const publicDir = path.join(projectRoot, 'public');
const host = '127.0.0.1';
const port = Number(process.env.PORT || 4177);

const mime = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml'
};

function sendJson(res, status, data) {
  const body = JSON.stringify(data, null, 2);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

async function serveStatic(req, res) {
  const url = new URL(req.url, `http://${host}:${port}`);
  const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  const safe = path.normalize(rel).replace(/^([.][.][/\\])+/, '');
  const target = path.join(publicDir, safe);
  if (!target.startsWith(publicDir)) return sendJson(res, 403, { error: 'Forbidden' });
  try {
    const body = await fs.readFile(target);
    res.writeHead(200, { 'content-type': mime[path.extname(target)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    sendJson(res, 404, { error: 'Not found' });
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${host}:${port}`);
    if (url.pathname === '/api/projects') {
      const root = url.searchParams.get('root') || path.dirname(projectRoot);
      const depth = Math.max(0, Math.min(4, Number(url.searchParams.get('depth') || 2)));
      const data = await discoverProjects(root, { maxDepth: depth });
      return sendJson(res, 200, { ...data, selfPath: projectRoot });
    }
    if (url.pathname === '/api/self') {
      const data = await discoverProjects(projectRoot, { maxDepth: 0, maxProjects: 1 });
      return sendJson(res, 200, data.projects[0] || null);
    }
    return await serveStatic(req, res);
  } catch (error) {
    return sendJson(res, 500, { error: error?.message || String(error) });
  }
});

server.listen(port, host, () => {
  console.log(`Project Observer: http://${host}:${port}`);
  console.log(`Default scan root: ${path.dirname(projectRoot)}`);
});
