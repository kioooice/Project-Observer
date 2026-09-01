import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const MAX_FILES = 6000;
const NOISE_DIRS = new Set(['.git','node_modules','dist','build','vendor','coverage','.next','.cache','__pycache__','.venv','venv','target']);

const ROLE_RULES = [
  ['tests', /^(test|tests|spec|specs|e2e|integration)$/i, '测试与验证'],
  ['evaluation', /(eval|evaluation|benchmark|retrieval_eval|quality|audit)/i, '评测与质量控制'],
  ['data', /^(data|dataset|datasets|corpus|samples|fixtures)$/i, '数据与样本资产'],
  ['knowledge', /(knowledge|kb|rag|evidence|mapping|mappings)/i, '知识与检索资产'],
  ['docs', /^(docs?|documentation)$/i, '项目文档'],
  ['scripts', /^(scripts?|tools?|bin)$/i, '工程脚本与工具'],
  ['frontend', /^(frontend|front|web|ui|client|renderer|public)$/i, '前端与界面'],
  ['backend', /^(backend|server|api|services?)$/i, '后端与服务'],
  ['source', /^(src|app|lib|core)$/i, '核心程序'],
  ['agents', /(agent|agents|skills|workflows?)/i, 'Agent 与工作流'],
  ['models', /^(models?|weights?)$/i, '模型资产'],
  ['config', /^(config|configs|settings)$/i, '配置'],
  ['runtime', /(runtime|desktop|electron|tauri)/i, '桌面运行与打包'],
  ['migrations', /^migrations?$/i, '数据库迁移']
];

const EXT_LANGUAGE = {
  '.js':'JavaScript','.mjs':'JavaScript','.cjs':'JavaScript','.ts':'TypeScript','.tsx':'TypeScript','.jsx':'JavaScript',
  '.py':'Python','.rs':'Rust','.go':'Go','.java':'Java','.kt':'Kotlin','.cs':'C#','.cpp':'C++','.cc':'C++','.c':'C',
  '.vue':'Vue','.svelte':'Svelte','.html':'HTML','.css':'CSS','.scss':'SCSS','.sql':'SQL','.sh':'Shell','.ps1':'PowerShell'
};

async function git(cwd, args) {
  try {
    const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], { windowsHide:true, timeout:8000, maxBuffer:1024*1024*12 });
    return stdout;
  } catch { return null; }
}

async function exists(target) { try { await fs.access(target); return true; } catch { return false; } }

async function trackedFiles(projectPath) {
  const out = await git(projectPath, ['ls-files','-z']);
  if (out != null) return out.split('\0').filter(Boolean).slice(0, MAX_FILES).map(x => x.replaceAll('\\','/'));
  const result = [];
  async function walk(dir, rel = '', depth = 0) {
    if (result.length >= MAX_FILES || depth > 3) return;
    let entries; try { entries = await fs.readdir(dir, { withFileTypes:true }); } catch { return; }
    for (const entry of entries) {
      if (NOISE_DIRS.has(entry.name) || entry.name.startsWith('.git')) continue;
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(path.join(dir,entry.name), childRel, depth+1);
      else result.push(childRel.replaceAll('\\','/'));
      if (result.length >= MAX_FILES) break;
    }
  }
  await walk(projectPath);
  return result;
}

function roleFor(name) {
  for (const [kind, re, label] of ROLE_RULES) if (re.test(name)) return { kind, label };
  return { kind:'module', label:'项目模块' };
}

function unique(items, keyFn = x => String(x)) {
  const seen = new Set(); const out = [];
  for (const item of items) { const key = keyFn(item); if (seen.has(key)) continue; seen.add(key); out.push(item); }
  return out;
}

async function readJson(file) { try { return JSON.parse(await fs.readFile(file,'utf8')); } catch { return null; } }
async function readText(file, max = 128*1024) {
  try { const stat = await fs.stat(file); if (!stat.isFile() || stat.size > max) return null; return await fs.readFile(file,'utf8'); } catch { return null; }
}

function detectComponents(files) {
  const counts = new Map();
  for (const file of files) {
    const [top] = file.split('/');
    if (!top || !file.includes('/')) continue;
    if (NOISE_DIRS.has(top)) continue;
    counts.set(top, (counts.get(top)||0)+1);
  }
  return [...counts.entries()]
    .map(([name,fileCount]) => ({ name, fileCount, ...roleFor(name), evidence:[name+'/'] }))
    .filter(item => item.fileCount >= 2 || item.kind !== 'module')
    .sort((a,b) => {
      const ar = a.kind === 'module' ? 1 : 0; const br = b.kind === 'module' ? 1 : 0;
      return ar-br || b.fileCount-a.fileCount;
    })
    .slice(0,18);
}

function detectLanguages(files) {
  const counts = new Map();
  for (const file of files) {
    const lang = EXT_LANGUAGE[path.extname(file).toLowerCase()];
    if (lang) counts.set(lang,(counts.get(lang)||0)+1);
  }
  return [...counts.entries()].sort((a,b)=>b[1]-a[1]).slice(0,6).map(([name,fileCount])=>({name,fileCount}));
}

function detectKnownFiles(files) {
  const names = new Set(files.map(x => x.toLowerCase()));
  const candidates = [
    ['package.json','Node 项目清单'],['pyproject.toml','Python 项目清单'],['requirements.txt','Python 依赖'],['cargo.toml','Rust 项目清单'],['go.mod','Go 项目清单'],
    ['dockerfile','Docker 构建'],['docker-compose.yml','容器编排'],['compose.yml','容器编排'],['tauri.conf.json','Tauri 桌面配置'],
    ['src-tauri/tauri.conf.json','Tauri 桌面配置'],['electron-builder.yml','Electron 打包配置'],['vite.config.ts','Vite 构建配置'],['vite.config.js','Vite 构建配置']
  ];
  return candidates.filter(([file])=>names.has(file)).map(([file,label])=>({path:file,label}));
}

