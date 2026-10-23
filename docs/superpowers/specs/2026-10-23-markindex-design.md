# MarkIndex 设计文档

> 日期：2026-10-23 · 状态：用户已同意按此推进，最终以用户内部验收为准 · 名称 **MarkIndex**（用户选定；npm 包名 `markindex`，CLI `markindex`）
>
> 开源：MIT 许可（与 PageIndex 相同）。README 明确致敬并链接 VectifyAI/PageIndex，说明是独立实现、非官方项目，不使用其商标作为产品名。

## 1. 意图

为 **Agent** 提供一个面向 **大量、长篇、专业 Markdown 文档** 的无向量检索库：把每篇文档按自身章节结构建成树，Agent 沿"库 → 目录 → 文档 → 章节"逐层导航并读取原文，必要时用关键词检索兜底。

**为什么做**：

- 长专业文档用 chunk + 向量会切碎上下文；按文档自身结构导航更准、可解释、可引用。
- VectifyAI/PageIndex 是这一思路的标杆，但：
  - 仅 Python，无 TS/JS 版本（维护者在 #75 明确不做）；
  - MD 支持只是一个孤立函数 `md_to_tree`：正则解析、边界缺陷多（#609、#245），且**本地模式直接拒绝非 PDF**（`local_api.py:125`），MD 树没有接入其 Agent 工具与检索；
  - 外部 PR 基本不合（最近 100 个合并 PR 全部来自 5 位维护者），无法通过上游补齐。
- 用户的决定：**不重新设计 PageIndex 已有的好设计，写一个干净的 TS 版本，专注 MD，补齐 MD 建树。**

## 2. 目标 / 非目标 / 反目标

**目标**

1. MD 建树正确、确定性、不依赖 LLM，覆盖真实文档的边界情况（见 §5）。
2. 多文档库，规模目标：**数百篇 × 每篇数百页**（约数千万 token、约 10 万量级节点）下导航、检索、增量更新都可用。
3. 两种检索模式都提供（用户决定）：
   - **工具模式**：库提供一组不调 LLM 的工具，调用方 Agent 自己导航；
   - **内置模式**：`retrieve(question)` 内部用 LLM 驱动同一套工具，返回选中的原文片段。
4. 两种接入方式都提供（用户决定）：TS 库直接 `import`；MCP server 供 Claude Code / Cursor 等使用。
5. 关键词检索：BM25，**中文、英文、中英混排都要支持**（用户决定）。

**非目标**

- PDF、DOCX、HTML、OCR 等其他格式（以后可通过"先转 MD"接入，本期不做）。
- 代码仓库建树。
- 向量检索、embedding。
- 云服务、多租户、权限、Web UI。
- 生成最终回答：输出给 Agent 的是**原文片段 + 定位**，回答由调用方组织（内置模式也只返回证据，不写答案）。

**反目标**（技术上能跑但算失败）

- 建树依赖 LLM 或结果不确定（同一输入两次结果不同）。
- 任何工具一次性把整个库或整棵大树塞给 Agent，撑爆上下文。
- 静默丢内容：除 frontmatter（解析为 metadata）外，任何原文行都必须属于某个节点（标题前的前言、无标题文档同样要被索引）。
- 中文检索形同虚设（例如用默认 `unicode61` 分词导致整句成一个词）。
- 引用无法回溯到原文行号。

## 3. 约束

- 语言：TypeScript，ESM，发布为 npm 包；运行时 Node.js ≥ 20（Bun/Deno 不作为本期验收目标）。
- 已验证（本机 Node 24.5）：`Intl.Segmenter('zh', {granularity:'word'})` 可正确切分中英混排（"劳动 | 合同 | 解除""React | Server | Components""v2.1"保持完整）；SQLite 3.50 的 FTS5 支持 `unicode61`、`trigram` 分词器与 `bm25()`。
- LLM 只用于：节点摘要、文档描述、内置 `retrieve()`。三者都可关闭；关闭后建树、工具模式、关键词检索全部可用。

## 4. 架构总览

```
 .md 文件 / 目录
      │  parse (mdast)                       确定性
      ▼
 Section 列表（标题、层级、起止行）
      │  build tree + optimize（token 成本模型）确定性
      ▼
 文档树 ──► summarize（可选，LLM，按内容 hash 缓存）
      │
      ▼
 Store：SQLite（树、元数据、原文、FTS5 索引）   增量更新
      │
      ▼
 Tool Contract（zod：名称 / 描述 / 入参 schema / 返回信封）
      │
      ├── 库 API：build_agent_tools 等价的普通函数
      ├── 适配器：Vercel AI SDK tool()、MCP server (stdio)
      └── retrieve(question)：AI SDK generateText + 同一套工具
```

