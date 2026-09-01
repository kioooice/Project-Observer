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
  release: '发布流程', state: '项目状态', project: '项目状态', codex: 'AI 开发记录', identity: '项目身份',
  test: '测试验证', data: '数据处理', auth: '权限与账号', deploy: '部署交付'
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
    ['build', /(build|package|打包)/], ['docs', /(docs|readme|文档)/], ['api', /(api|server|接口)/],
    ['test', /(test|spec|验证|测试)/], ['data', /(data|dataset|数据)/], ['auth', /(auth|login|账号|权限)/],
    ['deploy', /(deploy|deployment|上线|部署)/], ['ui', /(ui|layout|style|页面|界面)/], ['engine', /(engine|worker|引擎)/]
  ];
  return rules.find(([, re]) => re.test(text))?.[0] || null;
}

function classifyCommit(commit) {
  const parsed = parseCommit(commit.subject);
  const scope = parsed.scope || inferScope(parsed.message || '');
  return {
    ...commit,
    parsed,
    scope,
    themeKey: scope || parsed.type || 'other',
    themeLabel: SCOPE_LABELS[scope] || TYPE_LABELS[parsed.type] || '其他开发',
    typeLabel: TYPE_LABELS[parsed.type] || null
  };
}

function buildActivityThemes(commits = []) {
  const buckets = new Map();
  for (const commit of commits.slice(0, 24).map(classifyCommit)) {
    const key = commit.themeKey;
    const bucket = buckets.get(key) || { key, label: commit.themeLabel, count: 0, latestAt: null, types: new Set(), samples: [] };
    bucket.count += 1;
    if (!bucket.latestAt || String(commit.date || '') > String(bucket.latestAt)) bucket.latestAt = commit.date || null;
    if (commit.parsed.type) bucket.types.add(commit.parsed.type);
    if (commit.parsed.message && bucket.samples.length < 3) bucket.samples.push(commit.parsed.message);
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

function dayKey(iso) {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

function dateGapDays(a, b) {
  const left = new Date(a).getTime();
  const right = new Date(b).getTime();
  if (!Number.isFinite(left) || !Number.isFinite(right)) return Infinity;
  return Math.abs(left - right) / 86400000;
}

function dominantThemes(commits, limit = 3) {
  const counts = new Map();
  for (const commit of commits) {
    const key = commit.themeKey;
    const item = counts.get(key) || { key, label: commit.themeLabel, count: 0 };
    item.count += 1;
    counts.set(key, item);
  }
  return [...counts.values()].sort((a, b) => b.count - a.count).slice(0, limit);
}

function typeCounts(commits) {
  const result = new Map();
  for (const commit of commits) {
    const type = commit.parsed.type || 'other';
    result.set(type, (result.get(type) || 0) + 1);
  }
  return result;
}

function phaseLabel(commits) {
  const themes = dominantThemes(commits, 2);
  const types = typeCounts(commits);
  const total = Math.max(1, commits.length);
  const main = themes[0]?.label || '项目功能';
  const secondary = themes[1]?.label;
  const themeText = secondary && themes[1].count >= Math.max(2, Math.ceil(total * 0.2)) ? `${main}与${secondary}` : main;

  if ((types.get('fix') || 0) / total >= 0.5) return `集中修复${themeText}`;
  if ((types.get('refactor') || 0) / total >= 0.45) return `整理${themeText}`;
  if (((types.get('build') || 0) + (types.get('ci') || 0)) / total >= 0.45) return `形成${themeText}交付链路`;
  if ((types.get('feat') || 0) / total >= 0.5) return `扩展${themeText}`;
  return `推进${themeText}`;
}

function summarizePhase(commits) {
  const messages = unique(commits.map(commit => commit.parsed.message || commit.subject), 3);
  return messages;
}

function buildEvolution(history = []) {
  const classified = [...history]
    .filter(commit => commit.date)
    .map(classifyCommit)
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));
  if (!classified.length) return [];

  const dayBuckets = [];
  for (const commit of classified) {
    const key = dayKey(commit.date);
    if (!key) continue;
    let bucket = dayBuckets.at(-1);
    if (!bucket || bucket.key !== key) {
      bucket = { key, startAt: commit.date, endAt: commit.date, commits: [] };
      dayBuckets.push(bucket);
    }
    bucket.commits.push(commit);
    if (String(commit.date) < String(bucket.startAt)) bucket.startAt = commit.date;
    if (String(commit.date) > String(bucket.endAt)) bucket.endAt = commit.date;
  }

  const phases = [];
  for (const day of dayBuckets) {
    const current = phases.at(-1);
    const dayThemes = new Set(dominantThemes(day.commits, 3).map(item => item.key));
    if (!current) {
      phases.push({ startAt: day.startAt, endAt: day.endAt, commits: [...day.commits], themeKeys: dayThemes });
      continue;
    }

    const gap = dateGapDays(current.endAt, day.startAt);
    const overlap = [...dayThemes].some(key => current.themeKeys.has(key));
    const weakSignal = current.commits.length < 3 || day.commits.length < 2;
    if (gap <= 2.2 && (overlap || weakSignal)) {
      current.endAt = day.endAt;
      current.commits.push(...day.commits);
      for (const key of dayThemes) current.themeKeys.add(key);
    } else {
      phases.push({ startAt: day.startAt, endAt: day.endAt, commits: [...day.commits], themeKeys: dayThemes });
    }
  }

  while (phases.length > 8) {
    let bestIndex = 0;
    let smallest = Infinity;
    for (let i = 0; i < phases.length - 1; i += 1) {
      const score = phases[i].commits.length + phases[i + 1].commits.length + dateGapDays(phases[i].endAt, phases[i + 1].startAt);
      if (score < smallest) { smallest = score; bestIndex = i; }
    }
    const left = phases[bestIndex];
    const right = phases[bestIndex + 1];
    phases.splice(bestIndex, 2, {
      startAt: left.startAt,
      endAt: right.endAt,
      commits: [...left.commits, ...right.commits],
      themeKeys: new Set([...left.themeKeys, ...right.themeKeys])
    });
  }

  return phases.map((phase, index) => {
    const themes = dominantThemes(phase.commits, 3);
    return {
      index: index + 1,
      label: phaseLabel(phase.commits),
      startAt: phase.startAt,
      endAt: phase.endAt,
      commitCount: phase.commits.length,
      themes: themes.map(item => item.label),
      workTypes: [...typeCounts(phase.commits).entries()]
        .filter(([type]) => type !== 'other')
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([type, count]) => ({ label: TYPE_LABELS[type] || type, count })),
      summary: summarizePhase(phase.commits),
      firstHash: phase.commits[0]?.shortHash || null,
      lastHash: phase.commits.at(-1)?.shortHash || null
    };
  }).reverse();
}

