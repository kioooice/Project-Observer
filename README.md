# Project Observer

Project Observer 是一个本地优先的**项目状态、项目记忆与项目理解工作台**。它的目标不是替项目决定“下一步做什么”，而是尽可能忠实地恢复：**项目是什么、由什么组成、发生过什么、当前做到哪里、哪些结论有证据支持，以及项目为什么会变成今天这样。**

## 当前版本 v0.10

当前主链路：

```text
项目库
→ Repository Map（仓库事实）
→ README / docs / Git / Codex / Project Memory
→ Evidence Map
→ Project Model
→ 项目概览 / 开发演进 / 项目记忆 / 证据
```

已经具备：
- 持久项目库：只加载用户明确加入的项目，不再默认扫描整个父目录；
- Git 状态、长历史、开发主题和项目演进阶段；
- Codex CLI / Desktop 会话读取与项目归属；
- README / docs / PLAN / TODO 等项目文档恢复；
- Repository Map：读取目录结构、Git 跟踪文件、入口、清单、测试/评测、数据资产与部署配置；
- Project Memory：持久保存决策、问题经验、约束、里程碑和未解决事项；
- Evidence Map：给项目理解结论建立证据编号；
- Project Model：恢复项目定位、系统组成、职责链、核心资产、验证方式、运行/交付形态和当前重点；
- 可选 LLM 语义综合：模型输出必须引用 Evidence Map 中存在的 evidence ID，否则结论不会被接受；
- 观察历史：项目事实发生变化时才追加记录；
- Self Monitor：Project Observer 自身与其他项目使用同一套规则。

尚未完成：
- Project Context Pack：给新的 Codex / Claude 会话直接提供压缩后的项目长期上下文；
- Claude / Cursor / 其他 Agent 适配；
- “AI 声称完成”与客观验证证据的系统化区分；
- 长期项目健康 / 开发退化趋势；
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

首次启动会自动把 Project Observer 自身加入项目库。之后在页面点击 **添加项目**，输入某个项目的准确目录，例如：

```text
D:\Projects\scholarscope-desktop
```

项目库保存在：

```text
~/.project-observer/projects.json
```

## Repository Map 与 Project Model

v0.10 不再假设 README 第一段就是完整项目说明。每个项目会先读取可验证的仓库事实，例如：

- 主要目录及职责；
- Git 跟踪文件；
- `package.json` / `pyproject.toml` / `requirements.txt` 等清单；
- 启动入口和构建脚本；
- tests / evaluation / benchmark / retrieval_eval 等验证体系；
- data / datasets / knowledge / models 等核心资产；
- Docker / GitHub Actions / Tauri / Electron 等运行和交付配置。

这些事实与 README、Git、Codex、Project Memory 一起进入 Evidence Map，再形成面向人的 Project Model。

## 可选语义模型

没有配置模型时，Project Observer 使用**结构事实理解**，功能仍可正常工作。

如果需要更强的语义综合，可以接入 OpenAI-compatible Chat Completions 接口：

```text
PROJECT_OBSERVER_LLM_BASE_URL=https://your-provider.example/v1
PROJECT_OBSERVER_LLM_API_KEY=your-key
PROJECT_OBSERVER_LLM_MODEL=your-model
```

默认不会自动调用模型。配置完成后，项目概览会出现 **用模型重新综合** 按钮，只对当前项目触发一次语义理解。

如确实希望每次项目证据变化后自动重新综合，可额外设置：

```text
PROJECT_OBSERVER_LLM_AUTO=1
```

模型并不能自由发挥。Project Observer 会给每条事实分配 `E001 / E002 ...` 证据 ID，模型生成的项目定位、系统组成、工作流、资产和限制必须引用实际存在的 evidence ID；没有有效证据的模型结论会被丢弃。

模型综合结果缓存于：

```text
~/.project-observer/project-understanding.json
```

## Project Memory

长期项目记忆默认保存在：

```text
~/.project-observer/project-memories.json
```

当前保存五类信息：
- 关键决策；
- 失败 / 问题经验；
- 长期约束；
- 里程碑；
- 未解决事项。

当前来源消失时不会直接删除历史；需要长期有效的记忆会降为“有效性待确认”，已达成里程碑和已解决问题继续作为历史保留。

## Codex 数据

Project Observer 会兼容：

```text
~/.codex/state_5.sqlite
~/.codex/sessions/**/*.jsonl
```

会话项目归属优先依据：人工绑定、Codex project root、Git remote、仓库路径和历史路径别名。

如果 Codex 从仓库外层工作区启动，可以在 `.project-state.json` 中登记路径别名：

```json
{
  "identity": {
    "projectKey": "git:github.com/example/project",
    "pathAliases": ["D:\\Projects\\workspace"]
  }
}
```

## 观察历史

只有项目事实实际发生变化时才追加：

```text
~/.project-observer/observations.jsonl
```

这些数据全部保存在被观察项目之外，不会让项目自身出现未提交文件。

## `.project-state.json`

显式状态仍然优先于自动理解。它适合保存项目明确知道、不能让模型猜测的状态、目标和身份信息。

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
- README 只是证据来源之一，不是项目真相本身。
- 代码目录、入口、数据、测试、评测、部署、Git、AI Session 和项目记忆共同构成项目认知。
- “AI 说完成”与“经过测试/用户体验验证”必须逐步分开。
- 不给 Project Observer 自己写特殊规则；它必须能用同一套逻辑分析自身。
- 项目越长期、越复杂，越应该保存“为什么变成这样”，而不仅是“现在有哪些文件”。