**核心原则**：工具契约只有一份（对齐 PageIndex `agent_tools.py` 的 `TOOL_CONTRACT`），所有适配器和内置 `retrieve()` 都只是它的消费者。

## 5. MD 解析与建树

### 5.1 解析

使用 mdast（`mdast-util-from-markdown` + GFM / frontmatter 扩展）而非正则。只取**顶层**标题作为分节点（代码块、引用块、列表、HTML 块内的 `#` 不算）。

必须覆盖的情况（来自 PageIndex #609、#245 及其 MD 代码审阅）：

| 情况 | 期望行为 |
|---|---|
| ATX 标题 `#`–`######` | 正常分节 |
| Setext 标题（`===` / `---`） | 识别为 h1 / h2 |
| 第一个标题之前的正文 | 生成 `kind: "preface"` 节点（PageIndex PDF 路径的 Preface 做法） |
| 完全没有标题的文档 | 整篇作为一个根节点，标题取文件名；过长时按 §5.3 拆分 |
| YAML / TOML frontmatter | 不进入正文节点，解析为文档 `metadata`；`title` 字段可作为文档标题 |
| ``` 与 `~~~` 代码块、缩进代码块内的 `#` | 不是标题 |
| 标题跳级（h1 后直接 h3） | 按"最近的更浅层级"挂父节点（栈算法） |
| 标题文本含行内格式、链接、行尾 `#` | 取纯文本作 title |
| 独占一行的 `**粗体**` | **不**当标题（PageIndex 这样做导致误判；可作为选项保留，默认关） |

### 5.2 节点 schema

```ts
interface TreeNode {
  nodeId: string;            // 文档内稳定 ID，格式由实现决定，需在内容不变时跨重建保持不变
  title: string;
  kind: "preface" | "section" | "chunk";   // chunk = §5.3 中按段落拆出的子块
  level: number;             // 原始标题层级；preface/chunk 继承父级 +1
  startLine: number;         // 1-based，含
  endLine: number;           // 1-based，含；覆盖本节点自身正文 + 全部子孙
  ownEndLine: number;        // 本节点自身正文（不含子节点）结束行
  tokens: number;            // 子树总 token
  ownTokens: number;
  summary?: string;          // 叶子节点
  prefixSummary?: string;    // 非叶子：自身正文的摘要（沿用 PageIndex 命名语义）
  keyItems?: string[];       // optimize 合并掉的子标题（沿用 PageIndex）
  children: TreeNode[];
}

interface DocumentRecord {
  docId: string;
  path: string;              // 相对库根的路径，同时决定文件夹层级
  title: string;
  description?: string;      // 文档级描述（沿用 PageIndex doc_description）
  metadata: Record<string, unknown>;  // frontmatter
  contentHash: string;
  lineCount: number;
  tokens: number;
  indexedAt: string;
}
```

不变量：一篇文档所有节点的"自身正文区间"（`startLine..ownEndLine`）**不重叠，且覆盖除 frontmatter 外的全部行**。所有行号都是**原文件行号**（含 frontmatter 的偏移），保证引用可直接回溯到文件。

`nodeId`（**Claude 的选择**）：由"祖先标题链 + 同名兄弟序号"派生的短 hash。语义保证仅为：标题链不变则 ID 不变；不承诺跨文档修改的长期有效。evidence 始终同时携带 `titlePath` 与行区间，ID 失效时调用方仍可凭二者定位；工具收到不存在的 ID 时返回带"重新获取结构"指引的错误信封。

**token 计数**（**Claude 的选择**）：默认用近似计数器（CJK 字符按 1 token，其余按字符数 / 4），接口可插拔，允许调用方注入真实 tokenizer。所有阈值以该计数为准。

### 5.3 节点粒度优化（移植 `tree_optimize.py`）

PageIndex 的 `tree_optimize.py` 以"Agent 最坏情况需要线性扫描的量"为成本模型做 merge / expand，被合并掉的标题保留在 `keyItems`。本项目**移植该成本模型，把"页"换成"token"**：

