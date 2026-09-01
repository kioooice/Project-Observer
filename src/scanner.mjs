import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

async function exists(target) {
  try { await fs.access(target); return true; } catch { return false; }
}

async function git(cwd, args) {
  try {
    const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], {
      windowsHide: true,
      timeout: 6000,
      maxBuffer: 1024 * 1024 * 4
    });
    return stdout.trim();
  } catch {
    return null;
  }
}

async function readExplicitState(projectPath) {
  const file = path.join(projectPath, '.project-state.json');
  try {
    const raw = await fs.readFile(file, 'utf8');
    const data = JSON.parse(raw);
    return { source: '.project-state.json', data };
  } catch {
    return null;
  }
}

function goalProgress(goals = []) {
  if (!Array.isArray(goals) || goals.length === 0) return null;
  const weight = { done: 1, completed: 1, in_progress: 0.5, planned: 0, blocked: 0.25 };
  const points = goals.reduce((sum, item) => sum + (weight[item?.status] ?? 0), 0);
  return Math.round((points / goals.length) * 100);
}

async function recentCommits(projectPath, limit = 8) {
  const format = '%H%x1f%h%x1f%ad%x1f%s';
  const out = await git(projectPath, ['log', `-${limit}`, '--date=iso-strict', `--pretty=format:${format}`]);
  if (!out) return [];
  return out.split('\n').map(line => {
    const [hash, shortHash, date, subject] = line.split('\x1f');
    return { hash, shortHash, date, subject };
  }).filter(x => x.hash);
}

async function analyzeProject(projectPath) {
  const explicit = await readExplicitState(projectPath);
  const branch = await git(projectPath, ['branch', '--show-current']);
  const statusText = await git(projectPath, ['status', '--porcelain']);
  const latest = await git(projectPath, ['log', '-1', '--date=iso-strict', '--pretty=format:%ad%x1f%s']);
  const commits = await recentCommits(projectPath);

  let latestCommit = null;
  if (latest) {
    const [date, subject] = latest.split('\x1f');
    latestCommit = { date, subject };
  }

  const state = explicit?.data ?? {};
  return {
    id: Buffer.from(projectPath).toString('base64url'),
    name: state.name || path.basename(projectPath),
    path: projectPath,
    summary: state.summary || null,
    status: state.status || (statusText ? 'active' : 'unknown'),
    stage: state.stage || null,
    startedAt: state.startedAt || null,
    goals: Array.isArray(state.goals) ? state.goals : [],
    notes: Array.isArray(state.notes) ? state.notes : [],
    declaredProgress: goalProgress(state.goals),
    stateSource: explicit?.source || null,
    git: {
      branch: branch || null,
      dirtyFiles: statusText ? statusText.split('\n').filter(Boolean).length : 0,
      latestCommit,
      recentCommits: commits
    }
  };
}

export async function discoverProjects(rootPath, { maxDepth = 2, maxProjects = 80 } = {}) {
  const root = path.resolve(rootPath);
  if (!(await exists(root))) throw new Error(`Path does not exist: ${root}`);

  const queue = [{ dir: root, depth: 0 }];
  const found = [];
  const seen = new Set();

  while (queue.length && found.length < maxProjects) {
    const current = queue.shift();
    if (!current || seen.has(current.dir)) continue;
    seen.add(current.dir);

    const isGit = await exists(path.join(current.dir, '.git'));
    const hasState = await exists(path.join(current.dir, '.project-state.json'));

    if (isGit || hasState) {
      found.push(current.dir);
      if (current.dir !== root) continue;
    }

    if (current.depth >= maxDepth) continue;

    let entries;
    try {
      entries = await fs.readdir(current.dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith('.') || ['node_modules', 'dist', 'build', 'vendor', '__pycache__'].includes(entry.name)) continue;
      queue.push({ dir: path.join(current.dir, entry.name), depth: current.depth + 1 });
    }
  }

  const projects = [];
  for (const projectPath of found) {
    projects.push(await analyzeProject(projectPath));
  }

  projects.sort((a, b) => {
    const ad = a.git.latestCommit?.date || '';
    const bd = b.git.latestCommit?.date || '';
    return bd.localeCompare(ad);
  });

  return { root, scannedAt: new Date().toISOString(), projects };
}