function detectEntrypoints(files, packageJson) {
  const lowerMap = new Map(files.map(f=>[f.toLowerCase(),f]));
  const patterns = [
    /^src\/(index|main|app|server|cli)\.(m?js|cjs|ts|tsx|py)$/i,
    /^(index|main|app|server|cli)\.(m?js|cjs|ts|tsx|py)$/i,
    /^app\/(main|server|api)\.(m?js|ts|py)$/i,
    /^src-tauri\/src\/main\.rs$/i
  ];
  const found = files.filter(f => patterns.some(re=>re.test(f))).slice(0,10).map(f=>({kind:'file',label:f,ref:f}));
  if (packageJson?.scripts) {
    for (const [name,command] of Object.entries(packageJson.scripts)) {
      if (!/^(start|dev|serve|build|test|package|dist|preview)$/i.test(name)) continue;
      found.push({kind:'script',label:`npm ${name}`,detail:String(command),ref:'package.json'});
    }
  }
  if (lowerMap.has('manage.py')) found.push({kind:'file',label:'manage.py',ref:'manage.py'});
  return unique(found, x=>`${x.kind}|${x.label}`).slice(0,12);
}

function detectVerification(files) {
  const result = [];
  const topDirs = new Set(files.map(f=>f.split('/')[0].toLowerCase()));
  for (const dir of ['test','tests','spec','specs','e2e','integration']) if (topDirs.has(dir)) result.push({name:'自动化测试',ref:`${dir}/`});
  for (const dir of [...topDirs]) if (/(eval|evaluation|benchmark|retrieval_eval|quality|audit)/i.test(dir)) result.push({name:'评测 / 质量控制',ref:`${dir}/`});
  if (files.some(f=>/^\.github\/workflows\//i.test(f))) result.push({name:'CI / 自动化工作流',ref:'.github/workflows/'});
  if (files.some(f=>/(pytest|vitest|jest|playwright|cypress|\.spec\.|\.test\.)/i.test(f))) result.push({name:'测试用例',ref:'测试文件'});
  return unique(result,x=>`${x.name}|${x.ref}`).slice(0,8);
}

function detectAssets(components) {
  return components.filter(c=>['data','knowledge','models','evaluation'].includes(c.kind)).map(c=>({name:c.name,type:c.label,ref:`${c.name}/`,fileCount:c.fileCount})).slice(0,10);
}

function detectDelivery(files, knownFiles, packageJson) {
  const result = [];
  if (knownFiles.some(x=>x.path.toLowerCase().includes('docker'))) result.push({name:'容器部署',ref:knownFiles.find(x=>x.path.toLowerCase().includes('docker'))?.path});
  if (files.some(f=>/^\.github\/workflows\//i.test(f))) result.push({name:'GitHub Actions 自动化',ref:'.github/workflows/'});
  if (files.some(f=>/^src-tauri\//i.test(f)) || knownFiles.some(x=>/tauri/i.test(x.label))) result.push({name:'Tauri 桌面应用',ref:'src-tauri/'});
  if (files.some(f=>/electron/i.test(f)) || knownFiles.some(x=>/electron/i.test(x.label))) result.push({name:'Electron 桌面应用',ref:'package.json'});
  if (packageJson?.scripts?.build) result.push({name:'构建脚本',ref:'package.json',detail:String(packageJson.scripts.build)});
  if (packageJson?.scripts?.package || packageJson?.scripts?.dist) result.push({name:'打包脚本',ref:'package.json',detail:String(packageJson.scripts.package || packageJson.scripts.dist)});
  return unique(result,x=>x.name).slice(0,8);
}

async function mapRepository(project) {
  const files = await trackedFiles(project.path);
  const packageJson = files.some(f=>f.toLowerCase()==='package.json') ? await readJson(path.join(project.path,'package.json')) : null;
  const pyproject = files.some(f=>f.toLowerCase()==='pyproject.toml') ? await readText(path.join(project.path,'pyproject.toml'),64*1024) : null;
  const components = detectComponents(files);
  const knownFiles = detectKnownFiles(files);
  return {
    scannedAt:new Date().toISOString(),
    fileCount:files.length,
    truncated:files.length>=MAX_FILES,
    languages:detectLanguages(files),
    components,
    manifests:knownFiles,
    entrypoints:detectEntrypoints(files,packageJson),
    coreAssets:detectAssets(components),
    verification:detectVerification(files),
    delivery:detectDelivery(files,knownFiles,packageJson),
    package:{
      name:packageJson?.name || null,
      description:packageJson?.description || null,
      scripts:packageJson?.scripts ? Object.keys(packageJson.scripts).slice(0,20) : [],
      dependencyCount:packageJson ? Object.keys({...packageJson.dependencies,...packageJson.devDependencies}).length : null
    },
    python: pyproject ? { hasPyproject:true } : { hasPyproject:false },
    evidence:{
      componentRefs:components.map(c=>c.evidence[0]),
      manifestRefs:knownFiles.map(x=>x.path)
    }
  };
}

export async function attachRepositoryMaps(projects) {
  for (const project of projects) {
    try { project.repositoryMap = await mapRepository(project); }
    catch (error) { project.repositoryMap = { error:error?.message || String(error), components:[], coreAssets:[], verification:[], delivery:[], entrypoints:[], languages:[] }; }
  }
  return projects;
}
