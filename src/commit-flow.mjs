import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const MAX_BATCHES = 5;
const MAX_FILES_PER_BATCH = 18;
const MAX_TEXT_BYTES = 256 * 1024;
const BATCH_GAP_MS = 20 * 60 * 1000;

const ROLE_RULES = [
  ['verification', /(tests?|specs?|e2e|integration|eval|evaluation|benchmark|quality|audit)/i, '测试 / 评测'],
  ['ui', /(^|\/)(public|frontend|front|ui|web|client|renderer)(\/|$)|\.(css|scss|html|vue|svelte|tsx|jsx)$/i, '界面 / 前端'],
  ['api', /(^|\/)(api|routes?|controllers?)(\/|$)|server\.(m?js|ts|py)$/i, '接口 / 路由'],
  ['service', /(^|\/)(services?|engine|workers?|core|lib)(\/|$)/i, '服务 / 核心逻辑'],
  ['data', /(^|\/)(data|datasets?|db|database|storage|store|models?|knowledge|mappings?)(\/|$)|\.(sql|sqlite|db)$/i, '数据 / 存储'],
  ['build', /(^|\/)(\.github|scripts?|tools?|runtime|desktop|src-tauri)(\/|$)|docker|compose|package\.json|pyproject\.toml|requirements\.txt|vite\.config|webpack|electron|tauri/i, '构建 / 运行'],
  ['docs', /(^|\/)(docs?|documentation)(\/|$)|readme|changelog|\.md$/i, '文档'],
  ['core', /(^|\/)(src|app)(\/|$)|\.(m?js|cjs|ts|py|rs|go|java|cs|cpp|c)$/i, '核心程序']
];

const ROLE_ORDER = ['ui', 'api', 'service', 'core', 'data', 'verification', 'build', 'docs'];
const CHANGE_LABELS = {
  feat: '新增 / 扩展',
  fix: '修复',
  refactor: '重构',
  build: '构建 / 打包',
  ci: '自动化 / 发布',
  test: '测试 / 验证',
  docs: '文档',
  chore: '工程维护',
  other: '开发'
};

async function git(cwd, args, maxBuffer = 1024 * 1024 * 8) {
  try {
    const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], {
      windowsHide: true,
      timeout: 9000,
      maxBuffer
    });
    return stdout;
  } catch {
    return null;
  }
}

function clean(value, limit = 180) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return null;
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function normalizeFile(value) {
  return String(value || '').replaceAll('\\', '/').replace(/^\.\//, '');
}

function classifyFile(file) {
  const normalized = normalizeFile(file);
  for (const [kind, re, label] of ROLE_RULES) {
    if (re.test(normalized)) return { kind, label };
  }
  return { kind: 'other', label: '其他文件' };
}

function parseCommitType(subject = '') {
  const match = String(subject).trim().match(/^(feat|fix|refactor|build|ci|test|docs|chore)(?:\([^)]+\))?:/i);
  return match ? match[1].toLowerCase() : 'other';
}

function groupCommits(commits = []) {
  const sorted = [...commits]
    .filter(commit => commit?.hash && commit?.date)
    .sort((a, b) => String(b.date).localeCompare(String(a.date)));
  const batches = [];
  for (const commit of sorted) {
    const time = new Date(commit.date).getTime();
    const current = batches.at(-1);
    if (current && Number.isFinite(time) && current.oldestTime - time >= 0 && current.oldestTime - time <= BATCH_GAP_MS) {
      current.commits.push(commit);
      current.oldestTime = time;
      current.oldestAt = commit.date;
    } else {
      batches.push({
        newestAt: commit.date,
        oldestAt: commit.date,
        newestTime: time,
        oldestTime: time,
        commits: [commit]
      });
    }
    if (batches.length > MAX_BATCHES && batches.at(-1)?.commits?.length === 1) break;
  }
  return batches.slice(0, MAX_BATCHES);
}

