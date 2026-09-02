const projectView = document.querySelector('#projectView');
let cachedData = null;
let cachedAt = 0;
let requestToken = 0;

function esc(value = '') {
  return String(value).replace(/[&<>'"]/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  }[char]));
}

function routeInfo() {
  const params = new URLSearchParams(location.hash.replace(/^#/, ''));
  return { projectId: params.get('project'), tab: params.get('tab') || 'overview' };
}

function dateTime(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
  }).format(date);
}

async function loadProjects() {
  const now = Date.now();
  if (cachedData && now - cachedAt < 15000) return cachedData;
  const response = await fetch('/api/projects');
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || '提交理解读取失败');
  cachedData = data;
  cachedAt = now;
  return data;
}

function nodeMarkup(node) {
  const symbols = (node.symbols || []).slice(0, 4);
  return `
    <div class="cf-node" data-kind="${esc(node.kind || 'other')}">
      <span>${esc(node.label || '项目文件')}</span>
      <strong>${esc(node.path || '')}</strong>
      ${symbols.length ? `<small>${symbols.map(symbol => esc(symbol)).join(' · ')}</small>` : ''}
    </div>
  `;
}

function edgeMarkup(edge) {
  return `
    <div class="cf-edge">
      <code>${esc(edge.from)}</code>
      <b>→</b>
      <code>${esc(edge.to)}</code>
      <span>${esc(edge.label || edge.relation || '关联')}</span>
    </div>
  `;
}

function flowMarkup(flow) {
  if (!flow?.available) {
    return `
      <div class="cf-flow-empty">
        <strong>暂不生成运行流程</strong>
        <p>${esc(flow?.reason || '当前证据不足。')}</p>
      </div>
    `;
  }
  const confidence = flow.confidence === 'high' ? '较高可信' : '结构推断';
  return `
    <div class="cf-flow-head">
      <span>${esc(confidence)}</span>
      <p>${esc(flow.reason || '')}</p>
    </div>
    <div class="cf-flow">
      ${(flow.steps || []).map((step, index) => `
        <div class="cf-flow-step">
          <div class="cf-flow-box">
            <span>${esc(step.label || '')}</span>
            <strong>${esc(step.detail || '')}</strong>
          </div>
          ${index < flow.steps.length - 1 ? '<b class="cf-arrow">→</b>' : ''}
        </div>
      `).join('')}
    </div>
  `;
}

function fileEvidenceMarkup(file) {
  const additions = Number.isFinite(file.added) ? `+${file.added}` : '';
  const deletions = Number.isFinite(file.deleted) ? `-${file.deleted}` : '';
  const stats = [additions, deletions].filter(Boolean).join(' / ');
  const status = (file.statuses || []).join('/') || 'M';
  return `
    <div class="cf-file-row">
      <span class="cf-status">${esc(status)}</span>
      <code>${esc(file.path)}</code>
      <span>${esc(file.label || '')}</span>
      <small>${esc(stats || '行数变化未恢复')}</small>
      ${(file.symbols || []).length ? `<small class="cf-symbols">涉及：${(file.symbols || []).slice(0, 5).map(esc).join('、')}</small>` : ''}
    </div>
  `;
}

function batchMarkup(batch, index) {
  const edges = batch.impact?.edges || [];
  const nodes = batch.impact?.nodes || [];
  const commits = batch.commits || [];
  const opened = index === 0 ? ' open' : '';
  return `
    <details class="cf-batch"${opened}>
      <summary>
        <div>
          <span class="cf-index">${index === 0 ? '最近一轮' : `第 ${index + 1} 轮`}</span>
          <strong>${esc(batch.summary || '开发批次')}</strong>
          <small>${esc(dateTime(batch.startAt))}${batch.startAt !== batch.endAt ? ` → ${esc(dateTime(batch.endAt))}` : ''}</small>
        </div>
        <div class="cf-summary-meta">
          <span>${batch.commitCount || commits.length} 次提交</span>
          <span>${(batch.files || []).length} 个文件</span>
          <span>${edges.length} 条直接代码关系</span>
        </div>
      </summary>
      <div class="cf-batch-body">
        <div class="cf-columns">
          <section class="cf-block">
            <div class="cf-block-head">
              <div><p class="eyebrow">Impact Graph</p><h3>这次改动影响了哪里</h3></div>
              <span>${nodes.length} 个节点</span>
            </div>
            <div class="cf-nodes">${nodes.map(nodeMarkup).join('')}</div>
            <div class="cf-relations">
              <h4>代码关系</h4>
              ${edges.length ? edges.map(edgeMarkup).join('') : '<p class="muted">本轮修改文件之间没有恢复到直接 import / require 关系；这不代表它们运行时完全无关。</p>'}
            </div>
          </section>

          <section class="cf-block">
            <div class="cf-block-head">
              <div><p class="eyebrow">Runtime Flow</p><h3>这一步大致怎么运作</h3></div>
              <span>${batch.flow?.confidence === 'high' ? '代码关系支持' : batch.flow?.available ? '结构推断' : '证据不足'}</span>
            </div>
            ${flowMarkup(batch.flow)}
          </section>
        </div>

        <details class="cf-evidence">
          <summary>查看代码改动证据</summary>
          <div class="cf-file-list">${(batch.files || []).map(fileEvidenceMarkup).join('')}</div>
          <div class="cf-commits">
            ${commits.map(commit => `<div><code>${esc(commit.shortHash || '')}</code><span>${esc(commit.subject || '')}</span></div>`).join('')}
          </div>
        </details>
      </div>
    </details>
  `;
}

function commitFlowMarkup(project) {
  const flow = project.commitFlow || {};
  const batches = flow.batches || [];
  return `
    <section class="panel page-section commit-flow-section" data-commit-flow>
      <div class="section-heading">
        <div>
          <p class="eyebrow">Commit Understanding</p>
          <h2>每一轮修改到底动了什么、怎么运作</h2>
        </div>
        <span class="muted">最近 ${batches.length} 轮开发批次</span>
      </div>
      <p class="cf-note">直接代码引用属于事实证据；运行流程只有证据足够时才显示，结构推断会明确标注，不把猜测伪装成调用链。</p>
      ${flow.error ? `<div class="attention">提交理解失败：${esc(flow.error)}</div>` : ''}
      <div class="cf-batch-list">
        ${batches.length ? batches.map(batchMarkup).join('') : '<p class="muted">还没有足够的近期 Git 提交用于生成改动图。</p>'}
      </div>
    </section>
  `;
}

function injectCommitFlow(project) {
  if (routeInfo().tab !== 'development') return;
  const page = projectView?.querySelector('.development-page');
  if (!page || page.querySelector('[data-commit-flow]')) return;
  const evolution = page.querySelector('[data-project-evolution]');
  if (evolution) evolution.insertAdjacentHTML('afterend', commitFlowMarkup(project));
  else page.insertAdjacentHTML('afterbegin', commitFlowMarkup(project));
}

async function enhance() {
  const route = routeInfo();
  if (route.tab !== 'development' || !route.projectId || !projectView || projectView.hidden) return;
  const token = ++requestToken;
  try {
    const data = await loadProjects();
    if (token !== requestToken) return;
    const project = (data.projects || []).find(item => item.id === route.projectId);
    if (!project) return;
    injectCommitFlow(project);
  } catch (error) {
    console.warn('Commit flow enhancement failed:', error);
  }
}

function schedule() { setTimeout(enhance, 140); }
window.addEventListener('hashchange', schedule);

if (projectView) {
  const observer = new MutationObserver(() => {
    if (!projectView.hidden && routeInfo().tab === 'development') schedule();
  });
  observer.observe(projectView, { childList: true, subtree: true });
}

schedule();
