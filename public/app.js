const $ = (s) => document.querySelector(s);
const rootInput = $('#rootInput');
const depthSelect = $('#depthSelect');
const scanBtn = $('#scanBtn');
const projectGrid = $('#projectGrid');
const detailPanel = $('#detailPanel');
const metrics = $('#metrics');
const scanMeta = $('#scanMeta');
const scanMessage = $('#scanMessage');
let currentData = null;
let selectedId = null;
let detailRequestToken = 0;

const statusLabels = {
  active: '开发中', paused: '已暂停', completed: '已完成', abandoned: '已停止',
  done: '已完成', planned: '待开发', in_progress: '进行中', blocked: '受阻',
  working_tree_changed: '存在本地改动', unknown: '状态未声明'
};

const sourceLabels = { explicit: '显式目标', document_checklist: '文档清单' };

function statusLabel(value) { return statusLabels[value] || value || '未知'; }

function escapeHtml(value = '') {
  return String(value).replace(/[&<>'"]/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' }[c]));
}

function compactDate(iso, withTime = false) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat('zh-CN', withTime
    ? { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }
    : { month: '2-digit', day: '2-digit' }
  ).format(d);
}

function renderMetrics(data) {
  const projects = data.projects || [];
  const codexSessions = projects.reduce((sum, p) => sum + (p.agentSessions?.codex?.sessionCount || 0), 0);
  const dirty = projects.filter(p => p.git?.dirtyFiles > 0).length;
  const recovered = projects.filter(p => (p.recovery?.sources || []).length >= 2).length;
  metrics.innerHTML = [
    ['项目', projects.length],
    ['Codex 会话', codexSessions],
    ['有未提交改动', dirty],
    ['已恢复多类信息', recovered]
  ].map(([label, value]) => `<div class="metric"><strong>${value}</strong><span>${label}</span></div>`).join('');
}

function progressLabel(p) {
  if (p.progressSource === 'explicit') return '显式目标进度';
  if (p.progressSource === 'document_checklist') return '文档清单进度';
  return '目标进度';
}

function renderProjects(data) {
  projectGrid.innerHTML = '';
  if (!data.projects.length) {
    projectGrid.innerHTML = '<div class="panel" style="padding:20px;color:var(--muted)">没有发现 Git 仓库或 .project-state.json。</div>';
    return;
  }

  for (const p of data.projects) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `project-card${p.id === selectedId ? ' active' : ''}`;
    const isSelf = p.path === data.selfPath;
    const codexCount = p.agentSessions?.codex?.sessionCount || 0;
    btn.innerHTML = `
      <div class="card-top">
        <p class="project-name">${escapeHtml(p.name)}</p>
        <span class="status">${escapeHtml(statusLabel(p.status))}</span>
      </div>
      <div class="stage">${escapeHtml(p.stage || '尚未恢复当前阶段')}</div>
      <div class="card-meta">
        <div><strong>${p.declaredProgress ?? '—'}${p.declaredProgress == null ? '' : '%'}</strong><span>${escapeHtml(progressLabel(p))}</span></div>
        <div><strong>${codexCount}</strong><span>Codex 会话</span></div>
        <div><strong>${p.recovery?.coverage || '基础'}</strong><span>信息覆盖</span></div>
      </div>
      ${isSelf ? '<span class="self-tag">● 当前工具自身</span>' : ''}
    `;
    btn.addEventListener('click', () => selectProject(p.id));
    projectGrid.appendChild(btn);
  }
}

function sourceChips(p) {
  const sources = [...(p.recovery?.sources || [])];
  if (p.agentSessions?.codex?.sessionCount) sources.push({ label: `Codex 会话 (${p.agentSessions.codex.sessionCount})` });
  if (p.identity?.remoteKey) sources.push({ label: 'Git remote 身份' });
  if (!sources.length) return '<span class="muted">暂无可用来源</span>';
  return sources.map(source => `<span class="status">${escapeHtml(source.label)}</span>`).join('');
}

