import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

const DEFAULT_BASE = path.join(os.homedir(), '.codex', 'sessions');
const MAX_FILES = Math.max(20, Math.min(1000, Number(process.env.PROJECT_OBSERVER_CODEX_MAX_SESSIONS || 250)));

function normalizeFsPath(value) {
  if (!value) return '';
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isInside(candidate, root) {
  if (!candidate || !root) return false;
  if (candidate === root) return true;
  return candidate.startsWith(root.endsWith(path.sep) ? root : `${root}${path.sep}`);
}

function cleanPrompt(value) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return null;
  const lower = text.toLowerCase();
  if (
    text.startsWith('#') ||
    lower.startsWith('<environment_context>') ||
    lower.startsWith('<developer') ||
    lower.startsWith('<system') ||
    lower.startsWith('<task>') ||
    lower.startsWith('you are chatgpt')
  ) return null;
  return text.length > 140 ? `${text.slice(0, 137)}…` : text;
}

function extractText(content, acceptedTypes) {
  if (!Array.isArray(content)) return '';
  return content
    .filter(item => item && acceptedTypes.includes(item.type))
    .map(item => String(item.text || item.content || ''))
    .join('\n')
    .trim();
}

async function listRecentJsonl(basePath) {
  const found = [];
  const queue = [basePath];

  while (queue.length) {
    const dir = queue.shift();
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const target = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        queue.push(target);
      } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        try {
          const stat = await fsp.stat(target);
          found.push({ path: target, mtimeMs: stat.mtimeMs });
        } catch {}
      }
    }
  }

  return found.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, MAX_FILES);
}

async function parseSession(file) {
  let meta = null;
  let firstPrompt = null;
  let userTurns = 0;
  let lastActivity = file.mtimeMs ? new Date(file.mtimeMs).toISOString() : null;

  const input = fs.createReadStream(file.path, { encoding: 'utf8' });
  const rl = readline.createInterface({ input, crlfDelay: Infinity });

  try {
    for await (const rawLine of rl) {
      if (!rawLine.trim()) continue;
      let line;
      try { line = JSON.parse(rawLine); } catch { continue; }

      if (line.timestamp) {
        const timestamp = new Date(line.timestamp);
        if (!Number.isNaN(timestamp.getTime())) lastActivity = timestamp.toISOString();
      }

      if (line.type === 'session_meta' && line.payload) {
        meta = {
          id: line.payload.id || path.basename(file.path, '.jsonl'),
          cwd: line.payload.cwd || null,
          timestamp: line.payload.timestamp || line.timestamp || null,
          modelProvider: line.payload.model_provider || null
        };
        continue;
      }

      if (line.type === 'response_item' && line.payload?.type === 'message' && line.payload.role === 'user') {
        const text = extractText(line.payload.content, ['input_text', 'text']);
        const cleaned = cleanPrompt(text);
        if (cleaned) {
          userTurns += 1;
          if (!firstPrompt) firstPrompt = cleaned;
        }
        continue;
      }

      if (line.type === 'event_msg' && line.payload) {
        const payload = line.payload;
        const type = String(payload.type || '');
        if (type === 'user_message' || type === 'user_input') {
          const text = payload.message || payload.text || extractText(payload.content, ['input_text', 'text']);
          const cleaned = cleanPrompt(text);
          if (cleaned) {
            userTurns += 1;
            if (!firstPrompt) firstPrompt = cleaned;
          }
        }
      }
    }
  } catch {
    return null;
  } finally {
    rl.close();
  }

  if (!meta?.cwd) return null;
  const started = new Date(meta.timestamp || file.mtimeMs || Date.now());
  const startedAt = Number.isNaN(started.getTime()) ? lastActivity : started.toISOString();

  return {
    id: String(meta.id),
    projectPath: meta.cwd,
    startedAt,
    lastActivity: lastActivity || startedAt,
    title: firstPrompt || 'Codex 会话（未恢复首条需求）',
    userTurns,
    modelProvider: meta.modelProvider
  };
}

function matchProject(sessionPath, projects) {
  const candidate = normalizeFsPath(sessionPath);
  let best = null;
  for (const project of projects) {
    const root = normalizeFsPath(project.path);
    if (!isInside(candidate, root)) continue;
    if (!best || root.length > best.root.length) best = { project, root };
  }
  return best?.project || null;
}

export async function attachCodexSessions(projects) {
  const basePath = path.resolve(process.env.CODEX_SESSIONS_DIR || DEFAULT_BASE);
  let accessible = true;
  try { await fsp.access(basePath); } catch { accessible = false; }

  for (const project of projects) {
    project.agentSessions = {
      codex: {
        available: accessible,
        sourcePath: basePath,
        sessionCount: 0,
        lastActivity: null,
        sessions: []
      }
    };
  }

  if (!accessible || !projects.length) {
    return { projects, meta: { codex: { available: accessible, sourcePath: basePath, scannedFiles: 0, matchedSessions: 0 } } };
  }

  const files = await listRecentJsonl(basePath);
  let matchedSessions = 0;

  for (const file of files) {
    const session = await parseSession(file);
    if (!session) continue;
    const project = matchProject(session.projectPath, projects);
    if (!project) continue;

    matchedSessions += 1;
    const bucket = project.agentSessions.codex;
    bucket.sessions.push(session);
  }

  for (const project of projects) {
    const bucket = project.agentSessions.codex;
    bucket.sessions.sort((a, b) => String(b.lastActivity).localeCompare(String(a.lastActivity)));
    bucket.sessionCount = bucket.sessions.length;
    bucket.lastActivity = bucket.sessions[0]?.lastActivity || null;
    bucket.sessions = bucket.sessions.slice(0, 20);
  }

  return {
    projects,
    meta: {
      codex: {
        available: true,
        sourcePath: basePath,
        scannedFiles: files.length,
        matchedSessions
      }
    }
  };
}
