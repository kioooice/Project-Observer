import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const storeDir = path.resolve(process.env.PROJECT_OBSERVER_HOME || path.join(os.homedir(), '.project-observer'));
const logFile = path.join(storeDir, 'observations.jsonl');
const stateFile = path.join(storeDir, 'last-observations.json');

function normalizeFsPath(value) {
  if (!value) return '';
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function makeSnapshot(project) {
  const codex = project.agentSessions?.codex || {};
  return {
    path: project.path,
    name: project.name,
    status: project.status || null,
    stage: project.stage || null,
    declaredProgress: project.declaredProgress ?? null,
    recoveryCoverage: project.recovery?.coverage || null,
    unresolvedItems: project.recovery?.unresolvedItems?.length || 0,
    git: {
      branch: project.git?.branch || null,
      dirtyFiles: project.git?.dirtyFiles || 0,
      latestCommitHash: project.git?.recentCommits?.[0]?.hash || null,
      latestCommitDate: project.git?.latestCommit?.date || null
    },
    codex: {
      sessionCount: codex.sessionCount || 0,
      lastActivity: codex.lastActivity || null
    }
  };
}

function signature(snapshot) {
  return crypto.createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
}

function diffLabels(previous, current) {
  if (!previous) return ['首次观察'];
  const changes = [];
  if (previous.status !== current.status) changes.push('项目状态变化');
  if (previous.stage !== current.stage) changes.push('开发阶段变化');
  if (previous.declaredProgress !== current.declaredProgress) changes.push('目标进度变化');
  if (previous.recoveryCoverage !== current.recoveryCoverage) changes.push('信息覆盖变化');
  if (previous.unresolvedItems !== current.unresolvedItems) changes.push('明确未完成项变化');
  if (previous.git?.latestCommitHash !== current.git?.latestCommitHash) changes.push('Git 提交变化');
  if (previous.git?.dirtyFiles !== current.git?.dirtyFiles) changes.push('未提交文件变化');
  if (previous.codex?.sessionCount !== current.codex?.sessionCount || previous.codex?.lastActivity !== current.codex?.lastActivity) changes.push('Codex 会话变化');
  return changes.length ? changes : ['项目事实变化'];
}

async function ensureStore() {
  await fs.mkdir(storeDir, { recursive: true });
}

async function readState() {
  try {
    return JSON.parse(await fs.readFile(stateFile, 'utf8'));
  } catch {
    return {};
  }
}

export async function recordObservations(projects) {
  await ensureStore();
  const state = await readState();
  const now = new Date().toISOString();
  const lines = [];

  for (const project of projects) {
    const snapshot = makeSnapshot(project);
    const key = normalizeFsPath(project.path);
    const nextSignature = signature(snapshot);
    const previousEntry = state[key] || null;
    if (previousEntry?.signature === nextSignature) continue;

    lines.push(JSON.stringify({
      observedAt: now,
      projectPath: project.path,
      changes: diffLabels(previousEntry?.snapshot || null, snapshot),
      snapshot
    }));

    state[key] = { signature: nextSignature, snapshot, observedAt: now };
  }

  if (lines.length) {
    await fs.appendFile(logFile, `${lines.join('\n')}\n`, 'utf8');
    await fs.writeFile(stateFile, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  }

  return { written: lines.length, storeDir, logFile };
}

export async function getProjectObservations(projectPath, limit = 20) {
  const normalized = normalizeFsPath(projectPath);
  const safeLimit = Math.max(1, Math.min(100, Number(limit) || 20));
  let raw;
  try {
    raw = await fs.readFile(logFile, 'utf8');
  } catch {
    return [];
  }

  const results = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const item = JSON.parse(line);
      if (normalizeFsPath(item.projectPath) === normalized) results.push(item);
    } catch {}
  }

  return results.slice(-safeLimit).reverse();
}

export function getObservationStoreInfo() {
  return { storeDir, logFile };
}
