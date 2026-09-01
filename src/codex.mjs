import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { isInsidePath, normalizeFsPath, normalizeGitRemote } from './identity.mjs';
import { readCodexStateThreads } from './codex-state.mjs';
import { getSessionBindings } from './session-bindings.mjs';

const codexHome = path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'));
const configuredSessionsDir = process.env.CODEX_SESSIONS_DIR ? path.resolve(process.env.CODEX_SESSIONS_DIR) : null;
const DEFAULT_ROOTS = configuredSessionsDir
  ? [configuredSessionsDir]
  : [path.join(codexHome, 'sessions'), path.join(codexHome, 'archived_sessions')];
const MAX_FILES = Math.max(20, Math.min(1000, Number(process.env.PROJECT_OBSERVER_CODEX_MAX_SESSIONS || 250)));
const EVENT_LIMIT_PER_PROJECT = Math.max(5, Math.min(30, Number(process.env.PROJECT_OBSERVER_CODEX_EVENT_LIMIT || 16)));

function cleanPrompt(value, limit = 220) {
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
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function compactText(value, limit = 520) {
  const text = String(value || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[*_>#~-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return null;
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function extractText(content, acceptedTypes = ['input_text', 'output_text', 'text']) {
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

function readableFsPath(value) {
  if (!value) return null;
  let target = String(value);
  if (process.platform === 'win32' && target.startsWith('\\\\?\\')) {
    target = target.slice(4);
    if (target.toUpperCase().startsWith('UNC\\')) target = `\\\\${target.slice(4)}`;
  }
  return target;
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

function parseFunctionCall(payload, commandSamples) {
  if (!payload || payload.type !== 'function_call') return 0;
  const name = String(payload.name || 'tool');
  let args = payload.arguments;
  try {
    if (typeof args === 'string') args = JSON.parse(args);
  } catch {}
  const command = args?.command || args?.cmd || args?.args || null;
  if (command && commandSamples.length < 5) {
    const text = Array.isArray(command) ? command.join(' ') : String(command);
    commandSamples.push(`${name}: ${text}`.slice(0, 220));
  }
  return 1;
}

function extractVerification(text) {
  if (!text) return [];
  const cleaned = String(text)
    .replace(/\r/g, '')
    .replace(/```[\s\S]*?```/g, ' ')
    .split(/\n+|(?<=[。！？；])\s+/)
    .map(item => compactText(item, 220))
    .filter(Boolean);

  const keywords = /(验证|测试|通过|成功|工作区|干净|提交|推送|同步|build|lint|test|npm|git|接口|api|sessioncount|已写入|已显示|已完成)/i;
  const seen = new Set();
  const result = [];
  for (const item of cleaned) {
    if (!keywords.test(item)) continue;
    const key = item.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
    if (result.length >= 4) break;
  }
  return result;
}

function makeDevelopmentEvent({ firstPrompt, lastAssistant, userTurns, toolCalls, commandSamples }) {
  const request = cleanPrompt(firstPrompt, 260);
  const result = compactText(lastAssistant, 620);
  const verification = extractVerification(lastAssistant);
  if (!request && !result) return null;
  return {
    request: request || '未恢复到明确需求文本',
    result: result || '会话中没有恢复到明确的最终结果说明。',
    verification,
    userTurns,
    toolCalls,
    commandSamples: commandSamples.slice(0, 3),
    evidence: verification.length ? '会话内有明确验证记录' : '已恢复执行结果，暂无明确验证语句'
  };
}

async function parseRollout(filePath, fallbackMtimeMs = null) {
  const target = readableFsPath(filePath);
  if (!target) return null;

  let meta = null;
  let firstPrompt = null;
  let lastAssistant = null;
  let userTurns = 0;
  let toolCalls = 0;
  let lastActivity = fallbackMtimeMs ? new Date(fallbackMtimeMs).toISOString() : null;
  const seenUser = new Set();
  const commandSamples = [];

  let input;
  try {
    input = fs.createReadStream(target, { encoding: 'utf8' });
  } catch {
    return null;
  }
  const rl = readline.createInterface({ input, crlfDelay: Infinity });

  const recordUser = (value) => {
    const cleaned = cleanPrompt(value, 500);
    if (!cleaned) return;
    const key = cleaned.toLowerCase();
    if (seenUser.has(key)) return;
    seenUser.add(key);
    userTurns += 1;
    if (!firstPrompt) firstPrompt = cleaned;
  };

  const recordAssistant = (value) => {
    const cleaned = String(value || '').trim();
    if (cleaned) lastAssistant = cleaned;
  };

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
          id: rawMeta.id || path.basename(target, '.jsonl'),
          cwd: rawMeta.cwd || null,
          timestamp: rawMeta.timestamp || line.timestamp || null,
          modelProvider: rawMeta.model_provider || rawMeta.modelProvider || null,
          git: parseGitInfo(rawGit)
        };
        continue;
      }

      if (line.type === 'response_item' && line.payload) {
        const payload = line.payload;
        if (payload.type === 'message') {
          const text = extractText(payload.content);
          if (payload.role === 'user') recordUser(text);
          if (payload.role === 'assistant') recordAssistant(text);
        } else {
          toolCalls += parseFunctionCall(payload, commandSamples);
        }
        continue;
      }

      if (line.type === 'event_msg' && line.payload) {
        const payload = line.payload;
        const type = String(payload.type || '').toLowerCase();
        if (type === 'user_message' || type === 'user_input') {
          recordUser(payload.message || payload.text || extractText(payload.content));
        } else if (
          type === 'agent_message' ||
          type === 'assistant_message' ||
          type === 'final_answer' ||
          type === 'agent_response'
        ) {
          recordAssistant(payload.message || payload.text || extractText(payload.content));
        } else if (type.includes('tool') || type.includes('exec') || type.includes('command')) {
          toolCalls += 1;
          const command = payload.command || payload.cmd || payload.name || null;
          if (command && commandSamples.length < 5) commandSamples.push(String(command).slice(0, 220));
        }
      }
    }
  } catch {
    return null;
  } finally {
    rl.close();
  }

  let statMtime = fallbackMtimeMs;
  if (!statMtime) {
    try { statMtime = (await fsp.stat(target)).mtimeMs; } catch {}
  }
  const started = new Date(meta?.timestamp || statMtime || Date.now());
  const startedAt = Number.isNaN(started.getTime()) ? lastActivity : started.toISOString();

  return {
    meta,
    firstPrompt,
    lastAssistant,
    userTurns,
    toolCalls,
    commandSamples,
    startedAt,
    lastActivity: lastActivity || startedAt,
    developmentEvent: makeDevelopmentEvent({
      firstPrompt,
      lastAssistant,
      userTurns,
      toolCalls,
      commandSamples
    })
  };
}

async function parseSession(file) {
  const rollout = await parseRollout(file.path, file.mtimeMs);
  const meta = rollout?.meta;
  if (!meta?.cwd && !meta?.git?.remoteKey) return null;

  return {
    id: String(meta.id),
    projectPath: meta.cwd,
    startedAt: rollout.startedAt,
    lastActivity: rollout.lastActivity,
    title: cleanPrompt(rollout.firstPrompt, 180) || 'Codex 会话（未恢复首条需求）',
    userTurns: rollout.userTurns,
    modelProvider: meta.modelProvider,
    storage: 'jsonl',
    rolloutPath: file.path,
    developmentEvent: rollout.developmentEvent,
    git: meta.git
  };
}

async function enrichSessionFromRollout(session) {
  if (session.developmentEvent || !session.rolloutPath) return session;
  const rollout = await parseRollout(session.rolloutPath);
  if (!rollout) return session;
  return {
    ...session,
    title: cleanPrompt(rollout.firstPrompt, 180) || session.title,
    userTurns: Math.max(session.userTurns || 0, rollout.userTurns || 0),
    startedAt: session.startedAt || rollout.startedAt,
    lastActivity: String(rollout.lastActivity || '') > String(session.lastActivity || '')
      ? rollout.lastActivity
      : session.lastActivity,
    developmentEvent: rollout.developmentEvent
  };
}

function bestPathMatch(sessionPath, projects, useAliases = false) {
  const candidate = normalizeFsPath(sessionPath);
  if (!candidate) return null;
  const matches = [];

  for (const project of projects) {
    const roots = useAliases
      ? (project.identity?.pathAliases || [])
      : [normalizeFsPath(project.path)];

    for (const root of roots) {
      if (!root || !isInsidePath(candidate, root)) continue;
      matches.push({ project, root, length: root.length });
    }
  }

  if (!matches.length) return null;
  const maxLength = Math.max(...matches.map(item => item.length));
  const strongest = matches.filter(item => item.length === maxLength);
  const uniqueProjects = [...new Map(strongest.map(item => [item.project.identity?.key || item.project.path, item.project])).values()];
  return uniqueProjects.length === 1 ? uniqueProjects[0] : null;
}

function matchCodexProjectRoots(session, projects) {
  const roots = session.codexProject?.roots || [];
  if (!roots.length) return null;

  for (const root of roots) {
    const remoteKey = normalizeGitRemote(root);
    if (remoteKey && !remoteKey.startsWith('local:')) {
      const remoteMatches = projects.filter(project => project.identity?.remoteKey === remoteKey);
      if (remoteMatches.length === 1) {
        return {
          project: remoteMatches[0],
          match: { type: 'codex_project_remote', confidence: 'high', reason: 'Codex 项目根地址对应同一 Git remote' }
        };
      }
    }
  }

  for (const root of roots) {
    const remoteKey = normalizeGitRemote(root);
    if (remoteKey && !remoteKey.startsWith('local:')) continue;
    const current = bestPathMatch(root, projects, false);
    if (current) {
      return {
        project: current,
        match: { type: 'codex_project_path', confidence: 'high', reason: 'Codex 项目根目录属于当前项目' }
      };
    }
    const historical = bestPathMatch(root, projects, true);
    if (historical) {
      return {
        project: historical,
        match: { type: 'codex_project_historical_path', confidence: 'medium', reason: 'Codex 项目根目录命中历史路径' }
      };
    }
  }

  return null;
}

function matchManualBinding(session, projects, bindings) {
  const binding = bindings?.[session.id];
  if (!binding) return null;

  const byKey = projects.filter(project => project.identity?.key === binding.projectKey);
  if (byKey.length === 1) {
    return {
      project: byKey[0],
      match: { type: 'manual_binding', confidence: 'confirmed', reason: '人工确认绑定' }
    };
  }

  if (binding.projectPath) {
    const normalized = normalizeFsPath(binding.projectPath);
    const byPath = projects.filter(project => normalizeFsPath(project.path) === normalized);
    if (byPath.length === 1) {
      return {
        project: byPath[0],
        match: { type: 'manual_binding_path', confidence: 'confirmed', reason: '人工确认绑定（按保存路径恢复）' }
      };
    }
  }
  return null;
}

function matchProject(session, projects, bindings) {
  const manual = matchManualBinding(session, projects, bindings);
  if (manual) return manual;

  const canonicalProject = matchCodexProjectRoots(session, projects);
  if (canonicalProject) return canonicalProject;

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
  if (session.codexProject?.roots?.length) return 'Codex 已提供项目归属，但项目根地址未命中当前扫描到的仓库';
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
    codexProject: incoming.codexProject || existing.codexProject || null,
    rolloutPath: incoming.rolloutPath || existing.rolloutPath || null,
    developmentEvent: incoming.developmentEvent || existing.developmentEvent || null,
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
  const [roots, stateDb, bindings] = await Promise.all([
    accessibleRoots(),
    readCodexStateThreads(),
    getSessionBindings()
  ]);
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
    const result = matchProject(session, projects, bindings);
    if (!result) {
      if (unmatchedSamples.length < 12) {
        unmatchedSamples.push({
          id: session.id,
          title: session.title,
          projectPath: session.projectPath,
          projectId: session.projectId || null,
          codexProjectName: session.codexProject?.name || null,
          codexProjectRoots: session.codexProject?.roots || [],
          remoteKey: session.git?.remoteKey || null,
          originUrl: session.git?.originUrl || null,
          originSource: session.git?.originSource || null,
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
    const selected = bucket.sessions.slice(0, EVENT_LIMIT_PER_PROJECT);
    const enriched = [];
    for (const session of selected) enriched.push(await enrichSessionFromRollout(session));
    bucket.sessionCount = bucket.sessions.length;
    bucket.lastActivity = bucket.sessions[0]?.lastActivity || null;
    bucket.sessions = enriched;
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
        manualBindingCount: Object.keys(bindings || {}).length,
        stateDb: {
          available: stateDb.available,
          readable: stateDb.readable ?? false,
          path: stateDb.path,
          reader: stateDb.reader,
          threadCount: stateDb.threadCount || 0,
          projectCount: stateDb.projectCount || 0,
          projectRootCount: stateDb.projectRootCount || 0,
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
