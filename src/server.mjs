import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverProjects } from './scanner.mjs';
import { attachGitContext } from './git-context.mjs';
import { attachProjectIdentities } from './identity.mjs';
import { attachCodexSessions } from './codex.mjs';
import { attachProjectInsights } from './project-insight.mjs';
import {
  attachKnownPathAliases,
  recordObservations,
  getProjectObservations,
  getObservationStoreInfo
} from './observations.mjs';
import {
  saveSessionBinding,
  removeSessionBinding,
  getSessionBindingStoreInfo
} from './session-bindings.mjs';

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
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body)
  });
  res.end(body);
}

async function readJsonBody(req, maxBytes = 64 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new Error('请求内容过大');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
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

async function scanWithActivity(root, depth, maxProjects = 80) {
  const base = await discoverProjects(root, { maxDepth: depth, maxProjects });
  await attachGitContext(base.projects);
  await attachProjectIdentities(base.projects);
  await attachKnownPathAliases(base.projects);
  const enriched = await attachCodexSessions(base.projects);
  attachProjectInsights(enriched.projects);
  const observation = await recordObservations(enriched.projects);
  return {
    ...base,
    projects: enriched.projects,
    agentSources: enriched.meta,
    observationStore: {
      ...getObservationStoreInfo(),
      writtenThisScan: observation.written
    },
    sessionBindingStore: getSessionBindingStoreInfo()
  };
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${host}:${port}`);

    if (url.pathname === '/api/projects' && req.method === 'GET') {
      const root = url.searchParams.get('root') || path.dirname(projectRoot);
      const depth = Math.max(0, Math.min(4, Number(url.searchParams.get('depth') || 2)));
      const data = await scanWithActivity(root, depth);
      return sendJson(res, 200, { ...data, selfPath: projectRoot });
    }

    if (url.pathname === '/api/self' && req.method === 'GET') {
      const data = await scanWithActivity(projectRoot, 0, 1);
      return sendJson(res, 200, data.projects[0] || null);
    }

    if (url.pathname === '/api/observations' && req.method === 'GET') {
      const projectPath = url.searchParams.get('project');
      const projectKey = url.searchParams.get('key');
      if (!projectPath) return sendJson(res, 400, { error: 'Missing project path' });
      const limit = Math.max(1, Math.min(100, Number(url.searchParams.get('limit') || 20)));
      const observations = await getProjectObservations(projectPath, limit, projectKey);
      return sendJson(res, 200, { projectPath, projectKey, observations, store: getObservationStoreInfo() });
    }

    if (url.pathname === '/api/session-bindings' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const binding = await saveSessionBinding({
        sessionId: body.sessionId,
        projectKey: body.projectKey,
        projectPath: body.projectPath,
        projectName: body.projectName
      });
      return sendJson(res, 200, { ok: true, binding, store: getSessionBindingStoreInfo() });
    }

    if (url.pathname === '/api/session-bindings' && req.method === 'DELETE') {
      const sessionId = url.searchParams.get('sessionId');
      const removed = await removeSessionBinding(sessionId);
      return sendJson(res, 200, { ok: true, removed });
    }

    return await serveStatic(req, res);
  } catch (error) {
    return sendJson(res, 500, { error: error?.message || String(error) });
  }
});

server.listen(port, host, () => {
  console.log(`Project Observer: http://${host}:${port}`);
  console.log(`Default scan root: ${path.dirname(projectRoot)}`);
  console.log(`Observation store: ${getObservationStoreInfo().storeDir}`);
  console.log(`Session bindings: ${getSessionBindingStoreInfo().bindingFile}`);
});
