const $ = s => document.querySelector(s);

const rootInput = $('#rootInput');
const depthSelect = $('#depthSelect');
const scanBtn = $('#scanBtn');
const projectGrid = $('#projectGrid');
const metrics = $('#metrics');
const scanMeta = $('#scanMeta');
const scanMessage = $('#scanMessage');
const homeView = $('#homeView');
const projectView = $('#projectView');
const toolbar = $('#toolbar');
const homeHero = $('#homeHero');

let currentData = null;
let observationToken = 0;

const statusLabels = {
  active: '开发中', paused: '已暂停', completed: '已完成', abandoned: '已停止', done: '已完成',
  planned: '待处理', in_progress: '进行中', blocked: '受阻', working_tree_changed: '存在本地改动', unknown: '状态未声明'
};

function esc(v = '') { return String(v).replace(/[&<>'"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;' }[c])); }
function label(v) { return statusLabels[v] || v || '未知'; }
function date(iso, withTime = false) {
  if (!iso) return '—';
  const d = new Date(iso); if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat('zh-CN', withTime ? { month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit' } : { month:'2-digit',day:'2-digit' }).format(d);
}
function short(text, n = 120) { const s = String(text || '').replace(/\s+/g, ' ').trim(); return s.length > n ? `${s.slice(0,n-1)}…` : s; }
function route() { const raw = location.hash.replace(/^#/, ''); const params = new URLSearchParams(raw); return { project: params.get('project'), tab: params.get('tab') || 'overview' }; }
function setRoute(project, tab = 'overview') { location.hash = `project=${encodeURIComponent(project)}&tab=${encodeURIComponent(tab)}`; }
function openGoals(p) { return (p.goals || []).filter(g => !['done','completed'].includes(g.status)); }
function completedGoals(p) { return (p.goals || []).filter(g => ['done','completed'].includes(g.status)); }

function syncText(p) {
  const s = p.git?.sync; const dirty = p.git?.dirtyFiles || 0; const tail = dirty ? `还有 ${dirty} 个未提交文件` : '工作区干净';
  if (!s?.upstream) return tail;
  if (s.inSync) return `${p.git?.branch || '当前分支'} 与 ${s.upstream} 一致，${tail}`;
  return `${p.git?.branch || '当前分支'} 相对 ${s.upstream}：领先 ${s.ahead ?? '?'}、落后 ${s.behind ?? '?'}，${tail}`;
}

function groupGit(commits = []) {
  const sorted = [...commits].filter(c => c.date).sort((a,b) => String(b.date).localeCompare(String(a.date)));
  const groups = []; const gap = 15 * 60 * 1000;
  for (const commit of sorted) {
    const time = new Date(commit.date).getTime(); const current = groups.at(-1);
    if (current && Number.isFinite(time) && current.oldest - time >= 0 && current.oldest - time <= gap) { current.commits.push(commit); current.oldest = time; }
    else groups.push({ date:commit.date, commits:[commit], oldest:time });
  }
  return groups;
}

function codexHeadline(session) {
  const event = session.developmentEvent;
  if (event?.result && !event.result.includes('没有恢复到明确')) return short(event.result, 100);
  if (event?.request) return short(event.request, 100);
  return short(session.title || 'Codex 开发会话', 100);
}

function technicalEvents(p) {
  const git = groupGit(p.git?.recentCommits || []).map(group => ({ kind:'git', date:group.date, group }));
  const codex = (p.agentSessions?.codex?.sessions || []).map(session => ({ kind:'codex', date:session.lastActivity || session.startedAt, session }));
  return [...git,...codex].filter(item => item.date).sort((a,b) => String(b.date).localeCompare(String(a.date)));
}

function renderMetrics() {
  const projects = currentData?.projects || [];
  const active = projects.filter(p => ['active','working_tree_changed'].includes(p.status)).length;
  const quiet = projects.filter(p => { const t = p.insight?.latestActivityAt ? new Date(p.insight.latestActivityAt).getTime() : null; return t && Date.now() - t > 30 * 86400000; }).length;
  const dirty = projects.filter(p => p.git?.dirtyFiles > 0).length;
  metrics.innerHTML = [['项目',projects.length],['近期开发中',active],['30 天无开发',quiet],['有未提交改动',dirty]].map(([name,value]) => `<div class="metric"><strong>${value}</strong><span>${name}</span></div>`).join('');
}

function renderHome() {
  homeView.hidden = false; projectView.hidden = true; toolbar.hidden = false; homeHero.hidden = false; metrics.hidden = false; projectGrid.innerHTML = '';
  for (const p of currentData?.projects || []) {
    const insight = p.insight || {}; const themes = insight.recentThemes || []; const limitations = insight.limitations || [];
    const card = document.createElement('button'); card.className = 'project-card project-card-v6'; card.type = 'button';
    card.innerHTML = `
      <div class="card-top"><div><p class="project-name">${esc(p.name)}</p><div class="project-state-line">${esc(insight.stateLabel || '项目状态尚未恢复')}</div></div><span class="status">${esc(label(p.status))}</span></div>
      <p class="card-summary">${esc(short(p.summary || '暂无项目说明', 150))}</p>
      <div class="card-shape"><span>当前形态</span><strong>${esc(insight.shape || '尚未恢复')}</strong></div>
      <div class="theme-chips">${themes.slice(0,3).map(t => `<span>${esc(t.label)}</span>`).join('') || '<span>暂无近期开发主题</span>'}</div>
      <div class="card-footer"><span>${limitations.length ? `${limitations.length} 项已知限制` : '未发现明确限制'}</span><span>${p.git?.dirtyFiles ? `${p.git.dirtyFiles} 个未提交` : 'Git 已提交'}</span><span>${date(insight.latestActivityAt,false)}</span></div>
      ${p.path === currentData.selfPath ? '<span class="self-tag">● 当前工具自身</span>' : ''}`;
    card.addEventListener('click', () => setRoute(p.id)); projectGrid.appendChild(card);
  }
}

function projectHeader(p, tab) {
  const insight = p.insight || {};
  return `
    <button class="back-link" id="backBtn">← 返回项目总览</button>
    <div class="project-head panel project-head-v6">
      <div class="project-head-main"><p class="eyebrow">项目</p><h1 class="project-title">${esc(p.name)}</h1><p>${esc(p.summary || '暂无项目摘要')}</p><small>${esc(p.path)}</small></div>
      <div class="project-head-state"><span class="status">${esc(label(p.status))}</span><strong>${esc(insight.stateLabel || '项目状态尚未恢复')}</strong><span>${insight.shape ? esc(insight.shape) : '当前形态尚未恢复'}</span><small>最近活动 ${esc(date(insight.latestActivityAt,false))}</small></div>
    </div>
    <nav class="tabs">${[['overview','概览'],['development','开发演进'],['planning','限制与计划'],['evidence','证据与记录']].map(([key,name]) => `<button class="tab ${tab===key?'active':''}" data-tab="${key}">${name}</button>`).join('')}</nav>`;
}

function listItems(items, emptyText) {
  if (!items?.length) return `<p class="muted empty-state">${esc(emptyText)}</p>`;
  return `<ul class="human-list">${items.map(item => `<li>${esc(item)}</li>`).join('')}</ul>`;
}

function renderOverview(p) {
  const i = p.insight || {}; const themes = i.recentThemes || []; const capabilities = i.capabilities || []; const limits = i.limitations || []; const forms = i.deliveryForms || []; const goals = openGoals(p);
  return `<div class="overview-grid-v6">
    <section class="panel section-card hero-state span-2"><p class="eyebrow">项目现状</p><h2>${esc(i.stateLabel || '尚未恢复项目状态')}</h2><p>${esc(i.shape || '当前运行/交付形态尚未从文档恢复。')}</p><div class="evidence-line">${(i.sourceSummary || []).map(x => `<span>${esc(x)}</span>`).join('')}</div></section>
    <section class="panel section-card"><div class="section-heading"><div><p class="eyebrow">已经具备</p><h2>现在能做什么</h2></div><strong class="count-badge">${capabilities.length}</strong></div>${listItems(capabilities.slice(0,8),'README 里没有找到明确的功能/能力清单。')}</section>
    <section class="panel section-card"><div class="section-heading"><div><p class="eyebrow">当前限制</p><h2>还做不到什么</h2></div><strong class="count-badge">${limits.length}</strong></div>${listItems(limits.slice(0,6),'没有从项目文档恢复到明确限制；这不等于项目没有问题。')}</section>
    <section class="panel section-card span-2"><div class="section-heading"><div><p class="eyebrow">近期开发</p><h2>最近在完善什么</h2></div><button class="text-action" data-tab="development">查看开发演进</button></div><div class="theme-grid">${themes.length ? themes.slice(0,6).map(theme => `<div class="theme-card"><strong>${esc(theme.label)}</strong><span>${theme.count} 次相关提交 · 最近 ${esc(date(theme.latestAt,false))}</span><small>${esc(theme.kind || '开发活动')}</small></div>`).join('') : '<p class="muted">还没有恢复到明显的开发主题。</p>'}</div></section>
    <section class="panel section-card"><p class="eyebrow">交付 / 运行形态</p><div class="delivery-list">${forms.length ? forms.map(form => `<div class="delivery-item"><strong>${esc(form.name)}</strong>${form.detail ? `<p>${esc(form.detail)}</p>` : ''}</div>`).join('') : '<p class="muted">没有从 README 恢复到明确的部署或交付形态。</p>'}</div></section>
    <section class="panel section-card"><p class="eyebrow">需要关注</p>${goals.length ? listItems(goals.slice(0,5).map(g => `${label(g.status)}：${g.title}`),'暂无明确计划') : '<p class="muted">项目没有显式待办清单。已知限制不自动等同于下一步工作。</p>'}${p.git?.dirtyFiles ? `<div class="attention">本地还有 ${p.git.dirtyFiles} 个未提交文件。</div>` : ''}</section>
    <details class="panel collapsible span-2"><summary>技术状态 <span>需要时再看</span></summary><div class="collapse-body tech-grid"><div><span>Git</span><strong>${esc(syncText(p))}</strong></div><div><span>AI 会话</span><strong>${p.agentSessions?.codex?.sessionCount || 0} 个已归属</strong></div><div><span>显式阶段</span><strong>${esc(p.stage || '未声明')}</strong></div><div><span>显式目标进度</span><strong>${i.reliableProgress == null ? '不显示' : `${i.reliableProgress}%`}</strong></div></div></details>
  </div>`;
}

function renderDevelopment(p) {
  const themes = p.insight?.recentThemes || []; const events = technicalEvents(p);
  return `<div class="development-page">
    <section class="panel page-section"><p class="eyebrow">开发主题</p><h2>先看项目最近往哪些方向变化</h2><div class="theme-grid large">${themes.length ? themes.map(theme => `<div class="theme-card"><strong>${esc(theme.label)}</strong><span>${theme.count} 次相关提交 · 最近 ${esc(date(theme.latestAt,false))}</span><small>${esc(theme.kind || '开发活动')}</small>${theme.samples?.length ? `<details class="nested"><summary>查看原始提交概括</summary><ul>${theme.samples.map(s => `<li>${esc(s)}</li>`).join('')}</ul></details>` : ''}</div>`).join('') : '<p class="muted">没有足够 Git 历史来形成开发主题。</p>'}</div></section>
    <section class="panel page-section"><div class="section-heading"><div><p class="eyebrow">原始开发记录</p><h2>需要追溯时再展开</h2></div><span class="muted">Git / Codex 作为证据层</span></div><div class="event-list">${events.length ? events.map(event => event.kind==='git' ? renderGitEvent(event,p) : renderCodexEvent(event.session)).join('') : '<p class="muted">暂无开发记录。</p>'}</div></section>
  </div>`;
}

function renderGitEvent(event,p) {
  return `<details class="event-card"><summary><span class="event-kind">Git</span><div><strong>${event.group.commits.length} 次提交 · ${esc(date(event.date,true))}</strong><small>${esc(event.group.commits[0]?.subject || '开发批次')}</small></div></summary><div class="event-body"><div class="fact-block"><span>当前仓库</span><p>${esc(syncText(p))}</p></div><ul class="commit-evidence">${event.group.commits.map(c => `<li><code>${esc(c.shortHash)}</code> ${esc(c.subject || '')}</li>`).join('')}</ul></div></details>`;
}

function renderCodexEvent(session) {
  const event = session.developmentEvent; const verification = event?.verification || [];
  return `<details class="event-card"><summary><span class="event-kind ai">AI</span><div><strong>${esc(codexHeadline(session))}</strong><small>${esc(date(session.lastActivity || session.startedAt,true))} · ${esc(session.match?.reason || '归属方式未知')}</small></div></summary><div class="event-body">${event?.result ? `<div class="fact-block"><span>最终说明</span><p>${esc(event.result)}</p></div>` : ''}${verification.length ? `<div class="fact-block"><span>验证语句</span><ul>${verification.map(v=>`<li>${esc(v)}</li>`).join('')}</ul></div>` : ''}${event?.request ? `<details class="nested"><summary>原始需求</summary><p>${esc(event.request)}</p></details>` : ''}<div class="event-meta">${event?.toolCalls || 0} 次工具调用 · ${event?.userTurns || session.userTurns || 0} 次有效用户输入</div>${session.match?.confidence === 'medium' ? `<button class="small-action bind-session" data-session="${esc(session.id)}">确认该会话属于本项目</button>` : ''}</div></details>`;
}

function goalRow(goal) { return `<div class="goal-row"><span class="goal-dot ${esc(goal.status)}"></span><div><strong>${esc(goal.title)}</strong><small>${esc(label(goal.status))}</small></div></div>`; }

function renderPlanning(p) {
  const limitations = p.insight?.limitations || []; const pending = openGoals(p); const done = completedGoals(p);
  return `<div class="planning-grid">
    <section class="panel page-section"><p class="eyebrow">已知限制</p><h2>项目明确承认的边界</h2>${listItems(limitations,'当前文档没有明确列出限制。')}</section>
    <section class="panel page-section"><p class="eyebrow">明确计划</p><h2>只显示项目自己声明过的事项</h2>${pending.length ? `<div class="goal-group">${pending.map(goalRow).join('')}</div>` : '<p class="muted">没有显式未完成清单，不自动生成“下一步工作”。</p>'}${done.length ? `<details class="completed-goals"><summary>已完成 ${done.length} 项</summary><div class="goal-group done-list">${done.map(goalRow).join('')}</div></details>` : ''}</section>
  </div>`;
}

function renderEvidence(p) {
  const docs = p.recovery?.documents || []; const sources = p.recovery?.sources || []; const unmatched = currentData?.agentSources?.codex?.unmatchedSamples || [];
  return `<div class="evidence-grid">
    <section class="panel page-section"><p class="eyebrow">项目身份与仓库</p><div class="evidence-summary"><div><span>Git</span><strong>${esc(syncText(p))}</strong></div><div><span>Remote</span><strong>${esc(p.git?.originUrl || '未配置')}</strong></div><div><span>Codex</span><strong>${p.agentSessions?.codex?.sessionCount || 0} 个已归属会话</strong></div><div><span>信息来源</span><strong>${sources.length} 类</strong></div></div></section>
    <section class="panel page-section"><p class="eyebrow">观察历史</p><h2>项目事实发生过哪些变化</h2><div id="observationHistory"><p class="muted">正在读取…</p></div></section>
    <details class="panel collapsible"><summary>项目文档 <span>${docs.length} 份</span></summary><div class="collapse-body">${docs.map(d => `<div class="document-row"><code>${esc(d.path)}</code><span>${esc(d.title)}</span></div>`).join('') || '<p class="muted">没有项目文档。</p>'}</div></details>
    <details class="panel collapsible"><summary>Codex 归属诊断 <span>${unmatched.length} 个未归属示例</span></summary><div class="collapse-body">${unmatched.map(x => `<div class="diagnostic-row"><div><strong>${esc(x.projectPath || x.codexProjectName || x.id)}</strong><small>${esc(x.reason || '未匹配')}</small></div><button class="small-action bind-unmatched" data-session="${esc(x.id)}">绑定到本项目</button></div>`).join('') || '<p class="muted">当前没有未归属会话示例。</p>'}</div></details>
  </div>`;
}

async function loadObservations(p) {
  const target = $('#observationHistory'); if (!target) return; const token = ++observationToken;
  try {
    const q = new URLSearchParams({ project:p.path, limit:'12' }); if (p.identity?.key) q.set('key',p.identity.key);
    const response = await fetch(`/api/observations?${q}`); const data = await response.json(); if (token !== observationToken) return;
    const items = data.observations || [];
    target.innerHTML = items.length ? `<div class="observation-list">${items.map(item => `<div class="observation-row"><strong>${esc((item.changes || []).join('、') || '状态变化')}</strong><small>${esc(date(item.observedAt,true))} · Codex ${item.snapshot?.codex?.sessionCount ?? '—'} · 显式目标 ${item.snapshot?.declaredProgress ?? '—'}%</small></div>`).join('')}</div>` : '<p class="muted">暂无历史变化。</p>';
  } catch (error) { target.innerHTML = `<p class="muted">观察历史读取失败：${esc(error.message)}</p>`; }
}

function renderProject(p,tab) {
  homeView.hidden = true; projectView.hidden = false; toolbar.hidden = true; homeHero.hidden = true; metrics.hidden = true;
  const body = tab === 'development' ? renderDevelopment(p) : tab === 'planning' ? renderPlanning(p) : tab === 'evidence' ? renderEvidence(p) : renderOverview(p);
  projectView.innerHTML = `${projectHeader(p,tab)}<div class="project-page-body">${body}</div>`;
  $('#backBtn')?.addEventListener('click', () => { location.hash = ''; });
  projectView.querySelectorAll('[data-tab]').forEach(button => button.addEventListener('click', () => setRoute(p.id,button.dataset.tab)));
  projectView.querySelectorAll('.bind-session,.bind-unmatched').forEach(button => button.addEventListener('click', () => bindSession(button.dataset.session,p)));
  if (tab === 'evidence') loadObservations(p);
}

async function bindSession(sessionId,p) {
  if (!sessionId) return;
  try {
    const response = await fetch('/api/session-bindings',{ method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({ sessionId, projectKey:p.identity?.key, projectPath:p.path, projectName:p.name }) });
    const data = await response.json(); if (!response.ok) throw new Error(data.error || '绑定失败'); await scan(true);
  } catch (error) { alert(`绑定失败：${error.message}`); }
}

function renderRoute() {
  if (!currentData) return; const current = route(); if (!current.project) return renderHome();
  const project = currentData.projects.find(item => item.id === current.project); if (!project) { location.hash = ''; return; }
  renderProject(project,current.tab);
}

async function scan(preserve = false) {
  scanBtn.disabled = true; scanMessage.textContent = '正在恢复项目说明、能力、限制、Git 与 AI 开发记录…';
  try {
    const q = new URLSearchParams({ depth:depthSelect.value }); const root = rootInput.value.trim(); if (root) q.set('root',root);
    const response = await fetch(`/api/projects?${q}`); const data = await response.json(); if (!response.ok) throw new Error(data.error || '扫描失败');
    currentData = data; if (!preserve || !rootInput.value.trim()) rootInput.value = data.root; renderMetrics(); renderRoute();
    scanMeta.textContent = `${data.projects.length} 个项目 · ${new Date(data.scannedAt).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'})}`;
    const codex = data.agentSources?.codex; scanMessage.textContent = codex?.available ? `扫描完成 · Codex ${codex.parsedSessions || 0} 个 · 已归属 ${codex.matchedSessions || 0} 个` : '扫描完成 · 未发现 Codex 数据源';
  } catch (error) { scanMessage.textContent = error.message; }
  finally { scanBtn.disabled = false; }
}

window.addEventListener('hashchange',renderRoute);
scanBtn.addEventListener('click',() => scan(true));
rootInput.addEventListener('keydown',event => { if (event.key === 'Enter') scan(true); });
scan(false);
