import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const storeDir = path.join(os.homedir(), '.project-observer');
const memoryFile = path.join(storeDir, 'project-memories.json');

const TYPE_LABELS = {
  decision: '关键决策',
  failure: '失败 / 问题经验',
  constraint: '长期约束',
  milestone: '里程碑',
  issue: '未解决事项'
};

const SCOPE_LABELS = {
  download: '下载链路', search: '检索体验', settings: '设置与配置', portable: 'Windows 便携版',
  web: 'Web 与来源展示', ci: '构建与发布', docs: '文档与发布流程', engine: '内部引擎',
  api: '接口与服务', ui: '界面体验', frontend: '界面体验', desktop: '桌面应用', build: '构建与打包',
  release: '发布流程', state: '项目状态', project: '项目状态', codex: 'AI 开发记录', identity: '项目身份',
  test: '测试验证', data: '数据处理', auth: '权限与账号', deploy: '部署交付'
};

function clean(value, limit = 220) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return null;
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function canonical(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[\s`*_~#>“”‘’'"，。；：、！？,.!?:;()（）\[\]【】{}]/g, '')
    .slice(0, 180);
}

function fingerprint(type, title) {
  return `${type}:${canonical(title)}`;
}

function stableId(projectKey, type, title) {
  return crypto.createHash('sha1').update(`${projectKey}|${fingerprint(type, title)}`).digest('hex').slice(0, 16);
}

function uniqueEvidence(items = [], limit = 8) {
  const seen = new Set();
  const result = [];
  for (const item of items) {
    if (!item) continue;
    const key = `${item.kind || ''}|${item.source || ''}|${item.ref || ''}|${canonical(item.excerpt)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
    if (result.length >= limit) break;
  }
  return result;
}

function projectKey(project) {
  return project.identity?.key || `path:${String(project.path || '').toLowerCase()}`;
}

function evidence(kind, source, excerpt, ref = null) {
  return {
    kind,
    source,
    ref,
    excerpt: clean(excerpt, 260)
  };
}

function memory(type, title, {
  detail = null,
  validity = 'unknown',
  eventAt = null,
  confidence = 'medium',
  evidence: evidenceItems = []
} = {}) {
  return {
    type,
    title: clean(title, 180),
    detail: clean(detail, 260),
    validity,
    eventAt,
    confidence,
    evidence: uniqueEvidence(evidenceItems)
  };
}

function parseCommit(subject = '') {
  const text = String(subject || '').trim();
  const conventional = text.match(/^(feat|fix|refactor|build|docs|chore|test|ci|revert)(?:\(([^)]+)\))?:\s*(.+)$/i);
  if (conventional) return {
    type: conventional[1].toLowerCase(),
    scope: conventional[2]?.toLowerCase() || null,
    message: clean(conventional[3], 180)
  };
  return { type: null, scope: null, message: clean(text, 180) };
}

function inferScope(message = '') {
  const text = String(message || '').toLowerCase();
  const rules = [
    ['download', /(download|pdf|下载)/], ['search', /(search|title match|检索|搜索)/], ['settings', /(settings|配置|设置)/],
    ['portable', /(portable|runtime|exe|便携)/], ['web', /(web|source|来源)/], ['ci', /(ci|actions|workflow)/],
    ['build', /(build|package|打包)/], ['docs', /(docs|readme|文档)/], ['api', /(api|server|接口)/],
    ['test', /(test|spec|验证|测试)/], ['data', /(data|dataset|数据)/], ['auth', /(auth|login|账号|权限)/],
    ['deploy', /(deploy|deployment|上线|部署)/], ['ui', /(ui|layout|style|页面|界面)/], ['engine', /(engine|worker|引擎)/],
    ['state', /(state|状态)/], ['identity', /(identity|归属|身份)/], ['codex', /(codex|session|agent)/]
  ];
  return rules.find(([, re]) => re.test(text))?.[0] || null;
}

function itemsFromSection(section) {
  const bullets = Array.isArray(section?.bullets) ? section.bullets : [];
  if (bullets.length) return bullets;
  return Array.isArray(section?.paragraphs) ? section.paragraphs : [];
}

function collectDecisionMemories(project) {
  const result = [];
  const sections = project.recovery?.readmeSections || [];
  const decisionHeading = /(设计原则|原则|架构|技术结构|技术方案|边界|约定|策略|decision|architecture|design)/i;

  for (const section of sections.filter(item => decisionHeading.test(String(item.heading || '')))) {
    for (const item of itemsFromSection(section).slice(0, 8)) {
      result.push(memory('decision', item, {
        validity: 'active',
        confidence: 'high',
        evidence: [evidence('document', `README > ${section.heading}`, item, 'README.md')]
      }));
    }
  }

  for (const note of project.notes || []) {
    const text = clean(note, 220);
    if (!text) continue;
    const isConstraint = /(不能|只允许|限制|边界|不得|禁止|必须保持)/.test(text);
    result.push(memory(isConstraint ? 'constraint' : 'decision', text, {
      validity: 'active',
      confidence: 'high',
      evidence: [evidence('explicit_state', '.project-state.json > notes', text, '.project-state.json')]
    }));
  }

  return result;
}

