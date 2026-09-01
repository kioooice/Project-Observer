import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

async function git(cwd, args) {
  try {
    const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], {
      windowsHide: true,
      timeout: 7000,
      maxBuffer: 1024 * 1024 * 6
    });
    return stdout.trim();
  } catch {
    return null;
  }
}

function parseNameStatus(lines) {
  const changes = [];
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    const parts = line.split('\t');
    if (parts.length < 2) continue;
    const rawStatus = parts[0];
    const code = rawStatus[0] || 'M';
    if ((code === 'R' || code === 'C') && parts.length >= 3) {
      changes.push({ status: code, from: parts[1], path: parts[2] });
    } else {
      changes.push({ status: code, path: parts[1] });
    }
  }
  return changes;
}

async function recentCommitsWithFiles(projectPath, limit = 16) {
  const format = '%x1e%H%x1f%h%x1f%ad%x1f%s';
  const out = await git(projectPath, [
    'log',
    `-${limit}`,
    '--date=iso-strict',
    `--pretty=format:${format}`,
    '--name-status'
  ]);
  if (!out) return [];

  return out.split('\x1e').map(block => block.trim()).filter(Boolean).map(block => {
    const lines = block.split('\n');
    const header = lines.shift() || '';
    const [hash, shortHash, date, subject] = header.split('\x1f');
    return {
      hash,
      shortHash,
      date,
      subject,
      changes: parseNameStatus(lines)
    };
  }).filter(item => item.hash);
}

async function readSyncState(projectPath, branch, dirtyFiles) {
  const upstream = await git(projectPath, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']);
  if (!upstream) {
    return {
      upstream: null,
      ahead: null,
      behind: null,
      inSync: null,
      clean: dirtyFiles === 0
    };
  }

  const counts = await git(projectPath, ['rev-list', '--left-right', '--count', `${upstream}...HEAD`]);
  let behind = null;
  let ahead = null;
  if (counts) {
    const [left, right] = counts.split(/\s+/).map(Number);
    if (Number.isFinite(left) && Number.isFinite(right)) {
      behind = left;
      ahead = right;
    }
  }

  return {
    upstream,
    branch: branch || null,
    ahead,
    behind,
    inSync: ahead === 0 && behind === 0,
    clean: dirtyFiles === 0
  };
}

export async function attachGitContext(projects) {
  for (const project of projects) {
    const commits = await recentCommitsWithFiles(project.path);
    const dirtyFiles = project.git?.dirtyFiles || 0;
    const sync = await readSyncState(project.path, project.git?.branch || null, dirtyFiles);

    project.git = {
      ...(project.git || {}),
      recentCommits: commits,
      latestCommit: commits[0]
        ? { date: commits[0].date, subject: commits[0].subject, hash: commits[0].hash, shortHash: commits[0].shortHash }
        : project.git?.latestCommit || null,
      sync
    };
  }
  return projects;
}
