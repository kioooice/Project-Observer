# Project Observer

本地优先的多项目状态与 AI 开发可观察性工具。第一版先解决一件事：**打开后立刻看到多个本地项目当前是什么状态，并让 Project Observer 从第一天开始分析自己。**

## 当前版本 v0.1

已经具备：
- 扫描指定根目录下的多个 Git 仓库 / Project Observer 项目；
- 自动读取 Git branch、未提交文件数、最近 commit 和近期历史；
- 读取可选 `.project-state.json` 作为显式项目状态；
- 显示项目卡片、声明目标进度、当前阶段和项目详情；
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

## `.project-state.json`

v0.1 先允许项目用一个很薄的状态文件声明“我们明确知道的事实”。后续自动分析会逐步接管，但显式信息仍然优先于 AI 猜测。

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
- 第一版先建立雏形并开始 dogfooding，再逐层接 Git / 文档 / Agent Session / 验证与健康模型。
