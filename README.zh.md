# DeepSeek Harness

[English](README.md) | 中文

DeepSeek Harness（`dsh`）是由 [DeepSeek AI](https://deepseek.com) 开发的开源 agent harness（智能体框架）。

它采用**一切皆插件**的架构，并由 [Cordis](https://github.com/cordiverse/cordis) 驱动，其设计参见论文 [_A Programming Paradigm for Spatiotemporal Composability_](https://github.com/cordiverse/paper)。

## 开发者预览

DeepSeek Harness 目前处于 _开发者预览_ 阶段，正在快速迭代。**未来将出现破坏兼容性的变更。**

## 终端 UI（本 fork）

本 fork 为 DeepSeek Harness 新增了交互式**终端 UI**，基于 [Ink](https://github.com/vadimdemedes/ink) 构建，交互风格对标 Claude Code。它是默认表层：直接输入 `dsh` 即可启动。

### 定位

TUI 是原生 harness 之上的一层薄表层：agent 循环、工具、审批、会话持久化、settings 与 credentials 全部来自未改动的 `dsh-base` 插件栈。它与 Web UI 及其他 profile 共享同一个 `~/.dsh`——一份配置、一份凭证、一份会话历史，两个表层通用。核心包零改动；TUI 由 [`packages/tui/app`](packages/tui/app/README.md)、一个 bundle patch 和已注册的 `tui` profile 组成。

### 功能

- **流式会话记录** —— `assistant/chunk` 增量实时渲染；恢复会话时重放持久化日志，历史始终完整。
- **通用工具卡片** —— 每对 `tool/call` / `tool/result` 渲染为一张卡片（名称、参数摘要、结果预览）；任何第三方插件贡献的工具都无需 TUI 侧适配即可显示。
- **审批浮层** —— 用 `y`（允许一次）/ `n`（拒绝）/ `a`（本会话总是允许）回答工具审批问题；问题打开期间输入框仍可编辑。
- **斜杠命令菜单** —— 输入 `/` 打开 fuzzy 匹配菜单，列出所有已注册命令（内置与插件贡献的），支持 ↑↓ 选择、Tab 补全、Enter 执行。
- **交互式选择器** —— `/resume` 打开可 fuzzy 过滤的会话选择器；`/model` 打开模型目录选择器；两者都支持参数补全（如 `/permission ` 列出预置项）。
- **快捷继续** —— `dsh -c` 恢复当前目录最新会话，自动跳过日志不可读的会话。

### 环境要求

- **Node.js 24+**（仓库要求 `^22.19.0 || >=24`；brew 的 keg-only `node@24` 可用：`export PATH="/opt/homebrew/opt/node@24/bin:$PATH"`）。
- **pnpm** —— 由 corepack 解析（`export COREPACK_ENABLE_DOWNLOAD_PROMPT=0` 跳过确认提示）。

### 快速开始

```sh
git clone https://github.com/lertian/dsh-tui.git
cd dsh-tui
pnpm install
pnpm run build
node apps/cli/lib/bin.js
```

日常使用建议加个别名（指向构建产物，与 `pnpm run build` 保持同步）：

```sh
alias dsh='/opt/homebrew/opt/node@24/bin/node /path/to/dsh-tui/apps/cli/lib/bin.js'
```

### 命令

| 命令 | 作用 |
|---|---|
| `dsh` | 启动全新交互会话（tui 是默认 profile） |
| `dsh -c` | 继续当前目录最新可读会话 |
| `dsh --resume <id>` | 恢复指定持久化会话 |
| `dsh --profile headless "task"` | 一次性非交互任务；打印结果后退出 |
| `dsh web` | Web UI——同一个 `~/.dsh`、同一份会话 |
| `dsh plugin --profile tui add <pkg>` | 向 TUI profile 安装第三方 Cordis 插件 |

### UI 内按键

| 按键 | 作用 |
|---|---|
| `Enter` | 提交输入 |
| `Shift+Enter` / `Ctrl+J` | 换行 |
| `/` | 打开 fuzzy 斜杠命令菜单（↑↓ 选择，Tab 补全，Enter 执行，Esc 关闭） |
| `/resume`、`/model`、`/permission ` | 打开交互式选择器 / 参数补全 |
| `Esc` | 关闭菜单与选择器（不会取消 turn） |
| `Ctrl+C` | 冲刷会话并退出 |
| `y` / `n` / `a` | 回答审批浮层 |

### 配置与插件

- 一切都在 `~/.dsh` 下（可用 `$DSH_HOME` 覆盖）：`settings.yaml`（模型/提供方、base URL）、`.credentials.yaml`（API key，如 `DEEPSEEK_API_KEY`）、`sessions/`（历史）、`profiles/`（各 profile 插件层）。
- Web UI 与 TUI 读取同一批文件——切换表层不会拆分你的配置或历史。
- 第三方插件就是普通 Cordis 插件：`dsh plugin --profile tui add <package>` 自动挂载其工具与斜杠命令。

### 排障

- **`dsh tui: an interactive terminal (TTY) is required`** —— TUI 需要真实终端；请在终端里运行，不要在管道或 CI 里跑。
- **没有 API key / `MISSING_CREDENTIAL`** —— 把 key 放进 `~/.dsh/.credentials.yaml` 或环境变量（`DEEPSEEK_API_KEY=... dsh`）。
- **`dsh -c` 开了新会话** —— 该目录没有可读会话（或最近几个日志损坏；TUI 会自动跳过）。
- **模型显示 `deepseek-official/deepseek-official/...`** —— 旧版补全 bug 导致；升级到最新构建即可。

完整功能列表与架构说明见 [TUI 包 README](packages/tui/app/README.md)。

## 运行

### 通过 `npm` 运行

安装 `Node.js`，然后运行：

```sh
npx @deepseek-ai/dsh web
```

该命令会启动 Web UI，默认地址为 `http://127.0.0.1:3080`。详见 [Web UI 指南](docs/user/guide/index.md)。

### 从源码运行

如需从仓库源码运行：

```sh
git clone https://github.com/deepseek-ai/deepseek-harness.git
cd deepseek-harness
pnpm install
pnpm run build
pnpm dsh web
```

## 社区与支持

- 欢迎通过 [GitHub Discussions](https://github.com/deepseek-ai/deepseek-harness/discussions) 提交反馈或 bug 报告。
- 为你的插件仓库添加 [`dsh-plugin`](https://github.com/topics/dsh-plugin) 话题，便于被发现。
- 欢迎加入 DeepSeek Harness 企微群：扫码添加企微小助手并填写入群问卷，完成后小助手会邀请你入群。

<table>
  <thead>
    <tr>
      <th align="center">企微小助手</th>
      <th align="center">入群问卷</th>
      <th align="center">微信公众号</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td align="center"><img src="assets/community-wecom-assistant.png" alt="DeepSeek Harness 企微小助手二维码" width="180" height="180"></td>
      <td align="center"><a href="https://trtgsjkv6r.feishu.cn/share/base/form/shrcnIt5twSVdLGD52KJBckGCgg"><img src="assets/community-wecom-survey.png" alt="DeepSeek Harness 入群问卷二维码" width="180" height="180"></a></td>
      <td align="center"><img src="assets/community-wechat-official-account.png" alt="DeepSeek Harness 团队微信公众号二维码" width="180" height="180"></td>
    </tr>
  </tbody>
</table>

## 参与贡献

参见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 开发

请先阅读[开发指南](docs/development.md)与[架构文档](docs/architecture.md)。

面向 agent：请遵循 [AGENTS.md](AGENTS.md)。

## 许可证

[MIT](LICENSE)

第三方依赖及其许可证见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
