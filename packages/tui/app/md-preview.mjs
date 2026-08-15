// 终端 Markdown 渲染预览：`node md-preview.mjs`（在真实终端里跑，看颜色）
import { createElement } from 'react'
import { render } from 'ink'
import { MarkdownText } from './lib/types/ui/Markdown.js'

const sample = [
  '# 安装步骤',
  '',
  '请先安装 **Node.js 24** 或更新版本，然后运行：',
  '',
  '`npm install -g dsh`',
  '',
  '- 支持 DeepSeek 官方 API',
  '- 支持 pi-ai 多提供方',
  '- 支持自定义模型',
  '',
  '> 提示：配置文件在 `~/.dsh/settings.yaml`',
  '',
  '```ts',
  '// 初始化客户端',
  "const client = new Dsh({ model: 'g-deepseek-v4-pro' })",
  'function greet(name: string): string {',
  '  return `你好，${name}!`',
  '}',
  '```',
  '',
  '```bash',
  'dsh "帮我修这个 bug"',
  'ls -la ~/.dsh',
  '```',
  '',
  '| 名称 | 用途 | 默认值 |',
  '| --- | --- | --- |',
  '| model | 模型 id | g-deepseek-v4-pro |',
  '| maxTokens | 输出上限 | 8192 |',
  '| thinking | 思考档位 | high |',
  '',
  '最后一行**收尾**。',
].join('\n')

const { waitUntilExit } = render(createElement(MarkdownText, { text: sample }))
waitUntilExit().then(() => process.exit(0))