function collectConstraintMemories(project) {
  const result = [];
  const sections = project.recovery?.readmeSections || [];
  const limitationHeading = /(当前限制|已知限制|限制|known issues|limitations|known limitations)/i;

  for (const section of sections.filter(item => limitationHeading.test(String(item.heading || '')))) {
    for (const item of itemsFromSection(section).slice(0, 10)) {
      result.push(memory('constraint', item, {
        validity: 'active',
        confidence: 'high',
        evidence: [evidence('document', `README > ${section.heading}`, item, 'README.md')]
      }));
    }
  }
  return result;
}

function collectIssueMemories(project) {
  const result = [];
  for (const goal of project.goals || []) {
    if (['done', 'completed'].includes(goal.status)) continue;
    const title = clean(goal.title, 180);
    if (!title) continue;
    result.push(memory('issue', title, {
      detail: goal.status === 'blocked' ? '当前显式状态：受阻' : goal.status === 'in_progress' ? '当前显式状态：进行中' : '当前显式状态：待处理',
      validity: 'open',
      confidence: 'high',
      evidence: [evidence('explicit_state', goal.source || '项目目标', title, goal.source || null)]
    }));
  }
  return result;
}

function collectMilestoneMemories(project) {
  const result = [];
  for (const form of project.insight?.deliveryForms || []) {
    const title = `形成交付形态：${form.name}`;
    result.push(memory('milestone', title, {
      detail: form.detail || null,
      validity: 'achieved',
      confidence: 'high',
      evidence: [evidence('document', `README > ${form.name}`, form.detail || form.name, 'README.md')]
    }));
  }

  const completed = (project.goals || []).filter(goal => ['done', 'completed'].includes(goal.status));
  for (const goal of completed.slice(0, 10)) {
    const title = clean(goal.title, 180);
    if (!title) continue;
    result.push(memory('milestone', title, {
      validity: 'achieved',
      confidence: 'high',
      evidence: [evidence('explicit_state', goal.source || '已完成项目目标', title, goal.source || null)]
    }));
  }
  return result;
}

function collectGitFailureMemories(project) {
  const buckets = new Map();
  for (const commit of project.git?.historyCommits || project.git?.recentCommits || []) {
    const parsed = parseCommit(commit.subject);
    if (!['fix', 'revert'].includes(parsed.type)) continue;
    const scope = parsed.scope || inferScope(parsed.message || commit.subject) || 'other';
    const bucket = buckets.get(scope) || { scope, label: SCOPE_LABELS[scope] || '项目功能', commits: [] };
    bucket.commits.push({ ...commit, parsed });
    buckets.set(scope, bucket);
  }

  return [...buckets.values()]
    .sort((a, b) => String(b.commits[0]?.date || '').localeCompare(String(a.commits[0]?.date || '')))
    .slice(0, 8)
    .map(bucket => {
      const latest = [...bucket.commits].sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')))[0];
      const count = bucket.commits.length;
      const title = count > 1
        ? `${bucket.label}曾连续出现问题，已通过 ${count} 次修复处理`
        : `${bucket.label}曾出现问题，已有修复记录`;
      return memory('failure', title, {
        detail: latest?.parsed?.message || null,
        validity: 'resolved',
        eventAt: latest?.date || null,
        confidence: 'high',
        evidence: bucket.commits.slice(0, 4).map(commit => evidence('git', 'Git 修复提交', commit.subject, commit.shortHash || commit.hash))
      });
    });
}

function collectCodexProblemMemories(project) {
  const sessions = project.agentSessions?.codex?.sessions || [];
  const result = [];
  for (const session of sessions) {
    const dev = session.developmentEvent || {};
    const request = clean(dev.request, 220);
    if (!request || !/(修复|失败|报错|错误|无法|不能|不工作|问题|bug|异常)/i.test(request)) continue;
    const resultText = clean(dev.result, 260);
    const verified = Array.isArray(dev.verification) && dev.verification.length > 0;
    result.push(memory('failure', `AI 开发中处理过：${clean(request, 100)}`, {
      detail: resultText,
      validity: verified || /(修复|解决|完成|恢复|通过)/.test(resultText || '') ? 'resolved' : 'unknown',
      eventAt: session.lastActivity || session.startedAt || null,
      confidence: verified ? 'high' : 'medium',
      evidence: [
        evidence('codex', 'Codex 用户需求', request, session.id),
        resultText ? evidence('codex', 'Codex 最终说明', resultText, session.id) : null,
        ...(dev.verification || []).slice(0, 2).map(item => evidence('codex', 'Codex 验证语句', item, session.id))
      ]
    }));
  }
  return result.slice(0, 8);
}

