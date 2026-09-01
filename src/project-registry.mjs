import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const storeDir = path.join(os.homedir(), '.project-observer');
const registryFile = path.join(storeDir, 'projects.json');

function normalizeProjectPath(value) {
  if (!value || typeof value !== 'string') return null;
  return path.resolve(value.trim()).replace(/^\\\\\?\\/, '');
}

async function exists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function readRegistry() {
  try {
    const raw = await fs.readFile(registryFile, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      schemaVersion: 1,
      projects: Array.isArray(parsed.projects) ? parsed.projects : []
    };
  } catch {
    return { schemaVersion: 1, projects: [] };
  }
}

async function writeRegistry(registry) {
  await fs.mkdir(storeDir, { recursive: true });
  const tmp = `${registryFile}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(registry, null, 2)}\n`, 'utf8');
  await fs.rename(tmp, registryFile);
}

function dedupeProjects(projects) {
  const seen = new Set();
  const result = [];
  for (const item of projects) {
    const normalized = normalizeProjectPath(item?.path);
    if (!normalized) continue;
    const key = process.platform === 'win32' ? normalized.toLowerCase() : normalized;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({
      path: normalized,
      addedAt: item.addedAt || new Date().toISOString(),
      source: item.source || 'manual'
    });
  }
  return result;
}

export async function ensureProjectRegistry(selfPath) {
  const registry = await readRegistry();
  const normalizedSelf = normalizeProjectPath(selfPath);
  const projects = dedupeProjects(registry.projects);
  const hasSelf = projects.some(item => {
    const left = process.platform === 'win32' ? item.path.toLowerCase() : item.path;
    const right = process.platform === 'win32' ? normalizedSelf.toLowerCase() : normalizedSelf;
    return left === right;
  });

  if (!hasSelf) {
    projects.unshift({ path: normalizedSelf, addedAt: new Date().toISOString(), source: 'self' });
  }

  const next = { schemaVersion: 1, projects };
  await writeRegistry(next);
  return next;
}

export async function listRegisteredProjects(selfPath) {
  return ensureProjectRegistry(selfPath);
}

export async function addRegisteredProject(projectPath, selfPath) {
  const normalized = normalizeProjectPath(projectPath);
  if (!normalized) throw new Error('请提供项目目录');

  const stat = await fs.stat(normalized).catch(() => null);
  if (!stat?.isDirectory()) throw new Error('项目目录不存在或不是文件夹');

  const isGit = await exists(path.join(normalized, '.git'));
  const hasState = await exists(path.join(normalized, '.project-state.json'));
  if (!isGit && !hasState) {
    throw new Error('该目录没有 .git 或 .project-state.json，暂时不能识别为项目');
  }

  const registry = await ensureProjectRegistry(selfPath);
  const projects = dedupeProjects([
    ...registry.projects,
    { path: normalized, addedAt: new Date().toISOString(), source: 'manual' }
  ]);
  const next = { schemaVersion: 1, projects };
  await writeRegistry(next);
  return projects.find(item => {
    const left = process.platform === 'win32' ? item.path.toLowerCase() : item.path;
    const right = process.platform === 'win32' ? normalized.toLowerCase() : normalized;
    return left === right;
  });
}

export async function removeRegisteredProject(projectPath, selfPath) {
  const normalized = normalizeProjectPath(projectPath);
  const normalizedSelf = normalizeProjectPath(selfPath);
  if (!normalized) return false;

  const leftSelf = process.platform === 'win32' ? normalizedSelf.toLowerCase() : normalizedSelf;
  const target = process.platform === 'win32' ? normalized.toLowerCase() : normalized;
  if (target === leftSelf) throw new Error('Project Observer 自身不能从项目库移除');

  const registry = await ensureProjectRegistry(selfPath);
  const before = registry.projects.length;
  const projects = registry.projects.filter(item => {
    const key = process.platform === 'win32' ? item.path.toLowerCase() : item.path;
    return key !== target;
  });
  if (projects.length !== before) await writeRegistry({ schemaVersion: 1, projects });
  return projects.length !== before;
}

export function getProjectRegistryInfo() {
  return { storeDir, registryFile };
}
