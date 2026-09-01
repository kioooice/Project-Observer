import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const MAX_DOC_BYTES = 256 * 1024;
const MAX_DOCUMENTS = 24;
const ROOT_DOC_PATTERN = /^(readme|roadmap|plan|todo|status|progress|project|project_brief|handoff|requirements|changelog|notes)(\.[^.]+)?$/i;

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

async function readPackageInfo(projectPath) {
  try {
    const raw = await fs.readFile(path.join(projectPath, 'package.json'), 'utf8');
    const data = JSON.parse(raw);
    return {
      name: typeof data.name === 'string' ? data.name : null,
      description: typeof data.description === 'string' ? data.description : null
    };
  } catch {
    return null;
  }
}

function stripMarkdown(value = '') {
  return String(value)
    .replace(/<!--.*?-->/gs, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[`*_~>#|]/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractSummary(markdown) {
  const lines = markdown.replace(/\r/g, '').split('\n');
  const paragraphs = [];
  let current = [];
  const flush = () => {
    const text = stripMarkdown(current.join(' '));
    current = [];
    if (text.length >= 12) paragraphs.push(text);
  };
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) { flush(); continue; }
    if (/^#{1,6}\s/.test(line)) { flush(); continue; }
    if (/^[-*+]\s/.test(line) || /^\d+[.)]\s/.test(line)) { flush(); continue; }
    if (/^```/.test(line) || /^---+$/.test(line) || /^\|/.test(line)) { flush(); continue; }
    current.push(line);
    if (current.join(' ').length > 320) flush();
  }
  flush();
  const summary = paragraphs[0] || null;
  return summary && summary.length > 260 ? `${summary.slice(0, 257)}…` : summary;
}