function collectChangedFiles(batch) {
  const byPath = new Map();
  for (const commit of [...batch.commits].reverse()) {
    for (const change of commit.changes || []) {
      const file = normalizeFile(change.path || change.from);
      if (!file) continue;
      const previous = byPath.get(file) || { path: file, statuses: new Set(), commits: new Set() };
      previous.statuses.add(change.status || 'M');
      previous.commits.add(commit.shortHash || commit.hash);
      byPath.set(file, previous);
    }
  }
  return [...byPath.values()].slice(0, MAX_FILES_PER_BATCH).map(item => ({
    path: item.path,
    statuses: [...item.statuses],
    commits: [...item.commits],
    ...classifyFile(item.path)
  }));
}

async function readText(projectPath, relativePath) {
  try {
    const absolute = path.join(projectPath, relativePath);
    const stat = await fs.stat(absolute);
    if (!stat.isFile() || stat.size > MAX_TEXT_BYTES) return null;
    return await fs.readFile(absolute, 'utf8');
  } catch {
    return null;
  }
}

function extractImports(file, text) {
  if (!text) return [];
  const ext = path.extname(file).toLowerCase();
  const result = [];
  if (['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx'].includes(ext)) {
    const patterns = [
      /(?:import\s+(?:[^'";]+?\s+from\s+)?|export\s+[^'";]*?\s+from\s+)['"]([^'"]+)['"]/g,
      /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
      /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g
    ];
    for (const re of patterns) {
      let match;
      while ((match = re.exec(text)) && result.length < 80) result.push(match[1]);
    }
  } else if (ext === '.py') {
    const re = /^\s*(?:from\s+([.\w]+)\s+import|import\s+([\w.]+))/gm;
    let match;
    while ((match = re.exec(text)) && result.length < 80) result.push(match[1] || match[2]);
  } else if (ext === '.rs') {
    const re = /^\s*use\s+crate::([\w:]+)/gm;
    let match;
    while ((match = re.exec(text)) && result.length < 80) result.push(`crate::${match[1]}`);
  }
  return [...new Set(result)];
}

function resolveJsImport(source, spec, changedSet) {
  if (!spec.startsWith('.')) return null;
  const base = normalizeFile(path.posix.normalize(path.posix.join(path.posix.dirname(source), spec)));
  const candidates = [
    base,
    ...['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.json'].map(ext => `${base}${ext}`),
    ...['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx'].map(ext => `${base}/index${ext}`)
  ];
  return candidates.find(candidate => changedSet.has(candidate)) || null;
}

function resolvePythonImport(source, spec, changedSet) {
  if (!spec) return null;
  let module = spec;
  let baseDir = path.posix.dirname(source);
  const leading = module.match(/^\.+/)?.[0]?.length || 0;
  if (leading) {
    for (let i = 1; i < leading; i += 1) baseDir = path.posix.dirname(baseDir);
    module = module.slice(leading);
  } else {
    baseDir = '';
  }
  const modulePath = module.replaceAll('.', '/');
  const base = normalizeFile(path.posix.join(baseDir, modulePath));
  const candidates = [`${base}.py`, `${base}/__init__.py`];
  return candidates.find(candidate => changedSet.has(candidate)) || null;
}

function resolveRustImport(spec, changedSet) {
  if (!spec.startsWith('crate::')) return null;
  const modulePath = spec.slice('crate::'.length).replaceAll('::', '/');
  const candidates = [`src/${modulePath}.rs`, `src/${modulePath}/mod.rs`];
  return candidates.find(candidate => changedSet.has(candidate)) || null;
}

async function importEdges(projectPath, files) {
  const changedSet = new Set(files.map(file => file.path));
  const edges = [];
  for (const file of files) {
    const text = await readText(projectPath, file.path);
    if (!text) continue;
    const imports = extractImports(file.path, text);
    for (const spec of imports) {
      const ext = path.extname(file.path).toLowerCase();
      let target = null;
      if (['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx'].includes(ext)) target = resolveJsImport(file.path, spec, changedSet);
      else if (ext === '.py') target = resolvePythonImport(file.path, spec, changedSet);
      else if (ext === '.rs') target = resolveRustImport(spec, changedSet);
      if (!target || target === file.path) continue;
      edges.push({
        from: file.path,
        to: target,
        relation: 'imports',
        label: '代码直接引用',
        confidence: 'high',
        evidence: `${file.path} → ${spec}`
      });
    }
  }
  const seen = new Set();
  return edges.filter(edge => {
    const key = `${edge.from}|${edge.to}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 24);
}

function parseNumstat(output) {
  const result = new Map();
  for (const line of String(output || '').split('\n')) {
    if (!line.trim()) continue;
    const [addedRaw, deletedRaw, ...rest] = line.split('\t');
    const file = normalizeFile(rest.join('\t'));
    if (!file) continue;
    const added = Number(addedRaw);
    const deleted = Number(deletedRaw);
    result.set(file, {
      added: Number.isFinite(added) ? added : null,
      deleted: Number.isFinite(deleted) ? deleted : null
    });
  }
  return result;
}

function extractSymbolsFromDiff(diff) {
  const map = new Map();
  let currentFile = null;
  const add = symbol => {
    const value = clean(symbol, 100);
    if (!currentFile || !value) return;
    const list = map.get(currentFile) || [];
    if (!list.includes(value) && list.length < 6) list.push(value);
    map.set(currentFile, list);
  };

  for (const rawLine of String(diff || '').split('\n')) {
    const fileMatch = rawLine.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (fileMatch) {
      currentFile = normalizeFile(fileMatch[2]);
      continue;
    }
    const hunk = rawLine.match(/^@@[^@]*@@\s*(.+)$/);
    if (hunk && hunk[1]) add(hunk[1]);
    if (!/^[+-][^+-]/.test(rawLine)) continue;
    const line = rawLine.slice(1).trim();
    const patterns = [
      /^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/,
      /^(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/,
      /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(?[^=]*=>/,
      /^(?:async\s+)?def\s+([A-Za-z_][\w]*)\s*\(/,
      /^class\s+([A-Za-z_][\w]*)\s*[:(]/,
      /^(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z_][\w]*)\s*\(/
    ];
    for (const re of patterns) {
      const match = line.match(re);
      if (match) { add(match[1]); break; }
    }
  }
  return map;
}

async function diffEvidence(projectPath, batch) {
  const newest = batch.commits[0];
  const oldest = batch.commits.at(-1);
  if (!newest?.hash || !oldest?.hash) return { stats: new Map(), symbols: new Map() };
  const base = `${oldest.hash}^`;
  let numstat = await git(projectPath, ['diff', '--numstat', base, newest.hash], 1024 * 1024 * 4);
  let diff = await git(projectPath, ['diff', '--unified=0', '--no-ext-diff', base, newest.hash], 1024 * 1024 * 10);
  if (numstat == null || diff == null) {
    numstat = await git(projectPath, ['show', '--format=', '--numstat', newest.hash], 1024 * 1024 * 4);
    diff = await git(projectPath, ['show', '--format=', '--unified=0', '--no-ext-diff', newest.hash], 1024 * 1024 * 10);
  }
  return { stats: parseNumstat(numstat), symbols: extractSymbolsFromDiff(diff) };
}

function dominant(items, keyFn) {
  const counts = new Map();
  for (const item of items) {
    const key = keyFn(item);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

function summarizeBatch(batch, files) {
  const type = dominant(batch.commits, commit => parseCommitType(commit.subject))[0]?.[0] || 'other';
  const areas = dominant(files, file => file.kind)
    .filter(([kind]) => !['docs', 'verification', 'other'].includes(kind))
    .slice(0, 2)
    .map(([kind]) => files.find(file => file.kind === kind)?.label)
    .filter(Boolean);
  const fallbackAreas = dominant(files, file => file.kind).slice(0, 2)
    .map(([kind]) => files.find(file => file.kind === kind)?.label)
    .filter(Boolean);
  const focus = (areas.length ? areas : fallbackAreas).join('与') || '项目代码';
  return `本轮主要${CHANGE_LABELS[type] || '开发'}${focus}，涉及 ${files.length} 个文件`;
}

function buildFlow(files, edges) {
  const runtimeFiles = files.filter(file => !['docs', 'other'].includes(file.kind));
  const grouped = new Map();
  for (const file of runtimeFiles) {
    const group = grouped.get(file.kind) || { kind: file.kind, label: file.label, files: [] };
    group.files.push(file.path);
    grouped.set(file.kind, group);
  }
  const groups = [...grouped.values()].sort((a, b) => {
    const ai = ROLE_ORDER.indexOf(a.kind); const bi = ROLE_ORDER.indexOf(b.kind);
    return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
  });
  const crossLayerEdges = edges.filter(edge => {
    const from = files.find(file => file.path === edge.from)?.kind;
    const to = files.find(file => file.path === edge.to)?.kind;
    return from && to && from !== to;
  });

  if (groups.length < 2) {
    return {
      available: false,
      confidence: 'low',
      reason: '本轮改动主要集中在单一模块，暂不能可靠恢复跨模块运行流程。',
      steps: []
    };
  }

  const meaningfulKinds = new Set(groups.map(group => group.kind).filter(kind => ['ui', 'api', 'service', 'core', 'data', 'verification', 'build'].includes(kind)));
  if (meaningfulKinds.size < 2) {
    return {
      available: false,
      confidence: 'low',
      reason: '改动跨文件，但缺少足够的运行层级证据，暂只展示影响范围。',
      steps: []
    };
  }

  const confidence = crossLayerEdges.length ? 'high' : 'medium';
  const steps = groups.map(group => ({
    kind: group.kind,
    label: group.label,
    detail: group.files.slice(0, 4).join(' / '),
    files: group.files.slice(0, 8)
  }));
  return {
    available: true,
    confidence,
    reason: confidence === 'high'
      ? `包含 ${crossLayerEdges.length} 条跨模块代码引用，流程以真实引用关系和模块职责共同恢复。`
      : '没有发现足够的直接调用关系，流程按本轮涉及的模块职责顺序进行结构推断。',
    steps
  };
}

async function analyzeBatch(project, batch, index) {
  const files = collectChangedFiles(batch);
  const [edges, diff] = await Promise.all([
    importEdges(project.path, files),
    diffEvidence(project.path, batch)
  ]);
  for (const file of files) {
    const stat = diff.stats.get(file.path);
    if (stat) Object.assign(file, stat);
    file.symbols = diff.symbols.get(file.path) || [];
  }
  const flow = buildFlow(files, edges);
  return {
    id: `batch-${index + 1}-${batch.commits[0]?.shortHash || index}`,
    startAt: batch.oldestAt,
    endAt: batch.newestAt,
    commitCount: batch.commits.length,
    commits: batch.commits.map(commit => ({
      hash: commit.hash,
      shortHash: commit.shortHash,
      date: commit.date,
      subject: commit.subject
    })),
    summary: summarizeBatch(batch, files),
    files,
    impact: {
      nodes: files.map(file => ({ path: file.path, kind: file.kind, label: file.label, symbols: file.symbols || [] })),
      edges
    },
    flow
  };
}

export async function attachCommitFlows(projects) {
  for (const project of projects) {
    try {
      const batches = groupCommits(project.git?.recentCommits || []);
      const analyses = [];
      for (let i = 0; i < batches.length; i += 1) analyses.push(await analyzeBatch(project, batches[i], i));
      project.commitFlow = {
        generatedAt: new Date().toISOString(),
        batchCount: analyses.length,
        batches: analyses
      };
    } catch (error) {
      project.commitFlow = {
        generatedAt: new Date().toISOString(),
        batchCount: 0,
        batches: [],
        error: error?.message || String(error)
      };
    }
  }
  return projects;
}
