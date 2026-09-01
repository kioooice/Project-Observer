const scanBtn = document.querySelector('#scanBtn');
const rootInput = document.querySelector('#rootInput');
const scanMessage = document.querySelector('#scanMessage');
const projectView = document.querySelector('#projectView');

async function refreshProjectLibrary() {
  if (rootInput) rootInput.value = '';
  rootInput?.dispatchEvent(new KeyboardEvent('keydown', {
    key: 'Enter',
    bubbles: true
  }));
}

if (scanBtn) {
  scanBtn.textContent = '添加项目';
  scanBtn.addEventListener('click', async event => {
    event.preventDefault();
    event.stopImmediatePropagation();

    const next = window.prompt('添加项目目录', 'D:\\Projects\\my-project');
    if (next == null) return;
    const value = next.trim();
    if (!value) return;

    scanBtn.disabled = true;
    if (scanMessage) scanMessage.textContent = '正在加入项目库…';

    try {
      const response = await fetch('/api/project-library', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: value })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || '添加失败');
      if (scanMessage) scanMessage.textContent = '已加入项目库，正在刷新…';
      cachedData = null;
      await refreshProjectLibrary();
    } catch (error) {
      if (scanMessage) scanMessage.textContent = `添加失败：${error.message}`;
      window.alert(`添加项目失败：${error.message}`);
    } finally {
      scanBtn.disabled = false;
    }
  }, true);
}

let cachedAt = 0;
let cachedData = null;
let requestToken = 0;

const memoryTypeLabels = {
  decision: '关键决策',
  failure: '失败 / 问题经验',
  constraint: '长期约束',
  milestone: '里程碑',
  issue: '未解决事项'
};

const memoryValidityLabels = {
  active: '当前有效',
  open: '仍未解决',
  resolved: '已解决',
  achieved: '已达成',
  unknown: '有效性待确认'
};

