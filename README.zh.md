# DeepSeek Harness

[English](README.md) | 中文

DeepSeek Harness（`dsh`）是由 [DeepSeek AI](https://deepseek.com) 开发的开源 agent harness（智能体框架）。

它采用**一切皆插件**的架构，并由 [Cordis](https://github.com/cordiverse/cordis) 驱动，其设计参见论文 [_A Programming Paradigm for Spatiotemporal Composability_](https://github.com/cordiverse/paper)。

## 开发者预览

DeepSeek Harness 目前处于 _开发者预览_ 阶段，正在快速迭代。**未来将出现破坏兼容性的变更。**

## 终端 UI（本 fork）

本 fork 为 DeepSeek Harness 新增了交互式**终端 UI**，基于 [Ink](https://github.com/vadimdemedes/ink) 构建，交互风格对标 Claude Code。

**定位。** TUI 是原生 harness 之上的一层薄表层：agent 循环、工具、审批、会话持久化、settings 与 credentials 全部来自未改动的 `dsh-base` 插件栈。它与 Web UI 及其他 profile 共享同一个 `~/.dsh`——一份配置、一份凭证、一份会话历史，两个表层通用。核心包零改动；TUI 由 [`packages/tui/app`](packages/tui/app/README.md)、一个 bundle patch 和已注册的 `tui` profile 组成。

**能力。** 流式会话记录、通用工具调用卡片、审批浮层（`y` / `n` / `a`）、`/` fuzzy 命令菜单、`/resume` 与 `/model` 交互式选择器、参数补全（含 `/permission`），以及 `dsh -c` 继续当前目录最近一次会话。通过 `dsh plugin --profile tui add <package>` 安装的第三方 Cordis 插件会自动贡献其工具与斜杠命令。

### 使用方式

```sh
git clone https://github.com/lertian/dsh-tui.git
cd dsh-tui
pnpm install
pnpm run build        # Node 24, pnpm via corepack
node apps/cli/lib/bin.js
```

```sh
dsh                    # fresh session (tui is the default profile)
dsh -c                 # continue the newest session in this directory
dsh --resume <id>      # reopen a specific persisted session
dsh --profile headless "run the tests"   # one-shot, non-interactive
dsh web                # the Web UI, same ~/.dsh
```

UI 内按键：Enter 提交；输入 `/` 打开命令菜单（↑↓ 选择，Tab 补全，Enter 执行）；`/resume` 与 `/model` 打开 fuzzy 选择器；Esc 关闭菜单与选择器；Ctrl+C 退出。完整功能列表与架构说明见 [TUI 包 README](packages/tui/app/README.md)。

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
