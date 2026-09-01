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

const statusLabels = {
  active: '开发中',
  paused: '已暂停',
  completed: '已完成',
  abandoned: '已停止',
  done: '已完成',
  planned: '待开发',
  in_progress: '进行中',
  blocked: '受阻',
  working_tree_changed: '存在本地改动',
  unknown: '状态未声明'
};

const sourceLabels = {
  explicit: '显式目标',
  document_checklist: '文档清单'
};

function statusLabel(value) {
  return statusLabels[value] || value || '未知';
}

function escapeHtml(value = '') {
  return String(value).replace(/[&<>'"]/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' }[c]));
}

function compactDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit' }).format(d);
}

function renderMetrics(data) {
  const projects = data.projects || [];
  const active = projects.filter(p => p.status === 'active' || p.status === 'working_tree_changed').length;
  const dirty = projects.filter(p => p.git?.dirtyFiles > 0).length;
  const recovered = projects.filter(p => (p.recovery?.sources || []).length >= 2).length;
  metrics.innerHTML = [
    ['项目', projects.length],
    ['近期有开发迹象', active],
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
    btn.innerHTML = `
      <div class="card-top">
        <p class="project-name">${escapeHtml(p.name)}</p>
        <span class="status">${escapeHtml(statusLabel(p.status))}</span>
      </div>
      <div class="stage">${escapeHtml(p.stage || '尚未恢复当前阶段')}</div>
      <div class="card-meta">
        <div><strong>${p.declaredProgress ?? '—'}${p.declaredProgress == null ? '' : '%'}</strong><span>${escapeHtml(progressLabel(p))}</span></div>
        <div><strong>${p.recovery?.coverage || '基础'}</strong><span>信息覆盖</span></div>
      </div>
      ${isSelf ? '<span class="self-tag">● 当前工具自身</span>' : ''}
    `;
    btn.addEventListener('click', () => selectProject(p.id));
    projectGrid.appendChild(btn);
  }
}

function sourceChips(p) {
  const sources = p.recovery?.sources || [];
  if (!sources.length) return '<span class="muted">暂无可用来源</span>';
  return sources.map(source => `<span class="status">${escapeHtml(source.label)}</span>`).join('');
}

function renderRecoveredDocuments(p) {
  const documents = p.recovery?.documents || [];
  if (!documents.length) return '<div class="muted">没有发现 README / docs / PLAN / TODO 等项目文档。</div>';
  return `<div class="commit-list">${documents.slice(0, 8).map(doc => {
    const checklist = doc.checklistItems
      ? ` · 清单 ${doc.completedChecklistItems}/${doc.checklistItems}`
      : '';
    return `<div class="commit"><code>${escapeHtml(doc.path)}</code><div>${escapeHtml(doc.title)}<small>${escapeHtml(checklist || '已读取项目文档')}</small></div></div>`;
  }).join('')}</div>`;
}

function renderDetail(p) {
  if (!p) return;
  const goals = p.goals || [];
  const commits = p.git?.recentCommits || [];
  const unresolved = p.recovery?.unresolvedItems || [];
  const progressSource = sourceLabels[p.progressSource] || null;

  detailPanel.innerHTML = `
    <p class="eyebrow">项目详情</p>
    <h2 class="detail-title">${escapeHtml(p.name)}</h2>
    <div class="path">${escapeHtml(p.path)}</div>
    <p class="detail-summary">${escapeHtml(p.summary || '当前没有可恢复的项目摘要。')}</p>
    ${p.summarySource ? `<div class="muted">摘要来源：${escapeHtml(p.summarySource)}</div>` : ''}

    <div class="detail-section">
      <div class="card-top"><strong>${escapeHtml(p.stage || '阶段尚未恢复')}</strong><span class="status">${escapeHtml(statusLabel(p.status))}</span></div>
      ${p.declaredProgress == null ? '' : `<div class="progressbar" aria-label="目标进度 ${p.declaredProgress}%"><span style="width:${p.declaredProgress}%"></span></div>`}
      ${progressSource ? `<div class="muted" style="margin-top:8px">${escapeHtml(progressSource)}进度：${p.declaredProgress}%</div>` : ''}
      <div class="muted" style="margin-top:6px">最近提交：${escapeHtml(p.git?.latestCommit?.subject || '无')} · ${compactDate(p.git?.latestCommit?.date)}</div>
    </div>

    <div class="detail-section">
      <div class="section-heading"><p class="eyebrow">状态恢复</p><span class="status">信息覆盖：${escapeHtml(p.recovery?.coverage || '基础')}</span></div>
      <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:10px">${sourceChips(p)}</div>
      <div style="margin-top:12px">${renderRecoveredDocuments(p)}</div>
      <div class="muted" style="margin-top:10px">当前只恢复可直接验证的信息，不自动臆测开发阶段和后续方向。</div>
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

    <div class="detail-section">
      <p class="eyebrow">近期 Git 开发记录</p>
      <div class="commit-list">
        ${commits.length ? commits.slice(0,6).map(c => `<div class="commit"><code>${escapeHtml(c.shortHash)}</code><div>${escapeHtml(c.subject)}<small>${compactDate(c.date)}</small></div></div>`).join('') : '<div class="muted">没有可读取的 Git 历史。</div>'}
      </div>
    </div>
  `;
}

function selectProject(id) {
  selectedId = id;
  const p = currentData?.projects.find(x => x.id === id);
  renderProjects(currentData);
  renderDetail(p);
}

async function scan({ preserveInput = true } = {}) {
  scanBtn.disabled = true;
  scanMessage.textContent = '正在扫描…';
  try {
    const root = rootInput.value.trim();
    const params = new URLSearchParams({ depth: depthSelect.value });
    if (root) params.set('root', root);
    const res = await fetch(`/api/projects?${params}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '扫描失败');
    currentData = data;
    if (!preserveInput || !rootInput.value.trim()) rootInput.value = data.root;
    if (!selectedId || !data.projects.some(p => p.id === selectedId)) selectedId = data.projects.find(p => p.path === data.selfPath)?.id || data.projects[0]?.id || null;
    renderMetrics(data);
    renderProjects(data);
    renderDetail(data.projects.find(p => p.id === selectedId));
    scanMeta.textContent = `${data.projects.length} 个项目 · ${new Date(data.scannedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`;
    scanMessage.textContent = '扫描完成';
  } catch (error) {
    scanMessage.textContent = error.message;
  } finally {
    scanBtn.disabled = false;
  }
}

scanBtn.addEventListener('click', () => scan());
rootInput.addEventListener('keydown', e => { if (e.key === 'Enter') scan(); });
scan({ preserveInput: false });
