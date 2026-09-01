# Project Observer

本地优先的多项目状态与 AI 开发可观察性工具。目标不是替用户规划项目，而是尽可能忠实地恢复：**项目是什么、做到哪里、经历过什么、哪些状态有证据、为什么停在这里。**

## 当前版本 v0.2

已经具备：
- 扫描指定根目录下的多个 Git 仓库 / Project Observer 项目；
- 自动读取 Git branch、未提交文件数、最近 commit 和近期历史；
- 读取可选 `.project-state.json` 作为显式项目状态；
- 自动读取 `README / docs / PLAN / TODO / STATUS / HANDOFF / package.json` 等项目文档；
- 从 README 恢复项目名称和摘要；
- 从 Markdown checklist 恢复明确目标、完成项和未完成项；
- 在界面中显示信息来源和“信息覆盖”，避免把自动恢复结果伪装成确定事实；
- 显式状态始终优先于自动恢复；
- Self Monitor：本项目自身使用和其他项目完全相同的分析逻辑。

暂时没有：
- LLM 项目理解；
- Codex / Claude Session 导入；
- 验证证据模型；
- 停止阶段自动恢复；
- 项目健康 / 复杂度趋势；
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

默认扫描 Project Observer 所在目录的父目录。也可以在页面输入其他根目录，例如：

```text
D:\Projects
```

## 自动恢复规则（v0.2）

v0.2 只做保守恢复：

1. `.project-state.json` 是最高优先级的显式状态；
2. 缺少显式名称/摘要时，读取 README 和 `package.json`；
3. 读取项目根目录常见状态文档和 `docs/` 下的 Markdown/TXT；
4. Markdown 中的 `- [x]` / `- [ ]` 被视为明确完成/未完成清单；
5. 没有证据时，不自动判断项目阶段，不生成“下一步工作”。

## `.project-state.json`

它用于声明“我们明确知道的事实”，后续自动分析会逐步补充它，而不是覆盖它。

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

## 设计原则

- 不默认生成“下一步工作”；优先展示证据支持的事实和明确未完成项。
- “AI 说完成”与“经过测试/用户体验验证”未来必须区分。
- 不给 Project Observer 自己写特殊规则；它必须能用同一套逻辑分析自身。
- 先建立事实层，再逐层接文档理解、Agent Session、验证与长期项目健康模型。