function renderRecoveredDocuments(p) {
  const documents = p.recovery?.documents || [];
  if (!documents.length) return '<div class="muted">没有发现 README / docs / PLAN / TODO 等项目文档。</div>';
  return `<div class="commit-list">${documents.slice(0, 8).map(doc => {
    const checklist = doc.checklistItems ? ` · 清单 ${doc.completedChecklistItems}/${doc.checklistItems}` : '';
    return `<div class="commit"><code>${escapeHtml(doc.path)}</code><div>${escapeHtml(doc.title)}<small>${escapeHtml(checklist || '已读取项目文档')}</small></div></div>`;
  }).join('')}</div>`;
}

function moduleLabel(filePath) {
  const normalized = String(filePath || '').replaceAll('\\', '/');
  const base = normalized.split('/').pop()?.toLowerCase() || normalized.toLowerCase();
  const known = {
    'identity.mjs': '项目身份',
    'identity.js': '项目身份',
    'codex.mjs': 'Codex 会话处理',
    'codex.js': 'Codex 会话处理',
    'observations.mjs': '观察记录',
    'observations.js': '观察记录',
    'scanner.mjs': '项目扫描',
    'scanner.js': '项目扫描',
    'server.mjs': '服务端',
    'server.js': '服务端',
    'app.js': '界面逻辑',
    'styles.css': '界面样式',
    'index.html': '页面结构',
    'readme.md': '项目说明',
    '.project-state.json': '项目状态',
    'package.json': '版本与运行配置'
  };
  if (known[base]) return known[base];
  if (normalized.startsWith('docs/')) return '项目文档';
  if (normalized.startsWith('test/') || normalized.startsWith('tests/')) return '测试';
  if (normalized.startsWith('src/')) return base || '核心代码';
  if (normalized.startsWith('public/')) return base || '前端界面';
  return normalized;
}

function groupGitCommits(commits = []) {
  const sorted = [...commits].filter(c => c.date).sort((a, b) => String(b.date).localeCompare(String(a.date)));
  const groups = [];
  const maxGapMs = 12 * 60 * 1000;

  for (const commit of sorted) {
    const time = new Date(commit.date).getTime();
    const current = groups[groups.length - 1];
    if (!current) {
      groups.push({ date: commit.date, commits: [commit], oldestTime: time });
      continue;
    }
    const gap = current.oldestTime - time;
    if (Number.isFinite(gap) && gap >= 0 && gap <= maxGapMs) {
      current.commits.push(commit);
      current.oldestTime = time;
    } else {
      groups.push({ date: commit.date, commits: [commit], oldestTime: time });
    }
  }
  return groups;
}

function collectBatchChanges(batch) {
  const byPath = new Map();
  for (const commit of [...batch.commits].reverse()) {
    for (const change of commit.changes || []) {
      if (!change?.path) continue;
      byPath.set(change.path, change);
    }
  }
  return [...byPath.values()];
}

function gitSyncText(p) {
  const sync = p.git?.sync;
  const branch = p.git?.branch || sync?.branch || '当前分支';
  const dirtyFiles = p.git?.dirtyFiles || 0;
  const worktree = dirtyFiles === 0 ? '工作区干净' : `工作区还有 ${dirtyFiles} 个未提交文件`;

  if (!sync?.upstream) return `当前 ${branch} 未配置上游，${worktree}`;
  if (sync.inSync) return `当前 ${branch} 与 ${sync.upstream} 一致，${worktree}`;
  if (sync.ahead != null && sync.behind != null) {
    return `当前 ${branch} 相对 ${sync.upstream}：领先 ${sync.ahead}、落后 ${sync.behind}，${worktree}`;
  }
  return `${worktree}`;
}