function dedupeCandidates(candidates) {
  const map = new Map();
  for (const candidate of candidates) {
    if (!candidate?.title) continue;
    const key = fingerprint(candidate.type, candidate.title);
    const existing = map.get(key);
    if (!existing) {
      map.set(key, candidate);
      continue;
    }
    existing.evidence = uniqueEvidence([...(existing.evidence || []), ...(candidate.evidence || [])]);
    existing.confidence = existing.confidence === 'high' || candidate.confidence === 'high' ? 'high' : 'medium';
    if (!existing.detail && candidate.detail) existing.detail = candidate.detail;
    if (!existing.eventAt && candidate.eventAt) existing.eventAt = candidate.eventAt;
  }
  return [...map.values()];
}

function extractCandidates(project) {
  return dedupeCandidates([
    ...collectDecisionMemories(project),
    ...collectConstraintMemories(project),
    ...collectIssueMemories(project),
    ...collectMilestoneMemories(project),
    ...collectGitFailureMemories(project),
    ...collectCodexProblemMemories(project)
  ]).slice(0, 60);
}

async function readStore() {
  try {
    const raw = await fs.readFile(memoryFile, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      schemaVersion: 1,
      projects: parsed && typeof parsed.projects === 'object' ? parsed.projects : {}
    };
  } catch {
    return { schemaVersion: 1, projects: {} };
  }
}

async function writeStore(store) {
  await fs.mkdir(storeDir, { recursive: true });
  const tmp = `${memoryFile}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(store, null, 2)}\n`, 'utf8');
  await fs.rename(tmp, memoryFile);
}

function mergeProjectMemory(project, previous = null) {
  const key = projectKey(project);
  const now = new Date().toISOString();
  const candidates = extractCandidates(project);
  const oldItems = Array.isArray(previous?.memories) ? previous.memories : [];
  const oldByFingerprint = new Map(oldItems.map(item => [fingerprint(item.type, item.title), item]));
  const currentFingerprints = new Set();
  const merged = [];

  for (const candidate of candidates) {
    const fp = fingerprint(candidate.type, candidate.title);
    currentFingerprints.add(fp);
    const old = oldByFingerprint.get(fp);
    merged.push({
      id: old?.id || stableId(key, candidate.type, candidate.title),
      ...candidate,
      firstSeenAt: old?.firstSeenAt || now,
      lastConfirmedAt: now,
      currentEvidence: true,
      evidence: uniqueEvidence([...(candidate.evidence || []), ...(old?.evidence || [])])
    });
  }

  const completedTitles = new Set((project.goals || [])
    .filter(goal => ['done', 'completed'].includes(goal.status))
    .map(goal => canonical(goal.title)));

  for (const old of oldItems) {
    const fp = fingerprint(old.type, old.title);
    if (currentFingerprints.has(fp)) continue;
    let validity = old.validity;
    if (old.type === 'issue' && completedTitles.has(canonical(old.title))) validity = 'resolved';
    else if (['decision', 'constraint', 'issue'].includes(old.type)) validity = 'unknown';
    merged.push({
      ...old,
      validity,
      currentEvidence: false
    });
  }

  merged.sort((a, b) => {
    const current = Number(Boolean(b.currentEvidence)) - Number(Boolean(a.currentEvidence));
    if (current) return current;
    return String(b.lastConfirmedAt || b.eventAt || '').localeCompare(String(a.lastConfirmedAt || a.eventAt || ''));
  });

  return {
    key,
    name: project.name,
    path: project.path,
    updatedAt: now,
    memories: merged.slice(0, 120)
  };
}

function publicMemory(projectMemory) {
  const items = projectMemory.memories || [];
  const counts = {};
  for (const type of Object.keys(TYPE_LABELS)) counts[type] = items.filter(item => item.type === type).length;
  return {
    updatedAt: projectMemory.updatedAt,
    items,
    counts,
    typeLabels: TYPE_LABELS,
    store: { memoryFile }
  };
}

export async function attachProjectMemory(projects) {
  const store = await readStore();
  for (const project of projects) {
    const key = projectKey(project);
    const merged = mergeProjectMemory(project, store.projects[key]);
    store.projects[key] = merged;
    project.memory = publicMemory(merged);
  }
  await writeStore(store);
  return projects;
}

export function getProjectMemoryStoreInfo() {
  return { storeDir, memoryFile };
}