- `S(v)` = 子树总 token；`R(v)` = 路由成本（标题 + 摘要 + 子节点描述的 token，可用常数近似）。
- **merge**：自底向上，`merge iff S(v) <= tree_cost(v)`，过碎的子树并入父节点，子标题进 `keyItems`。
- **expand**：节点过大（超过阈值，如 `maxNodeTokens`）且无子标题时，**不调 LLM**，按段落 / 块边界确定性拆成 `kind: "chunk"` 子节点，标题取首句截断。
- 阈值、`R(v)` 估计方式作为配置项，默认值由实现者通过评测集（§10）标定。

PageIndex MD 路径的简单 thinning（`min_node_token`）被此机制取代。

## 6. 存储与增量更新

- 单个 SQLite 文件存放：文档元数据、节点树、原文（按行或按节点）、摘要缓存、FTS 索引。
- 驱动：`better-sqlite3`（**Claude 的选择**：稳定、同步 API 简单；`node:sqlite` 在 Node 24 仍为 experimental，可作为以后的可选后端）。存储层留接口，不把 SQL 散落各处。
- 库根是一个磁盘目录；文档的**文件夹层级 = 相对路径的目录结构**（PageIndex 本地版不支持文件夹，这里直接用目录树补上）。
- 增量：`index(root)` 扫描目录，按文件内容 hash 判断新增 / 修改 / 删除；只重建变化的文档。摘要按**节点内容 hash** 缓存，文档局部修改时未变节点的摘要复用。
- 写入以文档为单位走事务，索引中途失败不留下半篇文档。
- 并发（**Claude 的选择**）：SQLite 开 WAL；同一时刻只允许一个写进程（文件锁），读不受限。MCP server 默认只读服务一个已建好的库，提供 `--reindex-on-start` 选项；文件监听自动增量不在本期范围。
- 扫描范围（**Claude 的选择**）：`.md`、`.markdown`；不含 `.mdx`（JSX 语法需另一套解析）；遵守 `.gitignore` 与可配置的 ignore；不跟随符号链接。文档重命名按"删除 + 新增"处理，摘要因按节点内容 hash 缓存而自动复用。

## 7. 关键词检索（BM25，中英混排）

- 入库与查询使用**同一个**分词函数：`Intl.Segmenter` 切词（取 `isWordLike`），英文小写化，以空格连接后写入 FTS5（`unicode61` 分词器，仅按空格切）。排序用 `bm25()`。
- 另建一个 `trigram` 分词的 FTS5 表作兜底，处理专有名词被切错、子串查询等情况；两路结果的合并策略由实现者决定（如 BM25 结果不足 N 条时补充）。
- 分词器做成可插拔接口，允许以后换 jieba 类专用分词。
- 检索单位是节点，**只索引节点自身正文**（`startLine..ownEndLine`），不重复索引子树，从而父子节点不会因同一段文字重复命中（**Claude 的选择**）。检索字段：节点标题（加权最高）、keyItems、摘要、自身正文。返回**节点路径**（文档 → 祖先标题链 → 节点）与片段，供 Agent 跳转后沿树确认。
- 检索是**兜底**，工具描述中按 PageIndex 的指引写明"先浏览、走不通再搜索"。

## 8. 工具契约

沿用 PageIndex 的工具形态与约定（`agent_tools.py`）：

- 工具**从不抛异常**；统一返回 `{ success: true, data, next_steps }` 或 `{ error, details, next_steps: { summary, options } , code }`，以 JSON 字符串交给 Agent。
- 每个响应有字符预算（PageIndex 为 100K × 0.95），超出时分段并给出 `has_more` / 下一段参数。
- 工具描述本身是给 Agent 的使用指引，属于契约的一部分，需要有测试防止被无意改坏。

工具清单（名称尽量对齐 PageIndex，以便其 prompt 可迁移）：

| 工具 | 作用 | 与 PageIndex 的差异 |
|---|---|---|
| `browse_documents` | 按文件夹浏览库：子文件夹 + 文档（名称、描述、规模），分页 | 新增真实文件夹（磁盘目录）；无语义排序 |
| `get_document` | 文档元数据、描述、规模；提示是否需要先看结构 | 去掉"处理中"等待逻辑（本地同步建索引） |
| `get_document_structure` | 返回树（不含正文）。参数：`depth`（默认浅层，如 2）、`node_id`（只展开该子树）、`part`（超预算分段） | 新增 `depth` / `node_id`；`part` 分段沿用其 `_split_structure` 算法 |
| `get_node_content` | 读一个或多个节点原文（带行号），节点过长时分段 | 替代 `get_page_content`；定位从"页"换成"节点 / 行区间" |
| `search_documents` | BM25 关键词检索，可限定文件夹或文档 | PageIndex 开源版未实现，仅云端有；契约与"浏览优先"指引沿用 |