function escapeHtml(value = '') {
  return String(value).replace(/[&<>'"]/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  }[char]));
}

function routeInfo() {
  const params = new URLSearchParams(location.hash.replace(/^#/, ''));
  return {
    projectId: params.get('project'),
    tab: params.get('tab') || 'overview'
  };
}

function setProjectTab(projectId, tab) {
  location.hash = `project=${encodeURIComponent(projectId)}&tab=${encodeURIComponent(tab)}`;
}

function formatDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

function dateRange(startAt, endAt) {
  const start = formatDate(startAt);
  const end = formatDate(endAt);
  return start === end ? start : `${start} → ${end}`;
}

async function loadProjectsFromLibrary() {
  const now = Date.now();
  if (cachedData && now - cachedAt < 15000) return cachedData;

  const response = await fetch('/api/projects');
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || '项目状态读取失败');

  cachedAt = now;
  cachedData = data;
  return data;
}

function activityMarkup(insight) {
  const activity = insight?.activity;
  if (!activity) return '';
  const focus = insight.stopPoint || insight.recentFocus || '';
  const historyText = insight.historyCommitCount
    ? `已分析 ${insight.historyCommitCount}${insight.historyTruncated ? '+' : ''} 条 Git 历史`
    : '暂无足够 Git 历史';

  return `
    <div class="evolution-activity" data-evolution-activity>
      <div>
        <span>开发活跃度</span>
        <strong>${escapeHtml(activity.label || '尚未判断')}</strong>
      </div>
      <div>
        <span>${insight.stopPoint ? '停止位置' : '最近推进'}</span>
        <strong>${escapeHtml(focus || '尚未形成明确阶段')}</strong>
      </div>
      <div>
        <span>历史覆盖</span>
        <strong>${escapeHtml(historyText)}</strong>
      </div>
    </div>
  `;
}

function phaseMarkup(phase, displayIndex, total) {
  const themes = (phase.themes || []).map(theme => `<span>${escapeHtml(theme)}</span>`).join('');
  const workTypes = (phase.workTypes || []).map(item => `${item.label} ${item.count}`).join(' · ');
  const summary = (phase.summary || []).slice(0, 3);

  return `
    <article class="evolution-phase${displayIndex === total ? ' latest' : ''}">
      <div class="phase-marker"><span>${displayIndex}</span></div>
      <div class="phase-content">
        <div class="phase-head">
          <div>
            <small>${escapeHtml(dateRange(phase.startAt, phase.endAt))}</small>
            <h3>${escapeHtml(phase.label || `阶段 ${displayIndex}`)}</h3>
          </div>
          <b>${phase.commitCount || 0} 次提交</b>
        </div>
        ${themes ? `<div class="phase-themes">${themes}</div>` : ''}
        ${summary.length ? `<ul>${summary.map(item => `<li>${escapeHtml(item)}</li>`).join('')}</ul>` : ''}
        <div class="phase-meta">${escapeHtml(workTypes || '开发活动')}</div>
      </div>
    </article>
  `;
}

function evolutionMarkup(project) {
  const insight = project.insight || {};
  const phases = [...(insight.evolution || [])].reverse();
  if (!phases.length) {
    return `
      <section class="panel page-section evolution-section" data-project-evolution>
        <p class="eyebrow">项目演进</p>
        <h2>还没有足够历史形成阶段</h2>
        <p class="muted">需要更长的 Git 历史后才能压缩出开发阶段。</p>
      </section>
    `;
  }

  return `
    <section class="panel page-section evolution-section" data-project-evolution>
      <div class="evolution-heading">
        <div>
          <p class="eyebrow">项目演进</p>
          <h2>项目是怎么一步步走到现在的</h2>
        </div>
        <div class="evolution-range">
          <span>${escapeHtml(formatDate(insight.firstActivityAt))}</span>
          <b>→</b>
          <span>${escapeHtml(formatDate(insight.latestActivityAt))}</span>
        </div>
      </div>
      ${activityMarkup(insight)}
      <div class="evolution-timeline">
        ${phases.map((phase, index) => phaseMarkup(phase, index + 1, phases.length)).join('')}
      </div>
      <p class="evolution-note">阶段由 Git 时间连续性和开发主题自动归纳；它描述“发生了什么”，不会自动推测下一步。</p>
    </section>
  `;
}

function memoryCardMarkup(item) {
  const validity = memoryValidityLabels[item.validity] || item.validity || '状态未知';
  const when = item.eventAt || item.lastConfirmedAt || item.firstSeenAt;
  const evidenceItems = (item.evidence || []).slice(0, 6);
  return `
    <article class="memory-card${item.currentEvidence === false ? ' historical' : ''}">
      <div class="memory-card-head">
        <h3>${escapeHtml(item.title || '未命名记忆')}</h3>
        <span class="memory-validity ${escapeHtml(item.validity || 'unknown')}">${escapeHtml(validity)}</span>
      </div>
      ${item.detail ? `<p class="memory-detail">${escapeHtml(item.detail)}</p>` : ''}
      <div class="memory-meta">
        <span>${item.currentEvidence === false ? '当前来源已不再出现' : '当前仍有来源支持'}</span>
        <span>${escapeHtml(formatDate(when))}</span>
        <span>${item.confidence === 'high' ? '高可信' : '中等可信'}</span>
      </div>
      ${evidenceItems.length ? `<details class="memory-evidence"><summary>查看 ${evidenceItems.length} 条证据</summary><div class="memory-evidence-list">${evidenceItems.map(ev => `<div class="memory-evidence-item"><b>${escapeHtml(ev.source || ev.kind || '来源')}</b>${ev.excerpt ? `<p>${escapeHtml(ev.excerpt)}</p>` : ''}${ev.ref ? `<code>${escapeHtml(ev.ref)}</code>` : ''}</div>`).join('')}</div></details>` : ''}
    </article>
  `;
}

function memoryPageMarkup(project) {
  const memory = project.memory || {};
  const items = memory.items || [];
  const counts = memory.counts || {};
  const order = ['decision', 'failure', 'constraint', 'milestone', 'issue'];

  if (!items.length) {
    return `
      <div data-project-memory-page>
        <section class="panel page-section">
          <p class="eyebrow">项目记忆</p>
          <h2>还没有形成可保存的长期记忆</h2>
          <p class="muted">Project Observer 只保存有明确来源的决策、问题经验、约束、里程碑和未解决事项；没有证据时不会补写。</p>
        </section>
      </div>
    `;
  }

  return `
    <div data-project-memory-page>
      <section class="panel page-section">
        <div class="section-heading">
          <div>
            <p class="eyebrow">Project Memory</p>
            <h2>跨会话保留下来的项目长期记忆</h2>
          </div>
          <span class="muted">${items.length} 条记忆 · ${escapeHtml(formatDate(memory.updatedAt))} 更新</span>
        </div>
        <div class="memory-summary">
          ${order.map(type => `<div><strong>${counts[type] || 0}</strong><span>${escapeHtml(memoryTypeLabels[type])}</span></div>`).join('')}
        </div>
        <p class="muted">记忆会持久保存。当前证据消失后不会立即删除，而是把仍需确认的决策、约束和问题标成“有效性待确认”。</p>
      </section>
      <div class="memory-groups">
        ${order.map(type => {
          const group = items.filter(item => item.type === type);
          if (!group.length) return '';
          return `<section class="panel memory-group"><div class="memory-group-head"><div><p class="eyebrow">${escapeHtml(memoryTypeLabels[type])}</p><h2>${escapeHtml(type === 'decision' ? '为什么项目会这样做' : type === 'failure' ? '已经踩过哪些坑' : type === 'constraint' ? '哪些边界长期有效' : type === 'milestone' ? '哪些能力已经真正形成' : '哪些事情仍没有解决')}</h2></div><strong class="memory-count">${group.length}</strong></div><div class="memory-list">${group.map(memoryCardMarkup).join('')}</div></section>`;
        }).join('')}
      </div>
    </div>
  `;
}

function ensureMemoryTab(project) {
  const tabs = projectView?.querySelector('.tabs');
  if (!tabs) return;
  let button = tabs.querySelector('[data-memory-tab]');
  if (!button) {
    button = document.createElement('button');
    button.className = 'tab';
    button.type = 'button';
    button.dataset.memoryTab = 'true';
    button.textContent = '项目记忆';
    button.addEventListener('click', () => setProjectTab(project.id, 'memory'));
    tabs.appendChild(button);
  }
  const active = routeInfo().tab === 'memory';
  if (active) {
    tabs.querySelectorAll('.tab').forEach(item => item.classList.remove('active'));
    button.classList.add('active');
  }
}

function injectOverviewActivity(project) {
  if (routeInfo().tab !== 'overview') return;
  const hero = projectView?.querySelector('.hero-state');
  if (!hero || hero.querySelector('[data-evolution-activity]')) return;
  const insight = project.insight || {};
  const activity = activityMarkup(insight);
  if (!activity) return;
  hero.insertAdjacentHTML('beforeend', activity);
}

function injectOverviewMemory(project) {
  if (routeInfo().tab !== 'overview') return;
  const hero = projectView?.querySelector('.hero-state');
  if (!hero || hero.querySelector('[data-memory-overview]')) return;
  const counts = project.memory?.counts || {};
  const total = Object.values(counts).reduce((sum, value) => sum + Number(value || 0), 0);
  if (!total) return;
  hero.insertAdjacentHTML('beforeend', `
    <div class="memory-overview" data-memory-overview>
      <div class="memory-overview-head"><strong>项目长期记忆 · ${total} 条</strong><button class="text-action" type="button" data-open-memory>查看项目记忆</button></div>
      <div class="memory-overview-chips">
        ${Object.entries(memoryTypeLabels).map(([type, name]) => counts[type] ? `<span>${escapeHtml(name)} ${counts[type]}</span>` : '').join('')}
      </div>
    </div>
  `);
  hero.querySelector('[data-open-memory]')?.addEventListener('click', () => setProjectTab(project.id, 'memory'));
}

function injectDevelopmentEvolution(project) {
  if (routeInfo().tab !== 'development') return;
  const page = projectView?.querySelector('.development-page');
  if (!page || page.querySelector('[data-project-evolution]')) return;
  page.insertAdjacentHTML('afterbegin', evolutionMarkup(project));
}

function renderMemoryView(project) {
  if (routeInfo().tab !== 'memory') return;
  const body = projectView?.querySelector('.project-page-body');
  if (!body || body.querySelector('[data-project-memory-page]')) return;
  body.innerHTML = memoryPageMarkup(project);
}

async function enhanceProjectView() {
  const route = routeInfo();
  if (!route.projectId || !projectView || projectView.hidden) return;
  const token = ++requestToken;

  try {
    const data = await loadProjectsFromLibrary();
    if (token !== requestToken) return;
    const project = (data.projects || []).find(item => item.id === route.projectId);
    if (!project) return;
    ensureMemoryTab(project);
    if (route.tab === 'memory') {
      renderMemoryView(project);
      return;
    }
    injectOverviewActivity(project);
    injectOverviewMemory(project);
    injectDevelopmentEvolution(project);
  } catch (error) {
    console.warn('Project enhancement failed:', error);
  }
}

function scheduleEnhance() {
  setTimeout(enhanceProjectView, 80);
}

window.addEventListener('hashchange', scheduleEnhance);

if (projectView) {
  const observer = new MutationObserver(() => {
    if (!projectView.hidden) scheduleEnhance();
  });
  observer.observe(projectView, { childList: true, subtree: true });
}

scheduleEnhance();
