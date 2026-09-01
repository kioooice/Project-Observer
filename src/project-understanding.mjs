import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const storeDir = path.join(os.homedir(), '.project-observer');
const understandingFile = path.join(storeDir, 'project-understanding.json');

function clean(value, limit = 360) {
  const text = String(value || '').replace(/\s+/g,' ').trim();
  if (!text) return null;
  return text.length > limit ? `${text.slice(0,limit-1)}…` : text;
}
function keyOf(project) { return project.identity?.key || `path:${String(project.path||'').toLowerCase()}`; }
function hash(value) { return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0,24); }
function unique(items,keyFn=x=>String(x)) { const seen=new Set(); const out=[]; for(const item of items){ if(!item)continue; const key=keyFn(item); if(seen.has(key))continue; seen.add(key); out.push(item);} return out; }

function makeEvidence(project) {
  const items=[]; let seq=1;
  const add=(kind,ref,text,meta={})=>{ const value=clean(text,520); if(!value)return null; const id=`E${String(seq++).padStart(3,'0')}`; items.push({id,kind,ref,text:value,...meta}); return id; };

  if(project.summary) add('project_summary',project.summarySource||'项目说明',project.summary);
  for(const source of project.recovery?.sources||[]) add('source',source.label,`存在项目信息来源：${source.label}`);
  for(const section of project.recovery?.readmeSections||[]) {
    const content=[...(section.paragraphs||[]),...(section.bullets||[])].slice(0,5).join('；');
    if(content) add('document_section',`README > ${section.heading}`,content,{heading:section.heading});
  }
  for(const component of project.repositoryMap?.components||[]) add('repository_component',component.evidence?.[0]||`${component.name}/`,`${component.name}：${component.label}，约 ${component.fileCount} 个文件`,{name:component.name,role:component.label,roleKind:component.kind});
  for(const entry of project.repositoryMap?.entrypoints||[]) add('entrypoint',entry.ref||entry.label,`${entry.label}${entry.detail?`：${entry.detail}`:''}`);
  for(const asset of project.repositoryMap?.coreAssets||[]) add('core_asset',asset.ref,`${asset.name}：${asset.type}，约 ${asset.fileCount} 个文件`,{name:asset.name,type:asset.type});
  for(const item of project.repositoryMap?.verification||[]) add('verification',item.ref,`${item.name}：${item.ref}`);
  for(const item of project.repositoryMap?.delivery||[]) add('delivery',item.ref,`${item.name}${item.detail?`：${item.detail}`:''}`);
  for(const lang of project.repositoryMap?.languages||[]) add('language','Git 跟踪文件',`${lang.name}：${lang.fileCount} 个文件`);
  for(const theme of project.insight?.recentThemes||[]) add('recent_theme','Git 历史',`${theme.label}：${theme.count} 次相关提交，最近 ${theme.latestAt||'未知'}`);
  if(project.insight?.recentFocus) add('recent_focus','Git 演进',`最近推进：${project.insight.recentFocus}`);
  if(project.insight?.stopPoint) add('stop_point','Git 演进',`最后停留：${project.insight.stopPoint}`);
  for(const limitation of project.insight?.limitations||[]) add('limitation','README 限制章节',limitation);
  for(const mem of project.memory?.memories?.slice(0,20)||[]) add(`memory_${mem.type}`,mem.evidence?.[0]?.source||'项目记忆',`${mem.typeLabel||mem.type}：${mem.title}${mem.detail?`；${mem.detail}`:''}`,{memoryId:mem.id});
  return items.slice(0,120);
}

function evidenceIds(evidence, predicate, limit=8) { return evidence.filter(predicate).slice(0,limit).map(x=>x.id); }

function inferWorkflow(project,evidence) {
  const components=project.repositoryMap?.components||[];
  const order=['data','knowledge','source','engine','backend','api','agents','frontend','evaluation','tests','runtime'];
  const labels={data:'数据/样本进入项目',knowledge:'知识与检索资产处理',source:'核心程序处理',engine:'内部引擎执行',backend:'后端服务处理',api:'接口提供能力',agents:'Agent / 工作流编排',frontend:'界面提供交互',evaluation:'评测与质量控制',tests:'自动化测试验证',runtime:'桌面运行与交付'};
  const steps=[];
  for(const kind of order){ const matches=components.filter(c=>c.kind===kind); if(!matches.length)continue; const ids=evidenceIds(evidence,e=>e.kind==='repository_component'&&matches.some(c=>c.name===e.name),4); steps.push({label:labels[kind],detail:matches.map(x=>x.name).join(' / '),evidenceIds:ids}); }
  return steps.slice(0,7);
}

