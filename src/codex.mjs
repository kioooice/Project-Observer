import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { isInsidePath, normalizeFsPath, normalizeGitRemote } from './identity.mjs';
import { readCodexStateThreads } from './codex-state.mjs';

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

  if (!meta?.cwd && !meta?.git?.remoteKey) return null;
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
    storage: 'jsonl',
    git: meta.git
  };
}

function bestPathMatch(sessionPath, projects, useAliases = false) {
  const candidate = normalizeFsPath(sessionPath);
  if (!candidate) return null;
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
  if (session.projectPath) return '工作目录未命中当前项目路径或历史路径';
  if (session.projectId) return '只有 Codex project_id，当前还没有对应到本地仓库身份';
  return '会话缺少可用于项目归属的 Git remote 和工作目录';
}

function preferTitle(a, b) {
  const generic = value => !value || value.startsWith('Codex 会话（');
  if (!generic(b)) return b;
  if (!generic(a)) return a;
  return b || a || 'Codex 会话';
}

function mergeSession(existing, incoming) {
  if (!existing) return { ...incoming, storages: [incoming.storage].filter(Boolean) };
  const storages = [...new Set([...(existing.storages || [existing.storage]), incoming.storage].filter(Boolean))];
  const existingLast = String(existing.lastActivity || '');
  const incomingLast = String(incoming.lastActivity || '');
  return {
    ...existing,
    ...incoming,
    projectPath: incoming.projectPath || existing.projectPath,
    startedAt: [existing.startedAt, incoming.startedAt].filter(Boolean).sort()[0] || null,
    lastActivity: incomingLast > existingLast ? incoming.lastActivity : existing.lastActivity,
    title: preferTitle(existing.title, incoming.title),
    userTurns: Math.max(existing.userTurns || 0, incoming.userTurns || 0),
    modelProvider: incoming.modelProvider || existing.modelProvider || null,
    projectId: incoming.projectId || existing.projectId || null,
    rolloutPath: incoming.rolloutPath || existing.rolloutPath || null,
    git: {
      ...(existing.git || {}),
      ...(incoming.git || {}),
      originUrl: incoming.git?.originUrl || existing.git?.originUrl || null,
      remoteKey: incoming.git?.remoteKey || existing.git?.remoteKey || null
    },
    storages
  };
}

export async function attachCodexSessions(projects) {
  const [roots, stateDb] = await Promise.all([accessibleRoots(), readCodexStateThreads()]);
  const jsonlAvailable = roots.length > 0;
  const available = jsonlAvailable || stateDb.available;
  const sourcePaths = [stateDb.available ? stateDb.path : null, ...roots].filter(Boolean);
  const sourcePath = sourcePaths[0] || stateDb.path || DEFAULT_ROOTS[0];

  for (const project of projects) {
    project.agentSessions = {
      codex: {
        available,
        sourcePath,
        sourcePaths,
        sessionCount: 0,
        lastActivity: null,
        sessions: []
      }
    };
  }

  if (!projects.length) {
    return { projects, meta: { codex: { available, sourcePath, sourcePaths, parsedSessions: 0 } } };
  }

  const sessionsById = new Map();
  for (const session of stateDb.sessions || []) {
    sessionsById.set(session.id, mergeSession(sessionsById.get(session.id), session));
  }

  const files = jsonlAvailable ? await listRecentJsonl(roots) : [];
  let jsonlParsed = 0;
  for (const file of files) {
    const session = await parseSession(file);
    if (!session) continue;
    jsonlParsed += 1;
    sessionsById.set(session.id, mergeSession(sessionsById.get(session.id), session));
  }

  let matchedSessions = 0;
  const matchMethods = {};
  const unmatchedSamples = [];
  const allSessions = [...sessionsById.values()]
    .sort((a, b) => String(b.lastActivity || '').localeCompare(String(a.lastActivity || '')));

  for (const session of allSessions) {
    const result = matchProject(session, projects);
    if (!result) {
      if (unmatchedSamples.length < 8) {
        unmatchedSamples.push({
          id: session.id,
          projectPath: session.projectPath,
          projectId: session.projectId || null,
          remoteKey: session.git?.remoteKey || null,
          originUrl: session.git?.originUrl || null,
          lastActivity: session.lastActivity,
          storage: session.storages?.join(' + ') || session.storage || null,
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
    bucket.sessions.sort((a, b) => String(b.lastActivity || '').localeCompare(String(a.lastActivity || '')));
    bucket.sessionCount = bucket.sessions.length;
    bucket.lastActivity = bucket.sessions[0]?.lastActivity || null;
    bucket.sessions = bucket.sessions.slice(0, 30);
  }

  return {
    projects,
    meta: {
      codex: {
        available,
        sourcePath,
        sourcePaths,
        scannedFiles: files.length,
        parsedSessions: allSessions.length,
        matchedSessions,
        unmatchedSessions: Math.max(0, allSessions.length - matchedSessions),
        unmatchedSamples,
        matchMethods,
        stateDb: {
          available: stateDb.available,
          readable: stateDb.readable ?? false,
          path: stateDb.path,
          reader: stateDb.reader,
          threadCount: stateDb.threadCount || 0,
          error: stateDb.error || null
        },
        jsonl: {
          available: jsonlAvailable,
          sourcePaths: roots,
          scannedFiles: files.length,
          parsedSessions: jsonlParsed
        }
      }
    }
  };
}
