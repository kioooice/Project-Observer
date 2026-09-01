const HEADING = {
  capabilities: /(当前范围|核心功能|主要功能|功能范围|已有能力|当前能力|features|what it does|capabilit)/i,
  limitations: /(当前限制|已知限制|限制|known issues|limitations|known limitations)/i,
  delivery: /(windows.*便携|便携包|便携版|linux.*web|web.*包|部署|发布|安装|distribution|deployment|release|package)/i,
  quality: /(质量检查|测试|验证|quality|test|verification)/i
};

const SCOPE_LABELS = {
  download: '下载链路', search: '检索体验', settings: '设置与配置', portable: 'Windows 便携版',
  web: 'Web 与来源展示', ci: '构建与发布', docs: '文档与发布流程', engine: '内部引擎',
  api: '接口与服务', ui: '界面体验', frontend: '界面体验', desktop: '桌面应用', build: '构建与打包',
  release: '发布流程', state: '项目状态', project: '项目状态', codex: 'AI 开发记录', identity: '项目身份'
};

const TYPE_LABELS = {
  feat: '新增能力', fix: '问题修复', refactor: '结构调整', build: '构建发布', ci: '自动化与发布',
  docs: '文档完善', test: '测试验证', chore: '工程维护'
};

function clean(value, limit = 180) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return null;
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function unique(items, limit = 12) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const value = clean(item, 220);
    if (!value) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
    if (out.length >= limit) break;
  }
  return out;
}

function sectionsMatching(sections, pattern) {
  return (sections || []).filter(section => pattern.test(String(section.heading || '')));
}

function sectionItems(sections, pattern, limit) {
  const items = [];
  for (const section of sectionsMatching(sections, pattern)) {
    items.push(...(section.bullets || []));
    if (!section.bullets?.length) items.push(...(section.paragraphs || []));
  }
  return unique(items, limit);
}

function deliveryForms(sections) {
  const result = [];
  for (const section of sectionsMatching(sections, HEADING.delivery)) {
    const heading = clean(section.heading, 80);
    const detail = clean((section.paragraphs || [])[0] || (section.bullets || [])[0], 180);
    if (!heading) continue;
    if (!/(便携|windows|linux|web|部署|发布|安装|包|release|deploy|package)/i.test(`${heading} ${detail || ''}`)) continue;
    result.push({ name: heading, detail });
  }
  return result.slice(0, 6);
}

function parseCommit(subject = '') {
  const text = String(subject || '').trim();
  const conventional = text.match(/^(feat|fix|refactor|build|docs|chore|test|ci)(?:\(([^)]+)\))?:\s*(.+)$/i);
  if (conventional) return { type: conventional[1].toLowerCase(), scope: conventional[2]?.toLowerCase() || null, message: clean(conventional[3], 140) };
  return { type: null, scope: null, message: clean(text, 140) };
}

function inferScope(message = '') {
  const text = message.toLowerCase();
  const rules = [
    ['download', /(download|pdf|下载)/], ['search', /(search|title match|检索|搜索)/], ['settings', /(settings|配置|设置)/],
    ['portable', /(portable|runtime|exe|便携)/], ['web', /(web|source|来源)/], ['ci', /(ci|actions|workflow)/],
    ['build', /(build|package|打包)/], ['docs', /(docs|readme|文档)/], ['api', /(api|server|接口)/]
  ];
  return rules.find(([, re]) => re.test(text))?.[0] || null;
}

function buildActivityThemes(commits = []) {
  const buckets = new Map();
  for (const commit of commits.slice(0, 24)) {
    const parsed = parseCommit(commit.subject);
    const scope = parsed.scope || inferScope(parsed.message || '');
    const key = scope || parsed.type || 'other';
    const label = SCOPE_LABELS[scope] || TYPE_LABELS[parsed.type] || '其他开发';
    const bucket = buckets.get(key) || { key, label, count: 0, latestAt: null, types: new Set(), samples: [] };
    bucket.count += 1;
    if (!bucket.latestAt || String(commit.date || '') > String(bucket.latestAt)) bucket.latestAt = commit.date || null;
    if (parsed.type) bucket.types.add(parsed.type);
    if (parsed.message && bucket.samples.length < 3) bucket.samples.push(parsed.message);
    buckets.set(key, bucket);
  }
  return [...buckets.values()]
    .sort((a, b) => String(b.latestAt || '').localeCompare(String(a.latestAt || '')) || b.count - a.count)
    .slice(0, 6)
    .map(item => ({
      label: item.label,
      count: item.count,
      latestAt: item.latestAt,
      kind: [...item.types].map(type => TYPE_LABELS[type]).filter(Boolean).join(' / ') || null,
      samples: unique(item.samples, 3)
    }));
}

function latestActivityDate(project) {
  return project.git?.recentCommits?.[0]?.date || project.git?.latestCommit?.date || null;
}

function daysSince(iso) {
  if (!iso) return null;
  const value = new Date(iso).getTime();
  if (!Number.isFinite(value)) return null;
  return Math.floor((Date.now() - value) / 86400000);
}

function stateLabel(project, capabilities, deliveries) {
  if (project.status === 'paused') return '项目已暂停，现有成果仍可恢复';
  if (project.status === 'completed') return '当前目标已完成';
  if (project.status === 'abandoned') return '项目已停止维护';
  const age = daysSince(latestActivityDate(project));
  if (deliveries.length && capabilities.length >= 3) {
    if (age != null && age <= 14) return '核心功能已成型，近期仍在持续完善';
    if (age != null && age > 45) return '已有可用形态，近期没有明显开发活动';
    return '已经形成可运行/可交付形态';
  }
  if (capabilities.length >= 3) return '主要功能已经形成，仍在开发完善';
  if ((project.git?.recentCommits || []).length) return '项目处于开发阶段';
  return '项目信息不足，暂时无法判断成熟度';
}

function currentShape(deliveries, capabilities) {
  if (deliveries.length) return deliveries.map(item => item.name).slice(0, 3).join(' + ');
  if (capabilities.length) return `已恢复 ${capabilities.length} 项明确能力`;
  return null;
}

export function attachProjectInsights(projects) {
  for (const project of projects) {
    const sections = project.recovery?.readmeSections || [];
    const capabilities = sectionItems(sections, HEADING.capabilities, 10);
    const limitations = sectionItems(sections, HEADING.limitations, 8);
    const quality = sectionItems(sections, HEADING.quality, 6);
    const deliveries = deliveryForms(sections);
    const themes = buildActivityThemes(project.git?.recentCommits || []);
    const openGoals = (project.goals || []).filter(goal => !['done', 'completed'].includes(goal.status));
    project.insight = {
      stateLabel: stateLabel(project, capabilities, deliveries),
      shape: currentShape(deliveries, capabilities),
      capabilities,
      limitations,
      deliveryForms: deliveries,
      qualitySignals: quality,
      recentThemes: themes,
      openGoals: openGoals.slice(0, 8),
      reliableProgress: project.progressSource === 'explicit' ? project.declaredProgress : null,
      progressBasis: project.progressSource === 'explicit' ? '显式项目目标' : null,
      latestActivityAt: latestActivityDate(project),
      sourceSummary: [
        project.summarySource ? `项目说明：${project.summarySource}` : null,
        capabilities.length || limitations.length || deliveries.length ? '项目现状：README 结构化章节' : null,
        themes.length ? '近期主题：Git 提交历史' : null
      ].filter(Boolean)
    };
  }
  return projects;
}