function baselineUnderstanding(project,evidence) {
  const map=project.repositoryMap||{}; const insight=project.insight||{};
  const componentIds=evidenceIds(evidence,e=>e.kind==='repository_component',10);
  const summaryEvidence=evidenceIds(evidence,e=>['project_summary','document_section'].includes(e.kind),4);
  const positioning=clean(project.summary || map.package?.description || `${project.name} 是一个由 ${map.components?.slice(0,3).map(x=>x.label).join('、')||'多个模块'}构成的软件项目。`,300);
  const components=(map.components||[]).slice(0,10).map(c=>({name:c.name,role:c.label,detail:`约 ${c.fileCount} 个文件`,evidenceIds:evidenceIds(evidence,e=>e.kind==='repository_component'&&e.name===c.name,2)}));
  const coreAssets=(map.coreAssets||[]).map(a=>({name:a.name,role:a.type,evidenceIds:evidenceIds(evidence,e=>e.kind==='core_asset'&&e.name===a.name,2)}));
  const verification=(map.verification||[]).map(v=>({name:v.name,detail:v.ref,evidenceIds:evidenceIds(evidence,e=>e.kind==='verification'&&e.ref===v.ref,2)}));
  for(const q of insight.qualitySignals||[]) verification.push({name:clean(q,100),detail:'项目文档明确描述',evidenceIds:evidenceIds(evidence,e=>e.kind==='document_section'&&e.text.includes(clean(q,80)||'__none__'),1)});
  const delivery=(map.delivery||[]).map(d=>({name:d.name,detail:d.detail||d.ref,evidenceIds:evidenceIds(evidence,e=>e.kind==='delivery'&&e.ref===d.ref,2)}));
  const stageText=insight.stateLabel || (project.git?.historyCommits?.length?'项目处于持续建设阶段':'当前阶段证据不足');
  const focus=insight.stopPoint || insight.recentFocus || insight.recentThemes?.[0]?.label || null;
  return {
    mode:'structure',
    generatedAt:new Date().toISOString(),
    positioning:{text:positioning,evidenceIds:summaryEvidence.length?summaryEvidence:componentIds.slice(0,3)},
    currentStage:{text:stageText,evidenceIds:evidenceIds(evidence,e=>['recent_theme','recent_focus','stop_point','delivery'].includes(e.kind),6)},
    currentFocus:focus?{text:focus,evidenceIds:evidenceIds(evidence,e=>['recent_focus','stop_point','recent_theme'].includes(e.kind),5)}:null,
    components,
    workflow:inferWorkflow(project,evidence),
    coreAssets,
    verification:unique(verification,x=>`${x.name}|${x.detail}`).slice(0,10),
    delivery,
    limitations:(insight.limitations||[]).slice(0,8).map(text=>({text,evidenceIds:evidenceIds(evidence,e=>e.kind==='limitation'&&e.text===clean(text,520),2)})),
    entrypoints:(map.entrypoints||[]).slice(0,8).map(x=>({name:x.label,detail:x.detail||null,evidenceIds:evidenceIds(evidence,e=>e.kind==='entrypoint'&&e.ref===(x.ref||x.label),2)})),
    repositorySummary:{fileCount:map.fileCount||0,languages:map.languages||[],componentCount:components.length,evidenceCount:evidence.length},
    evidence
  };
}

function llmConfig() {
  const baseUrl=String(process.env.PROJECT_OBSERVER_LLM_BASE_URL||'').replace(/\/$/,'');
  const apiKey=process.env.PROJECT_OBSERVER_LLM_API_KEY||'';
  const model=process.env.PROJECT_OBSERVER_LLM_MODEL||'';
  return {configured:Boolean(baseUrl&&apiKey&&model),baseUrl,apiKey,model,auto:process.env.PROJECT_OBSERVER_LLM_AUTO==='1'};
}