function extractSections(markdown) {
  const sections = [];
  const lines = markdown.replace(/\r/g, '').split('\n');
  let current = null;
  let paragraph = [];
  let inFence = false;

  const flushParagraph = () => {
    if (!current || !paragraph.length) { paragraph = []; return; }
    const text = stripMarkdown(paragraph.join(' '));
    paragraph = [];
    if (text) current.paragraphs.push(text);
  };
  const flushSection = () => {
    flushParagraph();
    if (current) sections.push(current);
    current = null;
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (/^```/.test(line)) { inFence = !inFence; continue; }
    if (inFence) continue;
    const heading = line.match(/^(#{2,4})\s+(.+)$/);
    if (heading) {
      flushSection();
      current = { heading: stripMarkdown(heading[2]), level: heading[1].length, paragraphs: [], bullets: [] };
      continue;
    }
    if (!current) continue;
    if (!line) { flushParagraph(); continue; }
    const bullet = line.match(/^[-*+]\s+(?:\[[ xX]\]\s+)?(.+)$/) || line.match(/^\d+[.)]\s+(.+)$/);
    if (bullet) {
      flushParagraph();
      const text = stripMarkdown(bullet[1]);
      if (text) current.bullets.push(text);
      continue;
    }
    if (/^\|/.test(line) || /^---+$/.test(line)) continue;
    paragraph.push(line);
  }
  flushSection();
  return sections.slice(0, 40);
}

function parseMarkdown(relativePath, markdown) {
  const titleMatch = markdown.match(/^#\s+(.+)$/m);
  const title = titleMatch ? stripMarkdown(titleMatch[1]) : path.basename(relativePath);
  const checkboxes = [];
  const checkboxRe = /^\s*[-*+]\s+\[([ xX])\]\s+(.+)$/gm;
  let match;
  while ((match = checkboxRe.exec(markdown)) && checkboxes.length < 80) {
    const itemTitle = stripMarkdown(match[2]);
    if (!itemTitle) continue;
    checkboxes.push({
      title: itemTitle,
      status: match[1].toLowerCase() === 'x' ? 'done' : 'planned',
      source: relativePath
    });
  }
  return {
    path: relativePath,
    title,
    summary: extractSummary(markdown),
    sections: extractSections(markdown),
    checkboxes,
    completedChecklistItems: checkboxes.filter(item => item.status === 'done').length,
    openChecklistItems: checkboxes.filter(item => item.status !== 'done').length
  };
}

async function safeReadText(filePath) {
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile() || stat.size > MAX_DOC_BYTES) return null;
    return await fs.readFile(filePath, 'utf8');
  } catch {
    return null;
  }
}

async function collectDocumentPaths(projectPath) {
  const results = [];
  const seen = new Set();
  const add = absolutePath => {
    const resolved = path.resolve(absolutePath);
    if (seen.has(resolved) || results.length >= MAX_DOCUMENTS) return;
    seen.add(resolved);
    results.push(resolved);
  };
  try {
    const entries = await fs.readdir(projectPath, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (ROOT_DOC_PATTERN.test(entry.name) && /\.(md|mdx|txt)$/i.test(entry.name)) add(path.join(projectPath, entry.name));
    }
  } catch {}
  const docsRoot = path.join(projectPath, 'docs');
  const queue = [{ dir: docsRoot, depth: 0 }];
  while (queue.length && results.length < MAX_DOCUMENTS) {
    const current = queue.shift();
    let entries;
    try { entries = await fs.readdir(current.dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const target = path.join(current.dir, entry.name);
      if (entry.isDirectory() && current.depth < 1 && !entry.name.startsWith('.')) queue.push({ dir: target, depth: current.depth + 1 });
      else if (entry.isFile() && /\.(md|mdx|txt)$/i.test(entry.name)) add(target);
      if (results.length >= MAX_DOCUMENTS) break;
    }
  }
  return results;
}

async function recoverFromDocuments(projectPath) {
  const files = await collectDocumentPaths(projectPath);
  const documents = [];
  for (const filePath of files) {
    const text = await safeReadText(filePath);
    if (!text) continue;
    const relativePath = path.relative(projectPath, filePath).replaceAll('\\', '/');
    documents.push(parseMarkdown(relativePath, text));
  }
  const readme = documents.find(doc => /^readme(\.|$)/i.test(path.basename(doc.path)));
  const recoveredGoals = documents.flatMap(doc => doc.checkboxes).slice(0, 120);
  const unresolvedItems = recoveredGoals.filter(item => item.status !== 'done').slice(0, 30);
  return {
    documents,
    readmeTitle: readme?.title || null,
    readmeSummary: readme?.summary || null,
    readmeSections: readme?.sections || [],
    recoveredGoals,
    unresolvedItems
  };
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

function buildRecovery({ explicit, docs, packageInfo, hasGit }) {
  const sources = [];
  if (explicit) sources.push({ type: 'explicit_state', label: '.project-state.json' });
  if (docs.documents.some(doc => /^readme(\.|$)/i.test(path.basename(doc.path)))) sources.push({ type: 'readme', label: 'README' });
  const docsCount = docs.documents.filter(doc => !/^readme(\.|$)/i.test(path.basename(doc.path))).length;
  if (docsCount) sources.push({ type: 'docs', label: `docs / 项目文档 (${docsCount})` });
  if (packageInfo) sources.push({ type: 'package', label: 'package.json' });
  if (hasGit) sources.push({ type: 'git', label: 'Git 历史' });
  let coverage = '基础';
  if (explicit && (docs.documents.length > 0 || hasGit)) coverage = '较完整';
  else if (sources.length >= 3 || (docs.documents.length > 0 && hasGit)) coverage = '可用';
  return {
    sources,
    coverage,
    readmeSections: docs.readmeSections,
    documents: docs.documents.map(doc => ({
      path: doc.path,
      title: doc.title,
      checklistItems: doc.checkboxes.length,
      completedChecklistItems: doc.completedChecklistItems,
      openChecklistItems: doc.openChecklistItems
    })),
    unresolvedItems: docs.unresolvedItems
  };
}

async function analyzeProject(projectPath) {
  const explicit = await readExplicitState(projectPath);
  const packageInfo = await readPackageInfo(projectPath);
  const docs = await recoverFromDocuments(projectPath);
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
  const explicitGoals = Array.isArray(state.goals) ? state.goals.map(goal => ({ ...goal, source: goal.source || '.project-state.json' })) : [];
  const goals = explicitGoals.length ? explicitGoals : docs.recoveredGoals;
  const progressSource = explicitGoals.length ? 'explicit' : (docs.recoveredGoals.length ? 'document_checklist' : null);
  const summary = state.summary || docs.readmeSummary || packageInfo?.description || null;
  const summarySource = state.summary ? '.project-state.json' : (docs.readmeSummary ? 'README' : (packageInfo?.description ? 'package.json' : null));
  const hasGit = branch !== null || latestCommit !== null || statusText !== null;
  return {
    id: Buffer.from(projectPath).toString('base64url'),
    name: state.name || docs.readmeTitle || packageInfo?.name || path.basename(projectPath),
    path: projectPath,
    summary,
    summarySource,
    status: state.status || (statusText ? 'working_tree_changed' : 'unknown'),
    statusSource: state.status ? '.project-state.json' : (statusText ? 'Git 工作区' : null),
    stage: state.stage || null,
    stageSource: state.stage ? '.project-state.json' : null,
    startedAt: state.startedAt || null,
    goals,
    notes: Array.isArray(state.notes) ? state.notes : [],
    declaredProgress: goalProgress(goals),
    progressSource,
    stateSource: explicit?.source || null,
    recovery: buildRecovery({ explicit, docs, packageInfo, hasGit }),
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
    try { entries = await fs.readdir(current.dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith('.') || ['node_modules', 'dist', 'build', 'vendor', '__pycache__'].includes(entry.name)) continue;
      queue.push({ dir: path.join(current.dir, entry.name), depth: current.depth + 1 });
    }
  }
  const projects = [];
  for (const projectPath of found) projects.push(await analyzeProject(projectPath));
  projects.sort((a, b) => {
    const ad = a.git.latestCommit?.date || '';
    const bd = b.git.latestCommit?.date || '';
    return bd.localeCompare(ad);
  });
  return { root, scannedAt: new Date().toISOString(), projects };
}
