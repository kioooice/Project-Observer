import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { isInsidePath, normalizeFsPath, normalizeGitRemote } from './identity.mjs';

const codexHome = path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'));
const configuredSessionsDir = process.env.CODEX_SESSIONS_DIR ? path.resolve(process.env.CODEX_SESSIONS_DIR) : null;
const DEFAULT_ROOTS = configuredSessionsDir
  ? [configuredSessionsDir]
  : [path.join(codexHome, 'sessions'), path.join(codexHome, 'archived_sessions')];
const MAX_FILES = Math.max(20, Math.min(1000, Number(process.env.PROJECT_OBSERVER_CODEX_MAX_SESSIONS || 250)));

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

function parseGitInfo(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const originUrl = raw.repository_url || raw.origin_url || raw.originUrl || raw.repositoryUrl || null;
  const sha = raw.commit_hash || raw.sha || raw.commitHash || null;
  const branch = raw.branch || null;
  if (!originUrl && !sha && !branch) return null;
  return {
    originUrl,
    remoteKey: normalizeGitRemote(originUrl),
    sha,
    branch
  };
}

async function accessibleRoots() {
  const roots = [];
  for (const candidate of DEFAULT_ROOTS) {
    try {
      await fsp.access(candidate);
      roots.push(path.resolve(candidate));
    } catch {}
  }
  return roots;
}

async function listRecentJsonl(basePaths) {
  const found = [];
  const queue = [...basePaths];

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
        const payload = line.payload;
        const rawMeta = payload.meta && typeof payload.meta === 'object' ? payload.meta : payload;
        const rawGit = payload.git || rawMeta.git || rawMeta.git_info || rawMeta.gitInfo || null;
        meta = {
          id: rawMeta.id || path.basename(file.path, '.jsonl'),
          cwd: rawMeta.cwd || null,
          timestamp: rawMeta.timestamp || line.timestamp || null,
          modelProvider: rawMeta.model_provider || rawMeta.modelProvider || null,
          git: parseGitInfo(rawGit)
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
    modelProvider: meta.modelProvider,
    git: meta.git
  };
}

function bestPathMatch(sessionPath, projects, useAliases = false) {
  const candidate = normalizeFsPath(sessionPath);
  let best = null;

  for (const project of projects) {
    const roots = useAliases
      ? (project.identity?.pathAliases || [])
      : [normalizeFsPath(project.path)];

    for (const root of roots) {
      if (!isInsidePath(candidate, root)) continue;
      if (!best || root.length > best.root.length) best = { project, root };
    }
  }

  return best?.project || null;
}

function matchProject(session, projects) {
  const sessionRemoteKey = session.git?.remoteKey || null;

  if (sessionRemoteKey) {
    const remoteMatches = projects.filter(project => project.identity?.remoteKey === sessionRemoteKey);
    if (remoteMatches.length === 1) {
      return {
        project: remoteMatches[0],
        match: { type: 'git_remote', confidence: 'high', reason: 'Git remote 一致' }
      };
    }
    if (remoteMatches.length > 1) {
      const byCurrentPath = bestPathMatch(session.projectPath, remoteMatches, false);
      if (byCurrentPath) {
        return {
          project: byCurrentPath,
          match: { type: 'git_remote_and_path', confidence: 'high', reason: 'Git remote + 当前路径一致' }
        };
      }
    }
  }

  const currentPath = bestPathMatch(session.projectPath, projects, false);
  if (currentPath) {
    return {
      project: currentPath,
      match: { type: 'current_path', confidence: 'high', reason: 'Codex 工作目录属于当前项目' }
    };
  }

  const historicalPath = bestPathMatch(session.projectPath, projects, true);
  if (historicalPath) {
    return {
      project: historicalPath,
      match: { type: 'historical_path', confidence: 'medium', reason: '命中项目历史路径别名' }
    };
  }

  return null;
}

function unmatchedReason(session) {
  if (session.git?.remoteKey) return 'Git remote 未命中当前扫描到的项目';
  return '会话没有可用 Git remote，且工作目录未命中当前项目路径';
}

export async function attachCodexSessions(projects) {
  const roots = await accessibleRoots();
  const available = roots.length > 0;
  const sourcePath = roots[0] || DEFAULT_ROOTS[0];

  for (const project of projects) {
    project.agentSessions = {
      codex: {
        available,
        sourcePath,
        sourcePaths: roots,
        sessionCount: 0,
        lastActivity: null,
        sessions: []
      }
    };
  }

  if (!available || !projects.length) {
    return {
      projects,
      meta: {
        codex: {
          available,
          sourcePath,
          sourcePaths: roots,
          scannedFiles: 0,
          parsedSessions: 0,
          matchedSessions: 0,
          unmatchedSessions: 0,
          unmatchedSamples: [],
          matchMethods: {}
        }
      }
    };
  }

  const files = await listRecentJsonl(roots);
  let matchedSessions = 0;
  let parsedSessions = 0;
  const matchMethods = {};
  const unmatchedSamples = [];

  for (const file of files) {
    const session = await parseSession(file);
    if (!session) continue;
    parsedSessions += 1;
    const result = matchProject(session, projects);
    if (!result) {
      if (unmatchedSamples.length < 6) {
        unmatchedSamples.push({
          id: session.id,
          projectPath: session.projectPath,
          remoteKey: session.git?.remoteKey || null,
          originUrl: session.git?.originUrl || null,
          lastActivity: session.lastActivity,
          reason: unmatchedReason(session)
        });
      }
      continue;
    }

    matchedSessions += 1;
    matchMethods[result.match.type] = (matchMethods[result.match.type] || 0) + 1;
    const bucket = result.project.agentSessions.codex;
    bucket.sessions.push({
      ...session,
      match: {
        ...result.match,
        projectKey: result.project.identity?.key || null
      }
    });
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
        sourcePath,
        sourcePaths: roots,
        scannedFiles: files.length,
        parsedSessions,
        matchedSessions,
        unmatchedSessions: Math.max(0, parsedSessions - matchedSessions),
        unmatchedSamples,
        matchMethods
      }
    }
  };
}
