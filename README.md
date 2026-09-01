# Project Observer

本地优先的多项目状态与 AI 开发可观察性工具。目标不是替项目决定“下一步做什么”，而是尽可能忠实地恢复：**项目是什么、发生过什么、当前做到什么程度、哪些信息有证据支持，以及项目随着时间如何变化。**

## 当前版本 v0.3

已经具备：
- 扫描指定根目录下的多个 Git 仓库 / Project Observer 项目；
- 读取 Git branch、未提交文件、最近 commit 和近期历史；
- 读取可选 `.project-state.json` 作为显式状态；
- 从 README / docs / PLAN / TODO 等文档恢复摘要、清单和明确未完成项；
- 读取 Codex CLI 本地 Session，并按 Session 的 `cwd` 关联到项目；
- 将 Git commit 与 Codex 会话合并成“开发历程”；
- 在 `~/.project-observer/` 保存项目事实变化的观察历史；
- Self Monitor：Project Observer 自身与其他项目使用同一套规则。

暂时没有：
- LLM 二次总结 AI 会话；
- Claude / Cursor / 其他 Agent 适配；
- “AI 声称完成”与客观验证证据模型；
- 停止阶段自动恢复；
- 长期项目健康 / 复杂度趋势；
- 桌面软件打包。

## 运行

需要 Node.js 20+ 和 Git。

```bash
npm start
```

浏览器打开：

```text
http://127.0.0.1:4177
```

默认扫描 Project Observer 所在目录的父目录，也可以在页面填写其他项目根目录，例如：

```text
D:\Projects
```

## Codex 数据

默认只读：

```text
~/.codex/sessions/**/*.jsonl
```

Project Observer 当前只提取 Session 元数据、工作目录、时间和首条有效用户需求，用来恢复开发历程；不会修改 Codex 文件，也不会上传这些内容。

如 Codex Session 在其他目录，可以设置：

```text
CODEX_SESSIONS_DIR=D:\path\to\sessions
```

为了避免大型历史目录拖慢首次扫描，v0.3 默认只检查最近 250 个 Session 文件。可以通过 `PROJECT_OBSERVER_CODEX_MAX_SESSIONS` 调整。

## 观察历史

每次扫描会比较项目事实。只有事实发生变化时才追加记录，默认保存到：

```text
~/.project-observer/observations.jsonl
```

因此普通刷新不会不断生成重复快照。观察数据放在项目仓库之外，不会让被观察项目产生 Git 未提交改动。

## `.project-state.json`

显式状态仍然优先于自动恢复：

```json
{
  "name": "Example Project",
  "status": "active",
  "stage": "MVP",
  "goals": [
    { "id": "search", "title": "Search", "status": "done" },
    { "id": "export", "title": "Export", "status": "in_progress" }
  ]
}
```

如果 Codex 会话不是在仓库根目录启动（例如在外层工作区目录启动），可以在同一个文件的 `identity.pathAliases` 里登记该目录，让会话归属仍能命中当前项目：

```json
{
  "identity": {
    "projectKey": "git:github.com/kioooice/project-observer",
    "pathAliases": ["D:\\Projects\\Project State Model"]
  }
}
```

## 设计原则

- 不默认生成“下一步工作”；优先展示证据支持的事实和明确未完成项。
- “AI 说完成”与“经过测试/用户体验验证”必须逐步分开。
- 不给 Project Observer 自己写特殊规则；它必须能用同一套逻辑分析自身。
- 先建立可观察事实层，再逐步增加 AI 理解层。
- 项目开发周期越长、规模越大，越需要保存状态演变，而不是只看当前代码。
