const projectView = document.querySelector('#projectView');
let cache = null;
let cacheAt = 0;
let token = 0;

function esc(value=''){return String(value).replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));}
function routeInfo(){const p=new URLSearchParams(location.hash.replace(/^#/,''));return {projectId:p.get('project'),tab:p.get('tab')||'overview'};}
async function loadProjects(force=false){if(!force&&cache&&Date.now()-cacheAt<12000)return cache;const r=await fetch('/api/projects');const d=await r.json();if(!r.ok)throw new Error(d.error||'项目理解读取失败');cache=d;cacheAt=Date.now();return d;}
function evidenceLabel(model,id){const e=(model.evidence||[]).find(x=>x.id===id);return e?`${id} · ${e.ref||e.kind} · ${e.text}`:id;}
function refs(model,ids=[]){return ids.map(id=>`<div class="evidence-ref">${esc(evidenceLabel(model,id))}</div>`).join('');}
function cardList(items=[],kind='component'){
  if(!items.length)return '<p class="model-empty">当前证据不足。</p>';
  const cls=kind==='component'?'component-card':kind==='asset'?'asset-card':'verify-card';
  return items.map(item=>`<div class="${cls}"><strong>${esc(item.name||item.label||item.text||'未命名')}</strong>${item.role||item.detail?`<span>${esc(item.role||item.detail)}</span>`:''}</div>`).join('');
}
function workflow(model){const items=model.workflow||[];if(!items.length)return '<p class="model-empty">当前还不能可靠恢复核心工作流。</p>';return `<div class="workflow-line">${items.map((item,i)=>`${i?'<div class="workflow-arrow">→</div>':''}<div class="workflow-step"><strong>${esc(item.label||item.name)}</strong>${item.detail?`<span>${esc(item.detail)}</span>`:''}</div>`).join('')}</div>`;}
function understandingMarkup(project){
  const m=project.understanding||{};const repo=m.repositorySummary||{};const modelIds=[m.positioning?.evidenceIds,m.currentStage?.evidenceIds,m.currentFocus?.evidenceIds,...(m.components||[]).map(x=>x.evidenceIds),...(m.workflow||[]).map(x=>x.evidenceIds),...(m.coreAssets||[]).map(x=>x.evidenceIds),...(m.verification||[]).map(x=>x.evidenceIds)].flat().filter(Boolean);const uniqueIds=[...new Set(modelIds)];
  const mode=m.mode==='llm'?'模型证据综合':'结构事实理解';
  const llm=m.llm||{};
  return `<section class="panel project-model" data-project-model>
    <div class="model-heading"><div><p class="eyebrow">Project Model</p><h2>项目整体是怎么组成和运作的</h2><div class="repo-mini"><span>${repo.fileCount||0} 个受控文件</span>${(repo.languages||[]).slice(0,4).map(x=>`<span>${esc(x.name)} ${x.fileCount}</span>`).join('')}</div></div><div class="model-mode"><span class="model-badge ${m.mode==='llm'?'llm':''}">${esc(mode)}</span>${llm.configured?`<button class="model-refresh" data-model-refresh data-path="${esc(project.path)}">用模型重新综合</button>`:'<span class="model-badge">未配置语义模型</span>'}</div></div>
    <div class="model-positioning"><span>项目定位</span><strong>${esc(m.positioning?.text||project.summary||'尚未恢复')}</strong></div>
    <div class="model-stage-row"><div><span>当前阶段</span><strong>${esc(m.currentStage?.text||'尚未判断')}</strong></div><div><span>当前重点 / 停止点</span><strong>${esc(m.currentFocus?.text||'尚未形成可靠结论')}</strong></div><div><span>理解依据</span><strong>仓库结构 + 文档 + Git + 项目记忆</strong></div></div>
    <div class="model-grid">
      <div class="model-block wide"><h3>系统组成</h3><div class="component-grid">${cardList((m.components||[]).slice(0,12),'component')}</div></div>
      <div class="model-block wide"><h3>核心工作流 / 职责链</h3>${workflow(m)}</div>
      <div class="model-block"><h3>核心资产</h3><div class="asset-grid">${cardList((m.coreAssets||[]).slice(0,8),'asset')}</div></div>
      <div class="model-block"><h3>验证与质量控制</h3><div class="verify-grid">${cardList((m.verification||[]).slice(0,8),'verify')}</div></div>
      <div class="model-block"><h3>运行 / 交付形态</h3><div class="verify-grid">${cardList((m.delivery||[]).slice(0,8),'verify')}</div></div>
      <div class="model-block"><h3>当前限制</h3>${(m.limitations||[]).length?`<ul class="human-list">${m.limitations.slice(0,8).map(x=>`<li>${esc(x.text||x)}</li>`).join('')}</ul>`:'<p class="model-empty">没有从现有证据恢复到明确限制。</p>'}</div>
    </div>
    ${llm.status==='error'?`<div class="model-error">模型综合失败：${esc(llm.error||'未知错误')}</div>`:''}
    <details class="model-evidence"><summary>查看本页结论对应的证据（${uniqueIds.length}）</summary><div class="evidence-ref-list">${refs(m,uniqueIds.slice(0,24))}</div></details>
  </section>`;
}
function inject(project){if(routeInfo().tab!=='overview')return;const grid=projectView?.querySelector('.overview-grid-v6');if(!grid||grid.querySelector('[data-project-model]'))return;const hero=grid.querySelector('.hero-state');if(hero)hero.insertAdjacentHTML('afterend',understandingMarkup(project));else grid.insertAdjacentHTML('afterbegin',understandingMarkup(project));}
async function enhance(force=false){const route=routeInfo();if(!route.projectId||route.tab!=='overview'||!projectView||projectView.hidden)return;const my=++token;try{const data=await loadProjects(force);if(my!==token)return;const project=(data.projects||[]).find(x=>x.id===route.projectId);if(project)inject(project);}catch(e){console.warn('Project understanding enhancement failed:',e);}}
async function refreshWithModel(button){const projectPath=button.dataset.path;if(!projectPath)return;button.disabled=true;const old=button.textContent;button.textContent='模型综合中…';try{const r=await fetch('/api/project-understanding',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({path:projectPath})});const d=await r.json();if(!r.ok)throw new Error(d.error||'模型综合失败');cache=null;projectView?.querySelector('[data-project-model]')?.remove();await enhance(true);}catch(e){window.alert(`项目理解失败：${e.message}`);}finally{button.disabled=false;button.textContent=old;}}
document.addEventListener('click',event=>{const button=event.target.closest('[data-model-refresh]');if(button){event.preventDefault();refreshWithModel(button);}});
window.addEventListener('hashchange',()=>setTimeout(()=>enhance(),100));
if(projectView){new MutationObserver(()=>{if(!projectView.hidden)setTimeout(()=>enhance(),80);}).observe(projectView,{childList:true,subtree:true});}
setTimeout(()=>enhance(),120);