function packetForLlm(project,baseline) {
  return {
    project:{name:project.name,path:project.path,explicitStage:project.stage||null,status:project.status||null},
    baseline:{positioning:baseline.positioning,currentStage:baseline.currentStage,currentFocus:baseline.currentFocus},
    evidence:baseline.evidence.map(({id,kind,ref,text})=>({id,kind,ref,text}))
  };
}

function parseJsonObject(text) {
  const raw=String(text||'').trim();
  try{return JSON.parse(raw);}catch{}
  const start=raw.indexOf('{'); const end=raw.lastIndexOf('}');
  if(start>=0&&end>start){ try{return JSON.parse(raw.slice(start,end+1));}catch{} }
  throw new Error('模型没有返回可解析的 JSON');
}

function supportedIds(ids,allowed) { return unique((Array.isArray(ids)?ids:[]).filter(id=>allowed.has(id))).slice(0,8); }
function validateClaim(value,allowed) {
  if(!value||typeof value!=='object')return null; const text=clean(value.text,420); const ids=supportedIds(value.evidenceIds,allowed); if(!text||!ids.length)return null; return {text,evidenceIds:ids};
}
function validateList(list,allowed,fields=['name','role','detail']) {
  if(!Array.isArray(list))return [];
  return list.map(item=>{ if(!item||typeof item!=='object')return null; const ids=supportedIds(item.evidenceIds,allowed); if(!ids.length)return null; const out={evidenceIds:ids}; for(const field of fields){ const v=clean(item[field],field==='detail'?300:140); if(v)out[field]=v; } if(!out.name&&!out.text&&!out.label)return null; return out; }).filter(Boolean).slice(0,12);
}

function validateLlm(result,baseline) {
  const allowed=new Set(baseline.evidence.map(x=>x.id));
  const positioning=validateClaim(result.positioning,allowed);
  const currentStage=validateClaim(result.currentStage,allowed);
  const currentFocus=validateClaim(result.currentFocus,allowed);
  const components=validateList(result.components,allowed,['name','role','detail']);
  const workflow=validateList(result.workflow,allowed,['name','label','detail']).map(x=>({label:x.label||x.name,detail:x.detail||null,evidenceIds:x.evidenceIds}));
  const coreAssets=validateList(result.coreAssets,allowed,['name','role','detail']);
  const verification=validateList(result.verification,allowed,['name','detail']);
  const delivery=validateList(result.delivery,allowed,['name','detail']);
  const limitations=(Array.isArray(result.limitations)?result.limitations:[]).map(x=>validateClaim(x,allowed)).filter(Boolean).slice(0,10);
  return {
    ...baseline,
    mode:'llm',
    generatedAt:new Date().toISOString(),
    positioning:positioning||baseline.positioning,
    currentStage:currentStage||baseline.currentStage,
    currentFocus:currentFocus||baseline.currentFocus,
    components:components.length?components:baseline.components,
    workflow:workflow.length?workflow:baseline.workflow,
    coreAssets:coreAssets.length?coreAssets:baseline.coreAssets,
    verification:verification.length?verification:baseline.verification,
    delivery:delivery.length?delivery:baseline.delivery,
    limitations:limitations.length?limitations:baseline.limitations
  };
}

