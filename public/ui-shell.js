const scanBtn = document.querySelector('#scanBtn');
const rootInput = document.querySelector('#rootInput');

if (scanBtn && rootInput) {
  scanBtn.addEventListener('click', event => {
    event.preventDefault();
    event.stopImmediatePropagation();

    const current = rootInput.value.trim();
    const next = window.prompt('扫描项目目录', current || 'D:\\Projects');
    if (next == null) return;

    const value = next.trim();
    if (value) rootInput.value = value;

    rootInput.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Enter',
      bubbles: true
    }));
  }, true);
}

const projectView = document.querySelector('#projectView');
let cachedRoot = null;
let cachedAt = 0;
let cachedData = null;
let requestToken = 0;

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

async function loadProjectsForCurrentRoot() {
  const root = rootInput?.value?.trim() || '';
  const now = Date.now();
  if (cachedData && cachedRoot === root && now - cachedAt < 15000) return cachedData;

  const query = new URLSearchParams({ depth: '2' });
  if (root) query.set('root', root);
  const response = await fetch(`/api/projects?${query}`);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || '项目演进读取失败');

  cachedRoot = root;
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

function injectOverviewActivity(project) {
  if (routeInfo().tab !== 'overview') return;
  const hero = projectView?.querySelector('.hero-state');
  if (!hero || hero.querySelector('[data-evolution-activity]')) return;
  const insight = project.insight || {};
  const activity = activityMarkup(insight);
  if (!activity) return;
  hero.insertAdjacentHTML('beforeend', activity);
}

function injectDevelopmentEvolution(project) {
  if (routeInfo().tab !== 'development') return;
  const page = projectView?.querySelector('.development-page');
  if (!page || page.querySelector('[data-project-evolution]')) return;
  page.insertAdjacentHTML('afterbegin', evolutionMarkup(project));
}

async function enhanceProjectView() {
  const route = routeInfo();
  if (!route.projectId || !projectView || projectView.hidden) return;
  const token = ++requestToken;

  try {
    const data = await loadProjectsForCurrentRoot();
    if (token !== requestToken) return;
    const project = (data.projects || []).find(item => item.id === route.projectId);
    if (!project) return;
    injectOverviewActivity(project);
    injectDevelopmentEvolution(project);
  } catch (error) {
    console.warn('Project evolution enhancement failed:', error);
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
