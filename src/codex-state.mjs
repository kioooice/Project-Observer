import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { normalizeGitRemote } from './identity.mjs';

const execFileAsync = promisify(execFile);
const codexHome = path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'));
const stateDbPath = path.resolve(process.env.CODEX_STATE_DB || path.join(codexHome, 'state_5.sqlite'));
const MAX_THREADS = Math.max(20, Math.min(2000, Number(process.env.PROJECT_OBSERVER_CODEX_MAX_THREADS || 500)));

const desiredColumns = [
  'id', 'rollout_path', 'created_at_ms', 'updated_at_ms', 'recency_at_ms', 'source',
  'cwd', 'title', 'name', 'preview', 'first_user_message', 'project_id',
  'git_sha', 'git_branch', 'git_origin_url'
];

function toIso(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  const date = Number.isFinite(n) ? new Date(n) : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function compactText(value, limit = 180) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return null;
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function buildSession(row) {
  const first = compactText(row.first_user_message);
  const name = compactText(row.name);
  const title = compactText(row.title);
  const preview = compactText(row.preview);
  const originUrl = row.git_origin_url || null;
  const createdAt = toIso(row.created_at_ms);
  const lastActivity = toIso(row.recency_at_ms) || toIso(row.updated_at_ms) || createdAt;

  return {
    id: String(row.id),
    projectPath: row.cwd || null,
    startedAt: createdAt,
    lastActivity,
    title: first || name || title || preview || 'Codex 会话（状态库未提供标题）',
    userTurns: first ? 1 : 0,
    modelProvider: null,
    projectId: row.project_id || null,
    rolloutPath: row.rollout_path || null,
    source: row.source || null,
    storage: 'state_db',
    git: originUrl || row.git_sha || row.git_branch ? {
      originUrl,
      remoteKey: normalizeGitRemote(originUrl),
      sha: row.git_sha || null,
      branch: row.git_branch || null
    } : null
  };
}

function projection(columns) {
  const available = new Set(columns);
  return desiredColumns.map(column => available.has(column) ? column : `NULL AS ${column}`).join(', ');
}

async function queryWithNodeSqlite(dbPath) {
  try {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const columns = db.prepare('PRAGMA table_info(threads)').all().map(row => row.name);
      if (!columns.length) throw new Error('threads 表不存在');
      const sql = `SELECT ${projection(columns)} FROM threads ORDER BY COALESCE(recency_at_ms, updated_at_ms, created_at_ms) DESC LIMIT ?`;
      const rows = db.prepare(sql).all(MAX_THREADS);
      return { rows, reader: 'node:sqlite', error: null };
    } finally {
      db.close();
    }
  } catch (error) {
    return { rows: null, reader: null, error: error?.message || String(error) };
  }
}

const PYTHON_SCRIPT = String.raw`
import json, sqlite3, sys
from pathlib import Path

p = Path(sys.argv[1]).resolve()
limit = int(sys.argv[2])
wanted = ${JSON.stringify(desiredColumns)}
uri = 'file:' + p.as_posix() + '?mode=ro'
con = sqlite3.connect(uri, uri=True)
con.row_factory = sqlite3.Row
try:
    columns = [r['name'] for r in con.execute('PRAGMA table_info(threads)').fetchall()]
    if not columns:
        raise RuntimeError('threads table not found')
    projection = ', '.join([c if c in columns else f'NULL AS {c}' for c in wanted])
    sql = f'SELECT {projection} FROM threads ORDER BY COALESCE(recency_at_ms, updated_at_ms, created_at_ms) DESC LIMIT ?'
    rows = [dict(r) for r in con.execute(sql, (limit,)).fetchall()]
    print(json.dumps(rows, ensure_ascii=False))
finally:
    con.close()
`;

async function queryWithPython(dbPath) {
  const candidates = [];
  if (process.env.PYTHON) candidates.push({ command: process.env.PYTHON, prefix: [] });
  if (process.platform === 'win32') candidates.push({ command: 'py', prefix: ['-3'] });
  candidates.push({ command: 'python', prefix: [] }, { command: 'python3', prefix: [] });

  const errors = [];
  for (const candidate of candidates) {
    try {
      const { stdout } = await execFileAsync(candidate.command, [...candidate.prefix, '-c', PYTHON_SCRIPT, dbPath, String(MAX_THREADS)], {
        windowsHide: true,
        timeout: 8000,
        maxBuffer: 1024 * 1024 * 8
      });
      const rows = JSON.parse(stdout || '[]');
      return { rows, reader: candidate.command === 'py' ? 'Python sqlite3 (py -3)' : `Python sqlite3 (${candidate.command})`, error: null };
    } catch (error) {
      errors.push(`${candidate.command}: ${error?.message || String(error)}`);
    }
  }
  return { rows: null, reader: null, error: errors.join(' | ') };
}

export async function readCodexStateThreads() {
  let exists = true;
  try { await fs.access(stateDbPath); } catch { exists = false; }

  if (!exists) {
    return {
      available: false,
      path: stateDbPath,
      reader: null,
      threadCount: 0,
      sessions: [],
      error: '未发现 state_5.sqlite'
    };
  }

  let result = await queryWithNodeSqlite(stateDbPath);
  if (!result.rows) result = await queryWithPython(stateDbPath);

  if (!result.rows) {
    return {
      available: true,
      readable: false,
      path: stateDbPath,
      reader: null,
      threadCount: 0,
      sessions: [],
      error: result.error || '无法读取 Codex 状态库'
    };
  }

  const sessions = result.rows
    .map(buildSession)
    .filter(session => session.id && (session.projectPath || session.git?.remoteKey || session.projectId));

  return {
    available: true,
    readable: true,
    path: stateDbPath,
    reader: result.reader,
    threadCount: sessions.length,
    sessions,
    error: null
  };
}
