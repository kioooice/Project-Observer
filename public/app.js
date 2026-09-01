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
  active: '开发中', paused: '已暂停', completed: '已完成', abandoned: '已停止',
  done: '已完成', planned: '待处理', in_progress: '进行中', blocked: '受阻',
  working_tree_changed: '存在本地改动', unknown: '状态未声明'
};

function esc(v = '') { return String(v).replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c])); }
function label(v) { return statusLabels[v] || v || '未知'; }
function date(iso, time = false) {
  if (!iso) return '—';
  const d = new Date(iso); if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat('zh-CN', time ? {month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'} : {month:'2-digit',day:'2-digit'}).format(d);
}
function short(text, n = 120) { const s = String(text || '').replace(/\s+/g,' ').trim(); return s.length > n ? `${s.slice(0,n-1)}…` : s; }
function route() {
  const raw = location.hash.replace(/^#/, '');
  const params = new URLSearchParams(raw);
  return { project: params.get('project'), tab: params.get('tab') || 'overview' };
}
function setRoute(project, tab = 'overview') { location.hash = `project=${encodeURIComponent(project)}&tab=${encodeURIComponent(tab)}`; }

function progressText(p) { return p.declaredProgress == null ? '未计算' : `${p.declaredProgress}%`; }
function pendingGoals(p) { return (p.goals || []).filter(g => !['done','completed'].includes(g.status)); }
function completedGoals(p) { return (p.goals || []).filter(g => ['done','completed'].includes(g.status)); }

function groupGit(commits = []) {
  const sorted = [...commits].filter(c => c.date).sort((a,b) => String(b.date).localeCompare(String(a.date)));
  const groups = []; const gap = 12 * 60 * 1000;
  for (const c of sorted) {
    const t = new Date(c.date).getTime(); const g = groups.at(-1);
    if (g && Number.isFinite(t) && g.oldest - t >= 0 && g.oldest - t <= gap) { g.commits.push(c); g.oldest = t; }
    else groups.push({date:c.date, commits:[c], oldest:t});
  }
  return groups;
}
function moduleName(file = '') {
  const n = file.replaceAll('\\','/'); const b = n.split('/').pop()?.toLowerCase();
  const map = {'codex.mjs':'Codex 会话','codex-state.mjs':'Codex 状态库','identity.mjs':'项目身份','session-bindings.mjs':'会话绑定','observations.mjs':'观察历史','git-context.mjs':'Git 状态','scanner.mjs':'项目扫描','server.mjs':'服务端','app.js':'界面逻辑','styles.css':'界面样式','index.html':'页面结构','.project-state.json':'项目状态','package.json':'版本配置'};
  return map[b] || (n.startsWith('docs/') ? '项目文档' : b || n);
}
function gitBatchSummary(group, p) {
  const changes = new Map();
  for (const c of [...group.commits].reverse()) for (const x of c.changes || []) if (x.path) changes.set(x.path,x);
  const files = [...changes.values()]; const mods = [...new Set(files.map(x => moduleName(x.path)))].slice(0,5);
  const add = files.filter(x => x.status === 'A').length; const del = files.filter(x => x.status === 'D').length;
  const parts = [];
  if (mods.length) parts.push(`调整${mods.join('、')}`); else parts.push(`完成 ${group.commits.length} 次提交`);
  if (add) parts.push(`新增 ${add} 个文件`); if (del) parts.push(`删除 ${del} 个文件`);
  return `${parts.join('，')}。${files.length ? ` 共涉及 ${files.length} 个文件。` : ''}`;
}
function syncText(p) {
  const s = p.git?.sync; const dirty = p.git?.dirtyFiles || 0;
  const tail = dirty ? `还有 ${dirty} 个未提交文件` : '工作区干净';
  if (!s?.upstream) return tail;
  if (s.inSync) return `${p.git?.branch || '当前分支'} 与 ${s.upstream} 一致，${tail}`;
  return `${p.git?.branch || '当前分支'} 相对 ${s.upstream}：领先 ${s.ahead ?? '?'}、落后 ${s.behind ?? '?'}，${tail}`;
}

function codexHeadline(s) {
  const e = s.developmentEvent;
  if (e?.result && !e.result.includes('没有恢复到明确')) return short(e.result, 130);
  if (e?.request) return short(e.request, 130);
  return short(s.title || 'Codex 开发会话', 130);
}
function developmentEvents(p) {
  const git = groupGit(p.git?.recentCommits || []).map(g => ({kind:'git', date:g.date, group:g, title:gitBatchSummary(g,p)}));
  const codex = (p.agentSessions?.codex?.sessions || []).map(s => ({kind:'codex', date:s.lastActivity || s.startedAt, session:s, title:codexHeadline(s)}));
  return [...git,...codex].filter(x=>x.date).sort((a,b)=>String(b.date).localeCompare(String(a.date)));
}

function renderMetrics() {
  const ps = currentData?.projects || [];
  const active = ps.filter(p => ['active','working_tree_changed'].includes(p.status)).length;
  const sessions = ps.reduce((n,p)=>n+(p.agentSessions?.codex?.sessionCount||0),0);
  const dirty = ps.filter(p => p.git?.dirtyFiles > 0).length;
  metrics.innerHTML = [['项目',ps.length],['开发中',active],['Codex 会话',sessions],['有未提交改动',dirty]].map(([a,b])=>`<div class="metric"><strong>${b}</strong><span>${a}</span></div>`).join('');
}

function renderHome() {
  homeView.hidden = false; projectView.hidden = true; toolbar.hidden = false; homeHero.hidden = false; metrics.hidden = false;
  projectGrid.innerHTML = '';
  for (const p of currentData?.projects || []) {
    const latest = developmentEvents(p)[0]; const pending = pendingGoals(p).length;
    const card = document.createElement('button'); card.className = 'project-card'; card.type = 'button';
    card.innerHTML = `
      <div class="card-top"><div><p class="project-name">${esc(p.name)}</p><div class="stage">${esc(p.stage || '阶段尚未恢复')}</div></div><span class="status">${esc(label(p.status))}</span></div>
      <div class="progress-row"><div class="progressbar"><span style="width:${p.declaredProgress ?? 0}%"></span></div><strong>${esc(progressText(p))}</strong></div>
      <div class="card-meta compact"><div><strong>${p.agentSessions?.codex?.sessionCount || 0}</strong><span>AI 会话</span></div><div><strong>${pending}</strong><span>未完成</span></div><div><strong>${p.git?.dirtyFiles || 0}</strong><span>未提交</span></div></div>
      <div class="card-latest"><span>最近</span><b>${esc(latest ? short(latest.title,90) : '暂无开发记录')}</b><small>${esc(date(latest?.date,true))}</small></div>
      ${p.path === currentData.selfPath ? '<span class="self-tag">● 当前工具自身</span>' : ''}
    `;
    card.addEventListener('click', () => setRoute(p.id)); projectGrid.appendChild(card);
  }
}

function projectHeader(p, tab) {
  const pending = pendingGoals(p);
  return `
    <button class="back-link" id="backBtn">← 返回项目总览</button>
    <div class="project-head panel">
      <div class="project-head-main"><p class="eyebrow">项目</p><h1 class="project-title">${esc(p.name)}</h1><p>${esc(p.summary || '暂无项目摘要')}</p><small>${esc(p.path)}</small></div>
      <div class="project-state"><span class="status">${esc(label(p.status))}</span><strong>${esc(p.stage || '阶段尚未恢复')}</strong><span>${pending.length} 项未完成</span></div>
    </div>
    <nav class="tabs">
      ${[['overview','概览'],['development','开发历程'],['evidence','状态与证据'],['goals','目标与计划']].map(([k,n])=>`<button class="tab ${tab===k?'active':''}" data-tab="${k}">${n}</button>`).join('')}
    </nav>`;
}

function renderOverview(p) {
  const events = developmentEvents(p); const latest = events[0]; const pending = pendingGoals(p); const codex = p.agentSessions?.codex?.sessionCount || 0;
  const inProgress = pending.filter(g=>g.status==='in_progress'); const blocked = pending.filter(g=>g.status==='blocked'); const planned = pending.filter(g=>g.status==='planned');
  return `
    <div class="overview-grid">
      <section class="panel section-card span-2"><p class="eyebrow">现在</p><div class="now-grid">
        <div><span>当前阶段</span><strong>${esc(p.stage || '尚未恢复')}</strong></div>
        <div><span>目标完成度</span><strong>${esc(progressText(p))}</strong></div>
        <div><span>AI 开发会话</span><strong>${codex}</strong></div>
        <div><span>Git 状态</span><strong>${p.git?.dirtyFiles ? `${p.git.dirtyFiles} 个未提交` : '已提交'}</strong></div>
      </div><div class="progressbar large"><span style="width:${p.declaredProgress ?? 0}%"></span></div></section>
      <section class="panel section-card"><p class="eyebrow">最近开发</p><h3>${esc(latest ? latest.title : '暂无开发记录')}</h3><p class="muted">${esc(latest ? `${date(latest.date,true)} · ${latest.kind === 'codex' ? 'Codex 会话' : 'Git 开发批次'}` : '')}</p></section>
      <section class="panel section-card"><p class="eyebrow">未完成事项</p><div class="mini-stats"><div><strong>${inProgress.length}</strong><span>进行中</span></div><div><strong>${planned.length}</strong><span>待处理</span></div><div><strong>${blocked.length}</strong><span>受阻</span></div></div>${pending[0] ? `<p class="muted">当前：${esc(pending[0].title)}</p>` : '<p class="muted">当前没有明确未完成事项。</p>'}</section>
      <section class="panel section-card span-2"><div class="section-heading"><div><p class="eyebrow">近期变化</p><h2>最近三轮开发</h2></div><button class="text-action" data-tab="development">查看全部</button></div><div class="preview-list">${events.slice(0,3).map(e=>`<div class="preview-row"><span class="event-kind">${e.kind==='codex'?'AI':'Git'}</span><div><strong>${esc(e.title)}</strong><small>${esc(date(e.date,true))}</small></div></div>`).join('') || '<p class="muted">暂无开发记录。</p>'}</div></section>
      <section class="panel section-card"><p class="eyebrow">仓库</p><h3>${esc(syncText(p))}</h3><p class="muted">${esc(p.git?.originUrl || '未配置 Git remote')}</p></section>
      <section class="panel section-card"><p class="eyebrow">信息覆盖</p><h3>${esc(p.recovery?.coverage || '基础')}</h3><p class="muted">${(p.recovery?.sources || []).length} 类项目来源 · ${p.recovery?.documents?.length || 0} 份文档</p></section>
    </div>`;
}

function renderCodexDetail(s) {
  const e = s.developmentEvent; const verification = e?.verification || [];
  return `<details class="event-card"><summary><span class="event-kind ai">AI</span><div><strong>${esc(codexHeadline(s))}</strong><small>${esc(date(s.lastActivity || s.startedAt,true))} · ${esc(s.match?.reason || '归属方式未知')}</small></div></summary><div class="event-body">
    ${e?.result ? `<div class="fact-block"><span>本轮结果</span><p>${esc(e.result)}</p></div>` : ''}
    ${verification.length ? `<div class="fact-block"><span>验证证据</span><ul>${verification.map(v=>`<li>${esc(v)}</li>`).join('')}</ul></div>` : '<div class="fact-block muted">没有恢复到明确验证语句。</div>'}
    ${e?.request ? `<details class="nested"><summary>查看原始需求</summary><p>${esc(e.request)}</p></details>` : ''}
    <div class="event-meta">${e?.toolCalls || 0} 次工具调用 · ${e?.userTurns || s.userTurns || 0} 次有效用户输入</div>
    ${s.match?.confidence === 'medium' ? `<button class="small-action bind-session" data-session="${esc(s.id)}">确认该会话属于本项目</button>` : ''}
  </div></details>`;
}
function renderGitDetail(e,p) {
  return `<details class="event-card"><summary><span class="event-kind">Git</span><div><strong>${esc(e.title)}</strong><small>${esc(date(e.date,true))} · ${e.group.commits.length} 次提交</small></div></summary><div class="event-body"><div class="fact-block"><span>仓库状态</span><p>${esc(syncText(p))}</p></div><details class="nested"><summary>查看提交证据</summary><ul>${e.group.commits.map(c=>`<li><code>${esc(c.shortHash)}</code> ${esc(c.subject || '')}</li>`).join('')}</ul></details></div></details>`;
}
function renderDevelopment(p) {
  const events = developmentEvents(p);
  return `<section class="panel page-section"><div class="section-heading"><div><p class="eyebrow">开发历程</p><h2>按“这一轮做成了什么”阅读</h2></div><span class="muted">Git 是证据，AI 会话是开发上下文</span></div><div class="event-list">${events.map(e=>e.kind==='codex'?renderCodexDetail(e.session):renderGitDetail(e,p)).join('') || '<p class="muted">暂无开发记录。</p>'}</div></section>`;
}

function renderEvidence(p) {
  const docs = p.recovery?.documents || []; const sources = p.recovery?.sources || []; const global = currentData?.agentSources?.codex; const unmatched = global?.unmatchedSamples || [];
  return `<div class="evidence-grid">
    <section class="panel page-section"><p class="eyebrow">当前证据</p><div class="evidence-summary"><div><span>Git</span><strong>${esc(syncText(p))}</strong></div><div><span>Codex</span><strong>${p.agentSessions?.codex?.sessionCount || 0} 个已归属会话</strong></div><div><span>状态来源</span><strong>${sources.length} 类来源</strong></div></div></section>
    <section class="panel page-section"><div class="section-heading"><div><p class="eyebrow">观察历史</p><h2>只有事实变化才记录</h2></div></div><div id="observationHistory"><p class="muted">正在读取…</p></div></section>
    <details class="panel collapsible"><summary>项目文档与信息来源 <span>${docs.length} 份文档</span></summary><div class="collapse-body"><div class="chip-row">${sources.map(s=>`<span class="chip">${esc(s.label)}</span>`).join('') || '<span class="muted">暂无来源</span>'}</div>${docs.map(d=>`<div class="document-row"><code>${esc(d.path)}</code><span>${esc(d.title)}</span></div>`).join('')}</div></details>
    <details class="panel collapsible"><summary>Codex 归属诊断 <span>${unmatched.length} 个未归属示例</span></summary><div class="collapse-body">${unmatched.map(x=>`<div class="diagnostic-row"><div><strong>${esc(x.projectPath || x.codexProjectName || x.id)}</strong><small>${esc(x.reason || '未匹配')}</small></div><button class="small-action bind-unmatched" data-session="${esc(x.id)}">绑定到本项目</button></div>`).join('') || '<p class="muted">当前没有未归属会话示例。</p>'}</div></details>
  </div>`;
}

function goalRow(g) { return `<div class="goal-row"><span class="goal-dot ${esc(g.status)}"></span><div><strong>${esc(g.title)}</strong><small>${esc(label(g.status))}</small></div></div>`; }
function renderGoals(p) {
  const pending = pendingGoals(p); const done = completedGoals(p); const active = pending.filter(g=>g.status==='in_progress'); const blocked = pending.filter(g=>g.status==='blocked'); const planned = pending.filter(g=>g.status==='planned');
  return `<section class="panel page-section"><div class="section-heading"><div><p class="eyebrow">目标与计划</p><h2>只把现在需要关注的事情放在上面</h2></div><strong class="big-progress">${esc(progressText(p))}</strong></div><div class="progressbar large"><span style="width:${p.declaredProgress ?? 0}%"></span></div>
    ${active.length ? `<div class="goal-group"><h3>进行中</h3>${active.map(goalRow).join('')}</div>` : ''}
    ${blocked.length ? `<div class="goal-group"><h3>受阻</h3>${blocked.map(goalRow).join('')}</div>` : ''}
    ${planned.length ? `<div class="goal-group"><h3>待处理</h3>${planned.map(goalRow).join('')}</div>` : ''}
    ${!pending.length ? '<p class="muted empty-state">当前没有明确未完成事项。</p>' : ''}
    <details class="completed-goals"><summary>已完成 ${done.length} 项</summary><div class="goal-group done-list">${done.map(goalRow).join('')}</div></details>
  </section>`;
}

async function loadObservations(p) {
  const target = $('#observationHistory'); if (!target) return; const token = ++observationToken;
  try {
    const q = new URLSearchParams({project:p.path,limit:'12'}); if (p.identity?.key) q.set('key',p.identity.key);
    const r = await fetch(`/api/observations?${q}`); const d = await r.json(); if (token !== observationToken) return;
    const items = d.observations || [];
    target.innerHTML = items.length ? `<div class="observation-list">${items.map(x=>`<div class="observation-row"><strong>${esc((x.changes||[]).join('、') || '状态变化')}</strong><small>${esc(date(x.observedAt,true))} · Codex ${x.snapshot?.codex?.sessionCount ?? '—'} · 目标 ${x.snapshot?.declaredProgress ?? '—'}%</small></div>`).join('')}</div>` : '<p class="muted">暂无历史变化。</p>';
  } catch (e) { target.innerHTML = `<p class="muted">观察历史读取失败：${esc(e.message)}</p>`; }
}

function renderProject(p, tab) {
  homeView.hidden = true; projectView.hidden = false; toolbar.hidden = true; homeHero.hidden = true; metrics.hidden = true;
  const body = tab==='development' ? renderDevelopment(p) : tab==='evidence' ? renderEvidence(p) : tab==='goals' ? renderGoals(p) : renderOverview(p);
  projectView.innerHTML = `${projectHeader(p,tab)}<div class="project-page-body">${body}</div>`;
  $('#backBtn')?.addEventListener('click',()=>{ location.hash=''; });
  projectView.querySelectorAll('[data-tab]').forEach(b=>b.addEventListener('click',()=>setRoute(p.id,b.dataset.tab)));
  projectView.querySelectorAll('.bind-session,.bind-unmatched').forEach(b=>b.addEventListener('click',()=>bindSession(b.dataset.session,p)));
  if (tab==='evidence') loadObservations(p);
}

async function bindSession(sessionId,p) {
  if (!sessionId) return;
  try {
    const r = await fetch('/api/session-bindings',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({sessionId,projectKey:p.identity?.key,projectPath:p.path,projectName:p.name})});
    const d = await r.json(); if(!r.ok) throw new Error(d.error||'绑定失败'); await scan(true);
  } catch(e) { alert(`绑定失败：${e.message}`); }
}

function renderRoute() {
  if (!currentData) return; const r = route();
  if (!r.project) return renderHome();
  const p = currentData.projects.find(x=>x.id===r.project); if (!p) { location.hash=''; return; }
  renderProject(p,r.tab);
}

async function scan(preserve = false) {
  scanBtn.disabled = true; scanMessage.textContent = '正在扫描项目、Git 与 AI 开发记录…';
  try {
    const q = new URLSearchParams({depth:depthSelect.value}); const root = rootInput.value.trim(); if(root) q.set('root',root);
    const r = await fetch(`/api/projects?${q}`); const d = await r.json(); if(!r.ok) throw new Error(d.error||'扫描失败'); currentData=d;
    if(!preserve || !rootInput.value.trim()) rootInput.value=d.root; renderMetrics(); renderRoute();
    scanMeta.textContent = `${d.projects.length} 个项目 · ${new Date(d.scannedAt).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'})}`;
    const c=d.agentSources?.codex; scanMessage.textContent=c?.available?`扫描完成 · Codex ${c.parsedSessions||0} 个 · 已归属 ${c.matchedSessions||0} 个`:'扫描完成 · 未发现 Codex 数据源';
  } catch(e) { scanMessage.textContent=e.message; }
  finally { scanBtn.disabled=false; }
}

window.addEventListener('hashchange',renderRoute);
scanBtn.addEventListener('click',()=>scan(true));
rootInput.addEventListener('keydown',e=>{if(e.key==='Enter')scan(true)});
scan(false);