async function callLlm(project,baseline) {
  const cfg=llmConfig(); if(!cfg.configured) throw new Error('尚未配置语义模型');
  const prompt=`你是软件项目考古与项目理解引擎。只能依据给定 evidence 形成项目模型，禁止补充没有证据的事实。每个结论必须提供 evidenceIds。\n\n请输出严格 JSON：\n{\n  "positioning":{"text":"项目最终解决什么问题","evidenceIds":["E001"]},\n  "currentStage":{"text":"当前真实建设阶段","evidenceIds":[]},\n  "currentFocus":{"text":"最近重点/停止点","evidenceIds":[]},\n  "components":[{"name":"组件名","role":"职责","detail":"补充","evidenceIds":[]}],\n  "workflow":[{"label":"工作流步骤","detail":"补充","evidenceIds":[]}],\n  "coreAssets":[{"name":"资产","role":"类型/价值","detail":"补充","evidenceIds":[]}],\n  "verification":[{"name":"验证方式","detail":"说明","evidenceIds":[]}],\n  "delivery":[{"name":"运行或交付形态","detail":"说明","evidenceIds":[]}],\n  "limitations":[{"text":"当前限制","evidenceIds":[]}]\n}\n\n不要把文件名罗列当作总结；要把仓库结构转成面向人的项目认知。证据不足的字段可以省略。\n\nINPUT:\n${JSON.stringify(packetForLlm(project,baseline))}`;
  const response=await fetch(`${cfg.baseUrl}/chat/completions`,{method:'POST',headers:{'content-type':'application/json','authorization':`Bearer ${cfg.apiKey}`},body:JSON.stringify({model:cfg.model,temperature:0.1,messages:[{role:'user',content:prompt}]})});
  const data=await response.json().catch(()=>({}));
  if(!response.ok)throw new Error(data?.error?.message||`模型请求失败：${response.status}`);
  const content=data?.choices?.[0]?.message?.content; if(!content)throw new Error('模型没有返回内容');
  return {result:parseJsonObject(content),config:cfg};
}

async function readStore(){ try{ const raw=await fs.readFile(understandingFile,'utf8'); const parsed=JSON.parse(raw); return {schemaVersion:1,projects:parsed?.projects&&typeof parsed.projects==='object'?parsed.projects:{}};}catch{return {schemaVersion:1,projects:{}};} }
async function writeStore(store){ await fs.mkdir(storeDir,{recursive:true}); const tmp=`${understandingFile}.tmp`; await fs.writeFile(tmp,`${JSON.stringify(store,null,2)}\n`,'utf8'); await fs.rename(tmp,understandingFile); }

function fingerprint(project,baseline){ return hash({latest:project.git?.latestCommit?.hash||project.git?.latestCommit?.date||null,repo:{fileCount:project.repositoryMap?.fileCount,components:project.repositoryMap?.components,manifests:project.repositoryMap?.manifests},memory:project.memory?.summary,evidence:baseline.evidence.map(x=>[x.kind,x.ref,x.text])}); }

export async function attachProjectUnderstanding(projects) {
  const cfg=llmConfig(); const store=await readStore(); let changed=false;
  for(const project of projects){
    const evidence=makeEvidence(project); const baseline=baselineUnderstanding(project,evidence); const fp=fingerprint(project,baseline); const key=keyOf(project); const cached=store.projects[key];
    let understanding=baseline;
    if(cached?.fingerprint===fp&&cached?.understanding?.mode==='llm') understanding={...cached.understanding,evidence:baseline.evidence,repositorySummary:baseline.repositorySummary};
    else if(cfg.auto&&cfg.configured){
      try{ const {result,config}=await callLlm(project,baseline); understanding=validateLlm(result,baseline); understanding.llm={configured:true,model:config.model,status:'ok'}; store.projects[key]={fingerprint:fp,understanding,updatedAt:new Date().toISOString()}; changed=true; }
      catch(error){ understanding.llm={configured:true,model:cfg.model,status:'error',error:error?.message||String(error)}; }
    }
    if(!understanding.llm) understanding.llm={configured:cfg.configured,model:cfg.model||null,status:understanding.mode==='llm'?'ok':'not_run'};
    understanding.fingerprint=fp; project.understanding=understanding;
  }
  if(changed)await writeStore(store); return projects;
}

export async function synthesizeProjectUnderstanding(project) {
  const evidence=makeEvidence(project); const baseline=baselineUnderstanding(project,evidence); const fp=fingerprint(project,baseline); const {result,config}=await callLlm(project,baseline); const understanding=validateLlm(result,baseline); understanding.llm={configured:true,model:config.model,status:'ok'}; understanding.fingerprint=fp;
  const store=await readStore(); store.projects[keyOf(project)]={fingerprint:fp,understanding,updatedAt:new Date().toISOString()}; await writeStore(store); project.understanding=understanding; return understanding;
}

export function getProjectUnderstandingInfo(){ const cfg=llmConfig(); return {storeDir,understandingFile,llm:{configured:cfg.configured,model:cfg.model||null,auto:cfg.auto}}; }
