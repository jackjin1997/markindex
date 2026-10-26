# MarkIndex

[![CI](https://github.com/jackjin1997/markindex/actions/workflows/ci.yml/badge.svg)](https://github.com/jackjin1997/markindex/actions/workflows/ci.yml)

**面向 Agent 的无向量、结构优先的长篇 Markdown 文档库检索。**

MarkIndex 把每篇 Markdown 按其自身章节解析成树，把树、原文行和中英混排 BM25 索引存进一个 SQLite 文件，
再给 Agent 提供 5 个只读工具，沿"库 → 文件夹 → 文档 → 章节"逐层导航，并带行号读取原文。
不用 embedding、不用向量库、不靠猜测切块；文档自身的结构就是索引，每条证据都能以 `[doc_path, L起-止]` 的格式引用回原文。

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
npm install markindex          # 库 + CLI（Node.js >= 22.12）
```

只有用到 LLM 功能（摘要、`retrieve()`、agent 模式评测）时才需要安装对应的 AI SDK provider，例如 `npm install @ai-sdk/anthropic`，并设置 `ANTHROPIC_API_KEY`。
不在本地安装、直接用 `npx` 时，把 provider 放进同一个临时环境：

```bash
npx -p markindex -p @ai-sdk/anthropic markindex index ./docs --summary-model anthropic:claude-sonnet-5-5
```

## CLI

```bash
markindex index ./docs                                                       # 建立 / 增量更新索引（<root>/.markindex/index.db）
markindex index ./docs --summary-model anthropic:claude-sonnet-5-5 --estimate # 只估算摘要成本，不调 LLM
markindex index ./docs --no-setext                                           # 转换器产物里 `---` 是分页符时使用
markindex index ./docs --ignore 'drafts/' --ignore '*.tmp.md'                # 额外的忽略规则（可重复）
markindex tree ./docs 指南/安装.md --depth 3                                  # 查看一篇文档的章节树
markindex search ./docs "离职 补偿" --limit 5 --json                          # 关键词检索
markindex mcp ./docs                                                         # 以 MCP server（stdio，只读）提供给 Agent
markindex eval ./docs --questions questions.jsonl --mode bm25 --out report.json
markindex eval ./docs --questions questions.jsonl --mode agent --model anthropic:claude-sonnet-5-5 --out report.json
```

所有命令都接受 `--db <file>` 指定索引文件。索引请放在本地磁盘：写锁依赖硬链接，SQLite 使用 WAL 模式，二者在 exFAT、
SMB / NFS 共享或其他网络卷上都不可靠；文档放在这类卷上时，文档原地不动，用 `--db` 指向本地路径
（如 `--db ~/.cache/markindex/docs.db`）。

索引是增量的：按内容哈希比较，只重建新增或改动的文档，删除的文件会被清理，摘要按节点内容哈希缓存。扫描 `.md` 与
`.markdown`（不含 `.mdx`）；以下路径会被忽略：文档库自身各级目录下 `.gitignore` 文件匹配的路径（不读取全局 git excludes 与
`.git/info/exclude`）、库根目录下可选的 `.markindexignore` 文件（语法相同，用于不想写进 `.gitignore` 的规则）匹配的路径，
以及 `--ignore <pattern>` 选项（gitignore 语法，相对库根，可重复；库 API 为 `ignore: string[]`；`mcp --reindex-on-start` 同样支持）
匹配的路径（开头的 `./` 会被去掉，开头的 `/` 与 gitignore 一样表示锚定到库根，绝对文件系统路径或 `../` 会报错）。
这几类来源只会增加排除：`.markindexignore` 或 `--ignore` 中的 `!` 规则不能重新包含被 `.gitignore` 排除的路径。
变为被忽略的文档会在下一次运行时从索引中删除。跳过 `.git`、`.markindex` 等点目录，不跟随符号链接。同一时间只允许一个写进程（第二个 `index`
立即失败），MCP server 等读取方不受阻塞。索引由旧版本 MarkIndex 或不同的建树参数生成时，下一次 `index` 会重建全部文档
（输出 `full rebuild: …`，报告中带 `rebuilt`），已缓存的摘要会被复用。

**PDF / HTML 转换产物的分页符**：转换器常在一页最后一段之后紧跟一行 `---` 作为分页，CommonMark 会把它读成 setext 标题，
整段文字变成二级标题。`index` 发现文字跨多行或超过 120 个字符的 setext 二级标题时会给出警告（标准输出 `warning <path>: …`，
JSON 报告中的 `warnings`）。这类文档库请加 `--no-setext`（`mcp --reindex-on-start` 同样支持；库 API 为 `setext: false`）：
`---` 按分隔线、`===` 按普通文字处理。该设置保存在索引中：之后不带该参数的运行（`index`、`mcp --reindex-on-start`、`Library.index()`）会沿用它；
要重新开启请传 `--setext`（库 API 为 `setext: true`）。改变该设置会重建整个索引。

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

工具从不抛异常，返回 `{ success, data | error, code, details, next_steps }` JSON 信封。参数不符合 schema（类型错误、未知字段、
字符串超过 1 024 字符）时，`lib.callTool` 返回 `INVALID_INPUT` 信封；但经 MCP 与 AI SDK 调用时，传输层会先按同一 schema
校验参数，此类错误以传输层自身的错误返回（MCP 工具错误 / AI SDK 的 invalid tool input 错误），而不是 JSON 信封。

## 安全与信任

- **只读、限定在文档库内**：工具只读取你指定的那个文档库的索引，从不读取库外文件、不写入、不访问网络；路径与节点 id 都在索引中查找，而不是直接访问磁盘。
- **文档是不可信输入**：工具输出是文档原文，LLM 摘要 / 描述也由原文生成。文档中可能含有试图操纵 Agent 的文字（提示词注入）。请把工具返回的一切当作数据而非指令——尤其当文档库包含第三方或用户提交的文件，且 Agent 同时拥有发送、写入、执行等有副作用的工具时。
- 摘要与 `retrieve()` 会把文档内容发送给你配置的模型服务商；单纯建索引不产生任何网络请求。

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
只有 `doc_path` 时命中该文档任意位置即可。报告还给出每题的证据规模（行数、近似 token）与精度（证据行落在 gold 行区间内的比例），
并按语言汇总；`--max-evidence-lines <n>` 要求命中的证据条目不超过 `n` 行。完整格式、命中规则、开发期语料、BM25 基线结果与规模基准见
[eval/README.md](eval/README.md)。

**核心结果（n = 30，Claude Code sonnet，只开放 MarkIndex 的 5 个 MCP 工具）**：30/30 题都找到了标准答案段落（首位命中 93.3%），
平均引用 15 行，其中 88.6% 落在标准答案区间内；同一批问题上 BM25 top-5 命中 73.3%、平均 209 行（精度 12.8%）。Agent 平均每题约 3 轮
（[详情与局限](eval/README.md#7-results-agent-mode-via-claude-code)）。

## 许可

[MIT](LICENSE)。PageIndex 同为 MIT；MarkIndex 不含其代码，但移植了其树成本模型、改写了其 Agent 工具描述、指令与提示词，特此致谢；
其版权与许可声明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