"小文档直接读、大文档先看结构"的阈值（PageIndex 为 20 页）换算为 token 阈值，写入 `get_document` 的返回与工具描述。

不暴露为 Agent 工具（只在库 API / CLI 提供）：建索引、删除文档、配置。

## 9. LLM 相关

- 通过 **Vercel AI SDK**（`ai` 包）调用模型，调用方传入任意 provider 的 model 实例（**Claude 的选择**：与模型厂商解耦，且 AI SDK 的 `tool()` 本身就是适配目标之一）。
- **摘要**：沿用 PageIndex 规则——节点自身 token 低于阈值直接用原文，否则调 LLM；叶子写 `summary`，非叶子写 `prefixSummary`。支持并发上限、重试、限速；按节点内容 hash 缓存。
- **文档描述**：基于（含摘要的）精简树生成一句话描述。
- **`retrieve(question, options)`**：系统指令移植 PageIndex 的 `AGENT_INSTRUCTIONS` 与引用规则（只依据读到的原文、不用常识补、引用必须可回溯），把"页"改为"文档路径 + 行区间"；用 `generateText` + 本库工具跑多步循环；返回 `{ evidence: [{ docPath, nodeId, titlePath, startLine, endLine, text }], usage, stopReason }`，**不返回答案文本**。有 `maxSteps` 与 token 预算上限；预算耗尽时返回已收集的证据并标 `stopReason: "budget"`，而非报错（**Claude 的选择**）。本期不做流式。
- 参考 PageIndex 的成本数据：其 Flash 模式在 1098 页文档上摘要 + 优化约 160 万输入 token。本项目摘要应可完全关闭，并提供索引前的成本预估（节点数、预计调用次数 / token）。

## 10. 验收

1. **解析正确性**：§5.1 表中每一行都有单元测试；包含 PageIndex #609、#245 中的全部复现用例。覆盖不变量（§5.2）用属性测试或对大量真实 MD 文件做断言。
2. **确定性**：同一输入两次建树结果逐字节一致（不含时间戳）。
3. **规模**：构造或收集一个 ≥ 300 篇、单篇 ≥ 10 万 token 的 MD 库：关闭摘要时全量建索引、单文档增量更新、任一工具调用的响应时间与内存需给出实测数字（具体门槛由实现者首轮实测后提出，经用户确认）。
4. **检索质量**：一组中、英、混排文档 + 问题 + 标准答案节点的评测集；指标为 Agent（工具模式与内置模式各测）命中正确节点的比例与 token 消耗。与"直接 BM25 取 top-k"作基线对比。评测集规模和来源由实现者提议。
**语料分工（用户决定）**：开发期由实现者使用公开（许可已核实）或合成的中英混排 MD 语料完成第 3、4 项自测；同时交付一个**评测工具**（CLI：输入"文档目录 + 问题/标准答案文件"，输出命中率、token 消耗与基线对比），用户用内部真实文档跑最终验收并给出结论。问题文件格式由实现者定义并写进 README。

5. **接入**：MCP server 在 Claude Code 中实际可用（列出工具、完成一次多文档检索）；AI SDK 适配在一个最小示例 Agent 中跑通。

## 11. 留给实现者决定的

- `nodeId` 的生成方式（需满足"内容不变则稳定"）。
- 包结构（单包或 monorepo：core / mcp / cli）、构建与测试工具链。
- trigram 与 BM25 两路结果的合并策略。
- 字符预算、默认 `depth`、摘要阈值、`maxNodeTokens` 等默认值（以评测集标定）。
- CLI 的具体命令设计（至少需要：建索引、查看树、检索、启动 MCP server）。
- 并发与限速的具体实现。

## 12. 参考（PageIndex `main@b3422f9`，2026-10-22）

| 文件 | 参考内容 |
|---|---|
| `pageindex/page_index_md.py` | MD 建树原实现（及其缺陷） |
| `pageindex/agent_tools.py` | `TOOL_CONTRACT`、返回信封、`_split_structure`、字符预算、`AGENT_INSTRUCTIONS`、引用提示词 |
| `pageindex/tree_optimize.py` | merge / expand 成本模型、`keyItems` |
| `pageindex/local_store.py` | 原子写、存储布局（本项目改用 SQLite） |
| `pageindex/integrations/*` | 一份契约多适配器的组织方式 |
| Issues #609、#245、#316、#513、#75 | MD 缺陷、增量更新诉求、官方不做代码 / 非 Python 的表态 |
