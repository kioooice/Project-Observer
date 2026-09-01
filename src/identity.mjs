import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export function normalizeFsPath(value) {
  if (!value) return '';
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

export function isInsidePath(candidate, root) {
  if (!candidate || !root) return false;
  if (candidate === root) return true;
  return candidate.startsWith(root.endsWith(path.sep) ? root : `${root}${path.sep}`);
}

export function normalizeGitRemote(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;

  if (/^[a-zA-Z]:[\\/]/.test(raw) || raw.startsWith('/') || raw.startsWith('./') || raw.startsWith('../')) {
    return `local:${normalizeFsPath(raw)}`;
  }

  const scp = raw.match(/^(?:[^@]+@)?([^:/]+):(.+)$/);
  if (scp && !raw.includes('://')) {
    const host = scp[1].toLowerCase();
    const repo = scp[2].replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '').toLowerCase();
    return `${host}/${repo}`;
  }

  try {
    const url = new URL(raw);
    if (url.protocol === 'file:') return `local:${normalizeFsPath(url.pathname)}`;
    const host = url.hostname.toLowerCase();
    const repo = url.pathname.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '').toLowerCase();
    return host && repo ? `${host}/${repo}` : raw.toLowerCase();
  } catch {
    return raw.replace(/\.git$/i, '').replace(/\\/g, '/').replace(/\/$/, '').toLowerCase();
  }
}

async function git(cwd, args) {
  try {
    const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], {
      windowsHide: true,
      timeout: 5000,
      maxBuffer: 1024 * 1024
    });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

async function readIdentityConfig(projectPath) {
  try {
    const raw = await fs.readFile(path.join(projectPath, '.project-state.json'), 'utf8');
    const state = JSON.parse(raw);
    const identity = state?.identity && typeof state.identity === 'object' ? state.identity : {};
    return {
      projectKey: typeof identity.projectKey === 'string' && identity.projectKey.trim() ? identity.projectKey.trim() : null,
      pathAliases: Array.isArray(identity.pathAliases) ? identity.pathAliases.filter(item => typeof item === 'string' && item.trim()) : []
    };
  } catch {
    return { projectKey: null, pathAliases: [] };
  }
}

export async function attachProjectIdentities(projects) {
  for (const project of projects) {
    const [originUrl, repoRoot, config] = await Promise.all([
      git(project.path, ['config', '--get', 'remote.origin.url']),
      git(project.path, ['rev-parse', '--show-toplevel']),
      readIdentityConfig(project.path)
    ]);

    const remoteKey = normalizeGitRemote(originUrl);
    const key = config.projectKey || (remoteKey ? `git:${remoteKey}` : `path:${normalizeFsPath(project.path)}`);
    const aliases = [...new Set(config.pathAliases.map(normalizeFsPath).filter(Boolean))];

    project.identity = {
      key,
      source: config.projectKey ? 'explicit' : (remoteKey ? 'git_remote' : 'path'),
      remoteKey,
      pathAliases: aliases
    };
    project.id = Buffer.from(key).toString('base64url');
    project.git = {
      ...(project.git || {}),
      originUrl: originUrl || null,
      remoteKey,
      repoRoot: repoRoot || project.path
    };
  }
  return projects;
}