function latestActivityDate(project) {
  return project.git?.historyCommits?.[0]?.date || project.git?.recentCommits?.[0]?.date || project.git?.latestCommit?.date || null;
}

function firstActivityDate(project) {
  const history = project.git?.historyCommits || [];
  return history.at(-1)?.date || null;
}

function daysSince(iso) {
  if (!iso) return null;
  const value = new Date(iso).getTime();
  if (!Number.isFinite(value)) return null;
  return Math.max(0, Math.floor((Date.now() - value) / 86400000));
}

function activityState(latestAt) {
  const age = daysSince(latestAt);
  if (age == null) return { label: '暂无可判断的开发活跃度', ageDays: null, level: 'unknown' };
  if (age <= 3) return { label: '正在持续开发', ageDays: age, level: 'active' };
  if (age <= 14) return { label: '近期持续开发', ageDays: age, level: 'recent' };
  if (age <= 30) return { label: '近期有开发活动', ageDays: age, level: 'recent' };
  if (age <= 60) return { label: `已有 ${age} 天没有开发`, ageDays: age, level: 'quiet' };
  return { label: `已连续 ${age} 天没有开发`, ageDays: age, level: 'stale' };
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
    const evolution = buildEvolution(project.git?.historyCommits || project.git?.recentCommits || []);
    const latestAt = latestActivityDate(project);
    const activity = activityState(latestAt);
    const latestPhase = evolution[0] || null;
    const openGoals = (project.goals || []).filter(goal => !['done', 'completed'].includes(goal.status));

    project.insight = {
      stateLabel: stateLabel(project, capabilities, deliveries),
      shape: currentShape(deliveries, capabilities),
      capabilities,
      limitations,
      deliveryForms: deliveries,
      qualitySignals: quality,
      recentThemes: themes,
      evolution,
      activity,
      latestPhase,
      lastFocusLabel: latestPhase?.label || null,
      stopPoint: activity.ageDays != null && activity.ageDays > 30 && latestPhase
        ? `最后停留在：${latestPhase.label}`
        : null,
      recentFocus: activity.ageDays != null && activity.ageDays <= 30 && latestPhase
        ? `最近推进：${latestPhase.label}`
        : null,
      historyCommitCount: project.git?.historyCommits?.length || project.git?.recentCommits?.length || 0,
      historyTruncated: Boolean(project.git?.historyTruncated),
      firstActivityAt: firstActivityDate(project),
      openGoals: openGoals.slice(0, 8),
      reliableProgress: project.progressSource === 'explicit' ? project.declaredProgress : null,
      progressBasis: project.progressSource === 'explicit' ? '显式项目目标' : null,
      latestActivityAt: latestAt,
      sourceSummary: [
        project.summarySource ? `项目说明：${project.summarySource}` : null,
        capabilities.length || limitations.length || deliveries.length ? '项目现状：README 结构化章节' : null,
        themes.length ? '近期主题：Git 提交历史' : null,
        evolution.length ? `项目演进：${project.git?.historyCommits?.length || project.git?.recentCommits?.length || 0} 条 Git 历史` : null
      ].filter(Boolean)
    };
  }
  return projects;
}
