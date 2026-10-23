# MarkIndex

**面向 Agent 的无向量、结构优先的长篇 Markdown 文档库检索。**

MarkIndex 把每篇 Markdown 按其自身章节解析成树，把树、原文行和中英混排 BM25 索引存进一个 SQLite 文件，
再给 Agent 提供 5 个只读工具，沿"库 → 文件夹 → 文档 → 章节"逐层导航，并带行号读取原文。
不用 embedding、不用向量库、不靠猜测切块；文档自身的结构就是索引，每条证据都能回溯到 `路径:L起-止`。

> 受 [VectifyAI/PageIndex](https://github.com/VectifyAI/PageIndex) 启发，MarkIndex 是一个独立、非官方的
> TypeScript 实现，专注 Markdown；与 VectifyAI 无隶属或背书关系。

English: [README.md](README.md)

## 为什么

- **结构优先**：长篇专业文档（年报、临床指南、法规、手册）本来就有作者组织好的目录；沿目录导航保留上下文、可解释、可引用。
- **建索引确定、不调 LLM**：mdast 解析、建树、token 成本模型优化都不调模型，同一输入结果逐字节一致。LLM 只用于可选的节点摘要、文档描述和内置 `retrieve()`。
- **认真处理 Markdown**：Setext 标题、首个标题前的前言、无标题文档、frontmatter、代码块里的 `#`、标题跳级、BOM/CRLF；每一行原文都恰好属于一个节点，过大的章节按块边界确定性拆成 `chunk` 节点。
- **中文可用的关键词兜底**：基于 `Intl.Segmenter` 分词的 BM25（中文、英文、中英混排，`C++`、`ISO-27001`、`v2.1` 这类标识符），另有 trigram 子串索引补位。
- **响应有预算**：工具从不抛异常，返回带 `next_steps` 指引的 JSON 信封，单次响应不超过 95 000 字符，大目录与长章节自动分段。

## 安装

```bash
npm install markindex          # 库 + CLI（Node.js >= 20）
```

只有用到 LLM 功能（摘要、`retrieve()`、agent 模式评测）时才需要安装对应的 AI SDK provider，例如 `npm install @ai-sdk/anthropic`，并设置 `ANTHROPIC_API_KEY`。

## CLI

```bash
markindex index ./docs                                                       # 建立 / 增量更新索引（<root>/.markindex/index.db）
markindex index ./docs --summary-model anthropic:claude-sonnet-5-5 --estimate # 只估算摘要成本，不调 LLM
markindex tree ./docs 指南/安装.md --depth 3                                  # 查看一篇文档的章节树
markindex search ./docs "离职 补偿" --limit 5 --json                          # 关键词检索
markindex mcp ./docs                                                         # 以 MCP server（stdio，只读）提供给 Agent
markindex eval ./docs --questions questions.jsonl --mode bm25 --out report.json
markindex eval ./docs --questions questions.jsonl --mode agent --model anthropic:claude-sonnet-5-5 --out report.json
```

## 库用法

```ts
import { generateText, stepCountIs } from 'ai'
import { anthropic } from '@ai-sdk/anthropic'
import { AGENT_INSTRUCTIONS, createAiSdkTools, openLibrary, retrieve } from 'markindex'

const writer = openLibrary({ root: './docs', readonly: false })
await writer.index()
writer.close()

const lib = openLibrary({ root: './docs' })
await lib.callTool('search_documents', { query: '劳动合同 解除' }) // JSON 信封字符串

// 方式一：你的 Agent 自己调用工具
await generateText({ model: anthropic('claude-sonnet-5-5'), system: AGENT_INSTRUCTIONS, tools: createAiSdkTools(lib), stopWhen: stepCountIs(15), prompt: '员工辞职需要提前多久通知？' })

// 方式二：内置检索循环，只返回原文证据（按行号从索引回读），不生成答案
const { evidence } = await retrieve(lib, '员工辞职需要提前多久通知？', { model: anthropic('claude-sonnet-5-5') })
```

## 接入 MCP

先 `npx markindex index /path/to/docs`，然后：

- Claude Code：`claude mcp add markindex -- npx markindex mcp /path/to/docs`
- Cursor（`~/.cursor/mcp.json`）：

```json
{ "mcpServers": { "markindex": { "command": "npx", "args": ["markindex", "mcp", "/path/to/docs"] } } }
```

## 工具

`browse_documents`（按文件夹浏览，默认发现入口）、`get_document`（元数据与是否需要先看结构）、
`get_document_structure`（不含正文的章节树，默认 2 层，可只展开某节点）、`get_node_content`（带行号原文，长节点分段）、
`search_documents`（BM25 + trigram 兜底，可限定文件夹或文档）。

## 设计要点

- 树优化移植 PageIndex `tree_optimize.py` 的成本模型（页 → token）：读整棵子树不比路由更贵就合并（`S(v) <= tree_cost(v)`，路由成本 150 token），被合并的标题保留为 `keyItems`；自身正文超过 8 000 token 的节点按块边界拆成 `chunk`。成本模型归功于 PageIndex。
- 只索引节点自身正文，父子节点不会因同一段文字重复命中；标题权重 10、合并标题 5、摘要 2、正文 1。
- 工具契约只有一份（zod），AI SDK 适配、MCP server 与 `retrieve()` 都是它的消费者。

## 评测（供内部验收）

问题文件为 JSONL，每行一个问题：

```json
{"id": "q1", "question": "员工辞职需要提前多久通知？", "lang": "zh", "gold": [{"doc_path": "人事/员工手册.md", "start_line": 120, "end_line": 134}]}
```

`gold` 中任一位置与返回证据的行区间有交集即算命中；没有行号时按 `title_path`（从顶层章节到答案节点的标题链）前缀匹配；
只有 `doc_path` 时命中该文档任意位置即可。完整格式、命中规则、开发期语料、BM25 基线结果与规模基准见
[eval/README.md](eval/README.md)。

## 许可

[MIT](LICENSE)。PageIndex 同为 MIT；MarkIndex 不含其代码，但移植了其树成本模型、改写了其 Agent 工具描述与指令，特此致谢。
