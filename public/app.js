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
  blocked: '受阻'
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
  const active = projects.filter(p => p.status === 'active').length;
  const dirty = projects.filter(p => p.git?.dirtyFiles > 0).length;
  const explicit = projects.filter(p => p.stateSource).length;
  metrics.innerHTML = [
    ['项目', projects.length],
    ['开发中', active],
    ['有未提交改动', dirty],
    ['有显式状态文件', explicit]
  ].map(([label, value]) => `<div class="metric"><strong>${value}</strong><span>${label}</span></div>`).join('');
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
        <div><strong>${p.declaredProgress ?? '—'}${p.declaredProgress == null ? '' : '%'}</strong><span>声明目标进度</span></div>
        <div><strong>${p.git?.dirtyFiles ?? 0}</strong><span>未提交文件</span></div>
      </div>
      ${isSelf ? '<span class="self-tag">● 当前工具自身</span>' : ''}
    `;
    btn.addEventListener('click', () => selectProject(p.id));
    projectGrid.appendChild(btn);
  }
}

function renderDetail(p) {
  if (!p) return;
  const goals = p.goals || [];
  const commits = p.git?.recentCommits || [];
  detailPanel.innerHTML = `
    <p class="eyebrow">项目详情</p>
    <h2 class="detail-title">${escapeHtml(p.name)}</h2>
    <div class="path">${escapeHtml(p.path)}</div>
    <p class="detail-summary">${escapeHtml(p.summary || '当前没有显式项目摘要；后续版本会从文档与历史中恢复。')}</p>

    <div class="detail-section">
      <div class="card-top"><strong>${escapeHtml(p.stage || '阶段未知')}</strong><span class="status">${escapeHtml(statusLabel(p.status))}</span></div>
      ${p.declaredProgress == null ? '' : `<div class="progressbar" aria-label="目标进度 ${p.declaredProgress}%"><span style="width:${p.declaredProgress}%"></span></div>`}
      <div class="muted" style="margin-top:8px">最近提交：${escapeHtml(p.git?.latestCommit?.subject || '无')} · ${compactDate(p.git?.latestCommit?.date)}</div>
    </div>

    <div class="detail-section">
      <p class="eyebrow">当前目标</p>
      <div class="goal-list">
        ${goals.length ? goals.map(g => `<div class="goal"><span class="goal-bullet ${escapeHtml(g.status)}"></span><div>${escapeHtml(g.title)}<small>${escapeHtml(statusLabel(g.status))}</small></div></div>`).join('') : '<div class="muted">没有显式目标。</div>'}
      </div>
    </div>

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