function summarizeGitBatch(batch, p, isLatest = false) {
  const changes = collectBatchChanges(batch);
  const added = changes.filter(c => c.status === 'A');
  const deleted = changes.filter(c => c.status === 'D');
  const modified = changes.filter(c => c.status !== 'A' && c.status !== 'D');
  const modules = [...new Set(changes.map(c => moduleLabel(c.path)).filter(Boolean))];
  const parts = [];

  if (added.length === 1) parts.push(`新增 ${added[0].path}`);
  else if (added.length > 1) parts.push(`新增 ${added.length} 个文件`);

  const updateModules = [...new Set(modified.map(c => moduleLabel(c.path)).filter(Boolean))];
  if (updateModules.length) {
    const shown = updateModules.slice(0, 4).join('、');
    parts.push(`更新了${shown}${updateModules.length > 4 ? '等模块' : ''}`);
  }

  if (deleted.length === 1) parts.push(`删除 ${deleted[0].path}`);
  else if (deleted.length > 1) parts.push(`删除 ${deleted.length} 个文件`);

  if (!parts.length && modules.length) parts.push(`调整了${modules.slice(0, 4).join('、')}${modules.length > 4 ? '等模块' : ''}`);
  if (!parts.length) parts.push(`完成 ${batch.commits.length} 次 Git 提交`);

  let text = `本次${parts.join('，')}。`;
  if (changes.length > 1) text += ` 共涉及 ${changes.length} 个文件。`;
  if (isLatest) text += ` ${gitSyncText(p)}。`;
  return text;
}

function buildDevelopmentTimeline(p) {
  const gitGroups = groupGitCommits(p.git?.recentCommits || []);
  const gitEvents = gitGroups.map((group, index) => ({
    type: '开发',
    date: group.date,
    title: summarizeGitBatch(group, p, index === 0),
    meta: `${group.commits.length} 次 Git 提交 · ${group.commits.map(c => c.shortHash).filter(Boolean).join('、')}`
  }));
  const codexEvents = (p.agentSessions?.codex?.sessions || []).map(s => ({
    type: 'Codex',
    date: s.lastActivity || s.startedAt,
    title: s.title,
    meta: `${s.userTurns || 0} 次有效用户输入 · ${s.match?.reason || '归属方式未知'}`
  }));
  return [...gitEvents, ...codexEvents]
    .filter(item => item.date)
    .sort((a, b) => String(b.date).localeCompare(String(a.date)))
    .slice(0, 16);
}

function latestDevelopmentSummary(p) {
  const group = groupGitCommits(p.git?.recentCommits || [])[0];
  return group ? summarizeGitBatch(group, p, true) : '暂无可读取的 Git 开发记录。';
}

function codexMatchSummary(codex) {
  const sessions = codex?.sessions || [];
  if (!sessions.length) return '';
  const counts = {};
  for (const session of sessions) {
    const reason = session.match?.reason || '归属方式未知';
    counts[reason] = (counts[reason] || 0) + 1;
  }
  return Object.entries(counts).map(([reason, count]) => `${reason} ${count}`).join(' · ');
}

function renderCodexDiagnostics(p) {
  const codex = p.agentSessions?.codex;
  const global = currentData?.agentSources?.codex;
  if (!codex?.available || codex.sessionCount || !global?.unmatchedSamples?.length) return '';

  return `
    <details style="margin-top:8px">
      <summary class="muted" style="cursor:pointer">查看未匹配会话示例</summary>
      <div class="commit-list" style="margin-top:8px">
        ${global.unmatchedSamples.slice(0, 4).map(item => `
          <div class="commit">
            <code>Codex</code>
            <div>${escapeHtml(item.projectPath || '工作目录未知')}<small>${escapeHtml(item.reason || '未匹配')} ${item.remoteKey ? `· ${escapeHtml(item.remoteKey)}` : ''}</small></div>
          </div>`).join('')}
      </div>
    </details>`;
}

function renderTimeline(p) {
  const items = buildDevelopmentTimeline(p);
  const codex = p.agentSessions?.codex;
  const global = currentData?.agentSources?.codex;
  const matchSummary = codexMatchSummary(codex);
  let sourceNote;

  if (!codex?.available) {
    sourceNote = `未发现 Codex 本地会话目录：${escapeHtml(codex?.sourcePath || '~/.codex/sessions')}`;
  } else if (codex.sessionCount) {
    sourceNote = `已为当前项目匹配 ${codex.sessionCount} 个 Codex 会话${matchSummary ? ` · ${escapeHtml(matchSummary)}` : ''}`;
  } else if ((global?.parsedSessions || 0) > 0) {
    sourceNote = `已解析 ${global.parsedSessions} 个本地 Codex 会话，但没有发现属于当前项目的会话。匹配依据为 Git remote、当前路径和历史路径；如果这个项目主要通过 ChatGPT / GitHub 或其他 Agent 开发，这是正常的。`;
  } else {
    sourceNote = '已找到 Codex 会话目录，但没有解析到可用的项目会话。';
  }

  return `
    <div class="muted" style="margin-top:8px">${sourceNote}</div>
    ${renderCodexDiagnostics(p)}
    <div class="timeline-list">
      ${items.length ? items.map(item => `
        <div class="timeline-item">
          <span class="timeline-source">${escapeHtml(item.type)}</span>
          <div><strong>${escapeHtml(item.title)}</strong><small>${compactDate(item.date, true)} · ${escapeHtml(item.meta)}</small></div>
        </div>`).join('') : '<div class="muted">目前没有可合并的 Git / Codex 开发记录。</div>'}
    </div>`;
}

function renderIdentity(p) {
  const identity = p.identity;
  if (!identity) return '';
  const source = identity.source === 'git_remote' ? 'Git remote' : (identity.source === 'explicit' ? '显式项目身份' : '当前路径');
  const aliasCount = identity.pathAliases?.length || 0;
  return `
    <div class="muted" style="margin-top:8px">项目身份来源：${escapeHtml(source)}</div>
    ${p.git?.originUrl ? `<div class="muted" style="margin-top:4px">Git remote：${escapeHtml(p.git.originUrl)}</div>` : ''}
    <div class="muted" style="margin-top:4px">身份键：${escapeHtml(identity.key)}${aliasCount ? ` · 已保留 ${aliasCount} 个历史路径` : ''}</div>
  `;
}

function renderDetail(p) {
  if (!p) return;
  const goals = p.goals || [];
  const unresolved = p.recovery?.unresolvedItems || [];
  const progressSource = sourceLabels[p.progressSource] || null;

  detailPanel.innerHTML = `
    <p class="eyebrow">项目详情</p>
    <h2 class="detail-title">${escapeHtml(p.name)}</h2>
    <div class="path">${escapeHtml(p.path)}</div>
    <p class="detail-summary">${escapeHtml(p.summary || '当前没有可恢复的项目摘要。')}</p>
    ${p.summarySource ? `<div class="muted">摘要来源：${escapeHtml(p.summarySource)}</div>` : ''}
    ${renderIdentity(p)}

    <div class="detail-section">
      <div class="card-top"><strong>${escapeHtml(p.stage || '阶段尚未恢复')}</strong><span class="status">${escapeHtml(statusLabel(p.status))}</span></div>
      ${p.declaredProgress == null ? '' : `<div class="progressbar" aria-label="目标进度 ${p.declaredProgress}%"><span style="width:${p.declaredProgress}%"></span></div>`}
      ${progressSource ? `<div class="muted" style="margin-top:8px">${escapeHtml(progressSource)}进度：${p.declaredProgress}%</div>` : ''}
      <div class="muted" style="margin-top:6px">最近开发：${escapeHtml(latestDevelopmentSummary(p))} · ${compactDate(p.git?.latestCommit?.date)}</div>
    </div>

    <div class="detail-section">
      <div class="section-heading"><p class="eyebrow">状态恢复</p><span class="status">信息覆盖：${escapeHtml(p.recovery?.coverage || '基础')}</span></div>
      <div class="source-chips">${sourceChips(p)}</div>
      <div style="margin-top:12px">${renderRecoveredDocuments(p)}</div>
      <div class="muted" style="margin-top:10px">只恢复可直接验证的信息，不自动臆测开发阶段和后续方向。</div>
    </div>

    <div class="detail-section">
      <p class="eyebrow">开发历程 · Git + Codex</p>
      ${renderTimeline(p)}
    </div>

    <div class="detail-section">
      <div class="section-heading"><p class="eyebrow">观察历史</p><span class="status">本地持续记录</span></div>
      <div id="observationHistory" class="observation-list"><div class="muted">正在读取历史快照…</div></div>
    </div>

    <div class="detail-section">
      <p class="eyebrow">当前目标</p>
      <div class="goal-list">
        ${goals.length ? goals.map(g => `<div class="goal"><span class="goal-bullet ${escapeHtml(g.status)}"></span><div>${escapeHtml(g.title)}<small>${escapeHtml(statusLabel(g.status))}${g.source ? ` · ${escapeHtml(g.source)}` : ''}</small></div></div>`).join('') : '<div class="muted">没有发现显式目标或 Markdown 清单。</div>'}
      </div>
    </div>

    ${unresolved.length ? `<div class="detail-section">
      <p class="eyebrow">文档中明确未完成</p>
      <div class="goal-list">
        ${unresolved.slice(0, 10).map(item => `<div class="goal"><span class="goal-bullet planned"></span><div>${escapeHtml(item.title)}<small>${escapeHtml(item.source)}</small></div></div>`).join('')}
      </div>
    </div>` : ''}
  `;
}

async function loadObservationHistory(p, token) {
  const target = $('#observationHistory');
  if (!target) return;
  try {
    const params = new URLSearchParams({ project: p.path, limit: '12' });
    if (p.identity?.key) params.set('key', p.identity.key);
    const res = await fetch(`/api/observations?${params}`);
    const data = await res.json();
    if (token !== detailRequestToken || p.id !== selectedId) return;
    if (!res.ok) throw new Error(data.error || '读取失败');
    const items = data.observations || [];
    target.innerHTML = items.length ? items.map(item => {
      const snapshot = item.snapshot || {};
      const facts = [
        snapshot.git?.dirtyFiles != null ? `未提交 ${snapshot.git.dirtyFiles}` : null,
        snapshot.codex?.sessionCount != null ? `Codex ${snapshot.codex.sessionCount}` : null,
        snapshot.declaredProgress != null ? `目标 ${snapshot.declaredProgress}%` : null
      ].filter(Boolean).join(' · ');
      return `<div class="observation-item"><strong>${escapeHtml((item.changes || []).join('、') || '状态变化')}</strong><small>${compactDate(item.observedAt, true)}${facts ? ` · ${escapeHtml(facts)}` : ''}</small></div>`;
    }).join('') : '<div class="muted">这是第一次观察；后续项目事实发生变化时会自动追加记录。</div>';
  } catch (error) {
    if (token === detailRequestToken) target.innerHTML = `<div class="muted">观察历史读取失败：${escapeHtml(error.message)}</div>`;
  }
}

function showSelectedProject() {
  const p = currentData?.projects.find(x => x.id === selectedId);
  renderProjects(currentData);
  renderDetail(p);
  if (p) {
    const token = ++detailRequestToken;
    loadObservationHistory(p, token);
  }
}

function selectProject(id) {
  selectedId = id;
  showSelectedProject();
}

async function scan({ preserveInput = true } = {}) {
  scanBtn.disabled = true;
  scanMessage.textContent = '正在扫描项目、Git 与 Codex 会话…';
  try {
    const root = rootInput.value.trim();
    const params = new URLSearchParams({ depth: depthSelect.value });
    if (root) params.set('root', root);
    const res = await fetch(`/api/projects?${params}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '扫描失败');
    currentData = data;
    if (!preserveInput || !rootInput.value.trim()) rootInput.value = data.root;
    if (!selectedId || !data.projects.some(p => p.id === selectedId)) {
      selectedId = data.projects.find(p => p.path === data.selfPath)?.id || data.projects[0]?.id || null;
    }
    renderMetrics(data);
    showSelectedProject();
    scanMeta.textContent = `${data.projects.length} 个项目 · ${new Date(data.scannedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`;
    const codex = data.agentSources?.codex;
    scanMessage.textContent = codex?.available
      ? `扫描完成 · Codex 解析 ${codex.parsedSessions || 0} 个 · 归属当前扫描项目 ${codex.matchedSessions || 0} 个 · 未归属 ${codex.unmatchedSessions || 0} 个`
      : '扫描完成 · 未发现 Codex 本地会话目录';
  } catch (error) {
    scanMessage.textContent = error.message;
  } finally {
    scanBtn.disabled = false;
  }
}

scanBtn.addEventListener('click', () => scan());
rootInput.addEventListener('keydown', e => { if (e.key === 'Enter') scan(); });
scan({ preserveInput: false });
