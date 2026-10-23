# markindex Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 一个 TS 库 + CLI + MCP server：把一个目录下的大量长篇 Markdown 建成章节树并存入 SQLite，向 Agent 提供无向量的"浏览 / 看结构 / 读节点 / BM25 检索"工具，以及可选的内置 `retrieve()`。

**Architecture:** 确定性流水线 parse(mdast) → build tree → optimize（token 成本模型）→ 可选 LLM 摘要 → SQLite（树 + 原文 + FTS5）。一份 zod 工具契约，库函数、AI SDK `tool()`、MCP server、`retrieve()` 都只消费它。

**Tech Stack:** TypeScript 5（ESM，`"module": "nodenext"`），Node ≥ 22.12，vitest，`mdast-util-from-markdown@2` + `micromark-extension-gfm@3` + `mdast-util-gfm` + `micromark-extension-frontmatter` + `mdast-util-frontmatter@2` + `yaml`，`better-sqlite3@13`，`zod@4`，`ai@7`（测试用 `ai/test` 的 `MockLanguageModelV4`），`@modelcontextprotocol/sdk@1.32`（`McpServer.registerTool`），`ignore`（.gitignore），`commander`（CLI）。

**Spec:** `docs/superpowers/specs/2026-10-23-markindex-design.md`（下称"spec"，§ 编号指它）。PageIndex 参考源码：`git clone https://github.com/VectifyAI/PageIndex` 于 `b3422f9`。

## Global Constraints

- 建树、优化、存储、工具、检索全部不调 LLM；LLM 只在摘要、文档描述、`retrieve()`（spec §3）。
- 同一输入两次建树结果逐字节一致（不含时间戳）（spec §10.2）。
- 所有行号为原文件 1-based 行号；frontmatter 行不属于任何节点，其余每行恰属于一个节点的自身正文区间（spec §5.2）。
- 工具从不抛异常，返回 JSON 信封；单次响应字符预算 `RESPONSE_CHAR_BUDGET = 95_000`（PageIndex 100_000 × 0.95）（spec §8）。
- 分词：`Intl.Segmenter(undefined, {granularity:'word'})` 取 `isWordLike`，英文小写；入库与查询同一函数（spec §7）。
- 扫描：`.md`、`.markdown`；不含 `.mdx`；遵守 `.gitignore`；不跟随符号链接（spec §6）。
- token 计数默认近似：CJK 字符 1 token，其余字符数 / 4 向上取整；可注入（spec §5.2）。
- 不依赖向量库或 embedding；不做 PDF（spec §2）。
- 公开 API 全部从 `src/index.ts` 导出；默认值集中在 `src/config.ts`。

## Review Focus

1. 中英混排、全角标点、emoji、`v2.1`/`C++`/`ISO-27001` 这类带符号的检索词：期望查询能命中原文同一写法。→ Task 2 测试 `segments symbol-bearing terms consistently`，Task 7 测试 `finds ISO-27001 and C++`。
2. 超大单文件（> 5 MB、一个标题都没有、或某节 10 万 token 无子标题）：期望建树不卡死、节点被 expand 拆成 chunk、每个响应不超预算。→ Task 4 测试 `expands a 100k-token headless section into chunks`，Task 9 测试 `get_node_content pages an oversized node`。
3. 文件在两次 index 之间被删除 / 重命名 / 编码为 GBK 或含 BOM、CRLF：期望删除被清理，BOM 被剥离，CRLF 行号仍正确，非 UTF-8 文件被跳过并报告而非崩溃。→ Task 3 测试 `handles BOM and CRLF line numbers`，Task 6 测试 `reports non-utf8 files and continues`。
4. Agent 传入不存在 / 过期的 `doc_path`、`node_id`、越界 `part`：期望错误信封带"下一步"指引（相似名建议，参考 PageIndex `_SIMILAR_NAMES_LIMIT = 3`）。→ Task 9 测试 `suggests similar doc names`、`stale node id tells agent to refetch structure`。
5. 另一个进程正在 index 时启动 MCP 读取 / 第二个 index：期望读不受阻，第二个写进程立即失败并给出清晰信息。→ Task 6 测试 `second writer fails fast with lock message`。

---

## File Structure

```
src/
  config.ts              默认值常量
  types.ts               TreeNode / DocumentRecord / Section 等共享类型
  text/tokens.ts         TokenCounter、approxTokens
  text/segment.ts        segmentForIndex(text): string
  parse/markdown.ts      parseMarkdown(src) → ParsedDoc（sections + frontmatter）
  tree/build.ts          buildTree(parsed, opts) → TreeNode[]；nodeId；invariant 检查
  tree/optimize.ts       optimizeTree(nodes, lines, opts)：merge + expand
  store/db.ts            openStore(path, {readonly}) → Store；schema/migration；写锁
  store/search.ts        searchNodes(store, query, scope) → SearchHit[]
  library/scan.ts        scanLibrary(root) → FileEntry[]
  library/indexer.ts     indexLibrary(opts) → IndexReport
  llm/summarize.ts       summarizeDocument(...)；describeDocument(...)
  tools/envelope.ts      ok()/fail()/budget split（移植 _split_structure）
  tools/contract.ts      TOOL_CONTRACT：zod schema + 描述文案
  tools/impl.ts          五个工具实现 + callTool(name,args)
  adapters/ai-sdk.ts     createAiSdkTools(lib)
  adapters/mcp.ts        createMcpServer(lib)
  retrieve.ts            retrieve(lib, question, opts)
  library.ts             openLibrary(opts) → Library（组合上面全部）
  cli.ts                 index | tree | search | mcp | eval
  index.ts               公开导出
eval/
  fetch-corpus.ts        下载/转换评测语料
  run-eval.ts            评测（命中率、token、基线）
tests/                   与 src 同构的 *.test.ts，fixtures/ 放 MD 样例
```

---

### Task 1: 项目脚手架 + token 计数

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`, `src/config.ts`, `src/types.ts`, `src/text/tokens.ts`, `src/index.ts`
- Test: `tests/text/tokens.test.ts`

**Interfaces:**
- Produces:
  - `type TokenCounter = (text: string) => number`
  - `approxTokens: TokenCounter`
  - `src/types.ts` 中 spec §5.2 的 `TreeNode`、`DocumentRecord`（字段名逐字照抄 spec），外加 `NodeKind = 'preface'|'section'|'chunk'`
  - `src/config.ts`：`RESPONSE_CHAR_BUDGET = 95_000`、`DEFAULT_STRUCTURE_DEPTH = 2`、`SUMMARY_TOKEN_THRESHOLD = 200`（PageIndex `--summary-token-threshold` 默认）、`MAX_NODE_TOKENS = 8_000`、`ROUTING_COST_TOKENS = 150`、`STRUCTURE_FIRST_TOKEN_THRESHOLD = 15_000`（PageIndex 20 页 × ~750 token 的换算，待 Task 12 标定）、`SIMILAR_NAMES_LIMIT = 3`

- [ ] **Step 1:** `npm init`，安装 Tech Stack 中依赖与 `typescript vitest @types/node @types/better-sqlite3 tsx`；`package.json` 设 `"type":"module"`、`"engines":{"node":">=22.12"}`、`"bin":{"markindex":"dist/cli.js"}`、scripts `build`/`test`/`typecheck`。
- [ ] **Step 2: 写失败测试** `tests/text/tokens.test.ts`
```ts
expect(approxTokens('')).toBe(0)
expect(approxTokens('abcd')).toBe(1)
expect(approxTokens('abcde')).toBe(2)
expect(approxTokens('合同解除')).toBe(4)
expect(approxTokens('合同 abcd')).toBe(2 + Math.ceil(5 / 4)) // 空格计入非 CJK
```
- [ ] **Step 3:** `npx vitest run tests/text/tokens.test.ts` → FAIL（模块不存在）。
- [ ] **Step 4:** 实现 `approxTokens`：CJK 判定用 `/\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}/u`。
- [ ] **Step 5:** 测试 PASS；`npx tsc --noEmit` 无错。
- [ ] **Step 6:** `git commit -m "chore: scaffold package and approximate token counter"`

### Task 2: 检索分词

**Files:** Create `src/text/segment.ts`；Test `tests/text/segment.test.ts`

**Interfaces:**
- Produces: `segmentForIndex(text: string): string` —— 返回空格分隔的小写 token 串；`segmentQuery(q: string): string` —— 返回可直接用于 FTS5 `MATCH` 的表达式（每个 token 加双引号转义，以 `OR` 连接，交由 bm25 排序）。

- [ ] **Step 1: 写失败测试**
```ts
test('segments mixed zh/en', () =>
  expect(segmentForIndex('劳动合同的解除条件 React Server')).toBe('劳动 合同 的 解除 条件 react server'))
test('segments symbol-bearing terms consistently', () => {
  for (const t of ['v2.1', 'C++', 'ISO-27001', 'GDPR第17条'])
    expect(segmentForIndex(`见 ${t} 规定`)).toContain(segmentForIndex(t))
})
test('query is escaped for FTS5', () =>
  expect(segmentQuery('"合同" OR x')).toBe('"合同" OR "or" OR "x"'))
test('empty / punctuation-only query', () => expect(segmentQuery('，。！')).toBe(''))
```
- [ ] **Step 2:** 运行 → FAIL。
- [ ] **Step 3:** 实现。模块级缓存一个 `Intl.Segmenter`；`isWordLike` 为真才保留；FTS5 双引号内的 `"` 写成 `""`。若 `C++` 被切丢 `+`，在切词前用 `/[A-Za-z0-9]+(?:[.+#\-][A-Za-z0-9+#]*)+/g` 先抽出整词并保护（第二条测试决定是否需要）。
- [ ] **Step 4:** PASS。
- [ ] **Step 5:** `git commit -m "feat: mixed zh/en segmentation for FTS"`

### Task 3: Markdown 解析

**Files:** Create `src/parse/markdown.ts`；Test `tests/parse/markdown.test.ts`，fixtures `tests/fixtures/md/*.md`

**Interfaces:**
- Produces:
```ts
interface Heading { title: string; level: number; line: number; endLine: number } // setext 标题占两行
interface ParsedDoc {
  lines: string[];                 // 已去 BOM，按 /\r?\n/ 切分
  frontmatter?: { startLine: number; endLine: number; data: Record<string, unknown> };
  headings: Heading[];             // 仅 mdast 根的直接子节点 heading
  firstContentLine: number;        // frontmatter 之后第一行
}
parseMarkdown(src: string): ParsedDoc
```

- [ ] **Step 1: 写失败测试**，每个 spec §5.1 表格行一个用例（fixture 内容内联在测试里即可）：
  - `atx headings levels 1-6`
  - `setext headings`：`'Acme SDK\n========\n\nintro\n\n## Install\n'` → headings `[{title:'Acme SDK',level:1,line:1,endLine:2},{title:'Install',level:2,line:6,...}]`（PageIndex #609 复现）
  - `ignores # inside fenced (``` and ~~~), indented code, blockquote, list, html`
  - `yaml frontmatter parsed, not a heading`：`'---\ntitle: T\n---\n# A\n'` → `frontmatter.data.title==='T'`，`frontmatter.endLine===3`，`headings[0].line===4`
  - `toml frontmatter (+++)`
  - `heading text strips inline formatting and closing #`：`'## **Bold** [link](x) ##'` → `'Bold link'`
  - `bold-only line is not a heading`
  - `handles BOM and CRLF line numbers`：`'﻿# A\r\nx\r\n# B'` → lines 1 与 3
- [ ] **Step 2:** 运行 → FAIL。
- [ ] **Step 3:** 实现：`fromMarkdown(src, { extensions:[gfm(), frontmatter(['yaml','toml'])], mdastExtensions:[gfmFromMarkdown(), frontmatterFromMarkdown(['yaml','toml'])] })`；只遍历 `root.children`；标题文本用 `mdast-util-to-string`；行号取 `node.position`；YAML 用 `yaml` 解析，TOML 解析失败时 `data = {}` 不抛错（不引 TOML 依赖，保留原文到 `data.raw`）。
- [ ] **Step 4:** PASS。
- [ ] **Step 5:** `git commit -m "feat: mdast-based markdown section parser"`

### Task 4: 建树、nodeId、不变量

**Files:** Create `src/tree/build.ts`；Test `tests/tree/build.test.ts`

**Interfaces:**
- Consumes: `ParsedDoc`（Task 3）、`TokenCounter`（Task 1）
- Produces:
  - `buildTree(doc: ParsedDoc, opts: { fileTitle: string; countTokens?: TokenCounter }): TreeNode[]`
  - `assertCoverage(doc: ParsedDoc, roots: TreeNode[]): void` —— 违反 spec §5.2 不变量时抛错（仅测试 / debug 用）
  - `walk(roots: TreeNode[]): Generator<{node: TreeNode; titlePath: string[]}>`

- [ ] **Step 1: 写失败测试**
  - `preface node for text before first heading`：#609 样例（ATX 版本）→ 首节点 `kind:'preface'`，`startLine:1`
  - `headless doc becomes one root titled by file`：`buildTree(parse('just text'), {fileTitle:'notes'})` → 1 个节点 `title:'notes'`
  - `skipped levels attach to nearest shallower`：`# A / ### C / ## B` → A.children = [C, B]
  - `endLine covers subtree, ownEndLine stops before first child`
  - `coverage invariant holds on all fixtures`：对 `tests/fixtures/md/` 每个文件调 `assertCoverage`
  - `node ids stable under unrelated edits`：在文末追加新节后，原有节点 id 不变；同名兄弟 `## Notes` ×2 的 id 不同
  - `deterministic`：两次 `JSON.stringify(buildTree(...))` 相等
- [ ] **Step 2:** 运行 → FAIL。
- [ ] **Step 3:** 实现：栈算法同 PageIndex `build_tree_from_nodes`；`nodeId = sha1(titlePath.join('\u001f') + '\u001f' + siblingOrdinal).slice(0, 10)`，其中 `siblingOrdinal` 为同父同名兄弟中的序号；`level` 对 preface/无标题根取 0 或 1（实现者定，保持一致）。
- [ ] **Step 4:** PASS。
- [ ] **Step 5:** `git commit -m "feat: build section tree with stable node ids"`

### Task 5: 树优化（merge / expand）

**Files:** Create `src/tree/optimize.ts`；Test `tests/tree/optimize.test.ts`

**Interfaces:**
- Consumes: `TreeNode`、`ParsedDoc.lines`、`TokenCounter`
- Produces: `optimizeTree(roots: TreeNode[], doc: ParsedDoc, opts?: { maxNodeTokens?: number; routingCost?: number; countTokens?: TokenCounter }): TreeNode[]`（纯函数，返回新树）

成本模型（移植 PageIndex `tree_optimize.py` 顶部注释，页 → token）：
```
S(v)          = v 子树总 tokens
R(v)          = routingCost
S_residual(v) = v.ownTokens
tree_cost(v)  = S(v)                                         v 为叶
              = R(v) + max(S_residual(v), max_c tree_cost(c)) 否则
merge(v) iff S(v) <= tree_cost(v)    （自底向上；被并子孙的标题按先序写入 v.keyItems）
expand(v) iff v 为叶 且 S(v) > maxNodeTokens：按 mdast 顶层块（段落/列表/表格/代码块）边界贪心切成 ≤ maxNodeTokens 的 chunk，
              不切开单个块；单块本身超限则按行切。chunk.title = 首个非空行去 markdown 后截 60 字符。
```

- [ ] **Step 1: 写失败测试**
  - `merges tiny subtree into parent`：父 50 token，两个 20 token 子节点，`routingCost:150` → 子节点被合并，`keyItems` 为两个子标题
  - `keeps large children`：子节点各 5000 token → 不合并
  - `expands a 100k-token headless section into chunks`：生成 100k token 无标题正文 → 所有 chunk `tokens <= maxNodeTokens`，覆盖不变量仍成立
  - `never splits inside a fenced code block`
  - `deterministic`
- [ ] **Step 2:** 运行 → FAIL。
- [ ] **Step 3:** 实现。合并后需重算 `ownEndLine`/`ownTokens`；chunk 的 `nodeId` = 父 id + `-c` + 序号。
- [ ] **Step 4:** PASS，且 Task 4 的 `assertCoverage` 在优化后的树上对全部 fixtures 通过。
- [ ] **Step 5:** `git commit -m "feat: token-cost tree optimization (merge/expand)"`

### Task 6: SQLite 存储 + 扫描 + 增量索引（不含摘要）

**Files:** Create `src/store/db.ts`, `src/library/scan.ts`, `src/library/indexer.ts`；Test `tests/store/db.test.ts`, `tests/library/indexer.test.ts`

**Interfaces:**
- Produces:
```ts
interface Store {
  readonly db: Database;              // better-sqlite3
  getDoc(path: string): DocumentRecord | undefined;
  listDocs(folder: string, offset: number, limit: number): { folders: string[]; docs: DocumentRecord[]; total: number };
  allDocPaths(): string[];
  getTree(path: string): TreeNode[] | undefined;
  getLines(path: string, start: number, end: number): string[];
  replaceDoc(doc: DocumentRecord, tree: TreeNode[], lines: string[]): void; // 单事务，含 FTS 行
  deleteDoc(path: string): void;
  close(): void;
}
openStore(file: string, opts?: { readonly?: boolean }): Store   // 写模式获取 `${file}.lock`（O_EXCL），失败抛 StoreLockedError
scanLibrary(root: string): { path: string; abs: string }[]      // 相对路径用 posix 分隔符，排序
indexLibrary(opts: { root: string; store: Store; countTokens?: TokenCounter; onProgress?: (e: IndexEvent) => void }):
  Promise<{ added: string[]; updated: string[]; removed: string[]; unchanged: string[]; skipped: { path: string; reason: string }[] }>
```
- 表：`docs(path PK, title, description, metadata JSON, content_hash, line_count, tokens, indexed_at)`、`nodes(doc_path, node_id, parent_id, ord, json, PRIMARY KEY(doc_path,node_id))`、`lines(doc_path, start_line, text)`（按 ≤ 200 行的块存）、`summaries(content_hash PK, summary)`、FTS 表见 Task 7（本任务建表、`replaceDoc` 写入，Task 7 只写查询）。`PRAGMA journal_mode=WAL`；`user_version` 做迁移。

- [ ] **Step 1: 写失败测试**
  - `roundtrips a document`：`replaceDoc` 后 `getTree`/`getLines` 与输入一致
  - `listDocs returns direct subfolders and docs`：路径 `a.md, x/b.md, x/y/c.md` → `listDocs('')` = folders `['x']` docs `['a.md']`；`listDocs('x')` = folders `['x/y']` docs `['x/b.md']`
  - `incremental: unchanged files are skipped`：二次 index → 全部 `unchanged`
  - `incremental: modify / delete / rename`：重命名报告为 removed + added
  - `respects .gitignore, skips .mdx and symlinks`
  - `reports non-utf8 files and continues`：GBK 文件 → `skipped[0].reason` 含 `utf-8`（用 `new TextDecoder('utf-8',{fatal:true})`）
  - `second writer fails fast with lock message`：两次 `openStore(f)` → 第二次抛 `StoreLockedError`；`openStore(f,{readonly:true})` 成功
  - `failed document leaves no partial rows`：mock `replaceDoc` 中途抛错 → 该 path 无任何行
- [ ] **Step 2:** 运行 → FAIL。
- [ ] **Step 3:** 实现。indexer 流程：scan → 读文件 → hash（sha256）→ 与 `docs.content_hash` 比较 → parse → buildTree → optimizeTree → `replaceDoc`；DB 中有而磁盘无则 `deleteDoc`。文档标题优先级：frontmatter `title` > 首个 h1 > 文件名。锁文件在 `close()` 与进程退出时删除；锁文件内写 pid，若 pid 不存在则视为陈旧锁并接管。
- [ ] **Step 4:** PASS。
- [ ] **Step 5:** `git commit -m "feat: sqlite store and incremental library indexer"`

### Task 7: BM25 检索

**Files:** Create `src/store/search.ts`；Modify `src/store/db.ts`（FTS 写入）；Test `tests/store/search.test.ts`

**Interfaces:**
- Consumes: `segmentForIndex`、`segmentQuery`（Task 2）、`Store`
- Produces:
```ts
interface SearchHit { docPath: string; nodeId: string; titlePath: string[]; startLine: number; endLine: number; snippet: string; score: number; via: 'bm25' | 'trigram' }
searchNodes(store: Store, query: string, opts?: { folder?: string; docPath?: string; limit?: number }): SearchHit[]
```
- FTS 表：`fts_words(title, key_items, summary, body, doc_path UNINDEXED, node_id UNINDEXED, tokenize='unicode61')`，写入前各字段经 `segmentForIndex`；`fts_tri(title, body, doc_path UNINDEXED, node_id UNINDEXED, tokenize='trigram')` 写原文。只索引节点自身正文（`startLine..ownEndLine`）。排序 `bm25(fts_words, 10.0, 5.0, 2.0, 1.0)`。
- 合并策略（Claude 的选择）：先 bm25；结果少于 `limit` 时用 trigram（原查询去空白，长度 ≥ 3 才查）补足，按 (docPath,nodeId) 去重。

- [ ] **Step 1: 写失败测试**（用 Task 6 的 indexer 对 fixture 库建索引）
  - `zh query hits zh node`：`'经济补偿'` 命中含"经济补偿金"的节点
  - `mixed query`：`'GDPR 被遗忘权'`
  - `finds ISO-27001 and C++`
  - `title outranks body`：同词在 A 标题、B 正文 → A 排前
  - `parent and child not double-counted`：词只在子节点正文 → 只返回子节点
  - `trigram fallback`：查询 `'补偿金计'`（跨词子串）→ `via:'trigram'` 命中
  - `scoped by folder and doc`
  - `snippet length bounded`（≤ 300 字符）
- [ ] **Step 2:** 运行 → FAIL。 **Step 3:** 实现。 **Step 4:** PASS。
- [ ] **Step 5:** `git commit -m "feat: bm25 + trigram node search"`

### Task 8: 摘要与文档描述（LLM，可选）

**Files:** Create `src/llm/summarize.ts`；Modify `src/library/indexer.ts`（可选摘要阶段）；Test `tests/llm/summarize.test.ts`

**Interfaces:**
- Consumes: `Store`、`TreeNode`、`ai` 的 `generateText`、`LanguageModel`
- Produces:
```ts
interface SummaryOptions { model: LanguageModel; threshold?: number /* SUMMARY_TOKEN_THRESHOLD */; concurrency?: number /* 默认 8 */; maxRetries?: number /* 默认 3 */; describe?: boolean /* 文档描述，默认 true */ }
summarizeDocument(store: Store, docPath: string, opts: SummaryOptions): Promise<{ llmCalls: number; cached: number; usage: { inputTokens: number; outputTokens: number } }>
estimateSummaryCost(store: Store, opts: { threshold?: number }): { nodes: number; llmCalls: number; inputTokens: number }
```
- `indexLibrary` 增加 `summary?: SummaryOptions`；为空则跳过。规则：`ownTokens < threshold` 用原文；否则 LLM；叶子写 `summary`、非叶子写 `prefixSummary`；以节点自身正文 sha256 查 / 写 `summaries` 表。提示词移植 PageIndex `generate_node_summary` / `generate_doc_description`（在 `pageindex/utils.py`），要求输出与原文同语言。摘要写回节点后同步更新 FTS `summary` 列。

- [ ] **Step 1: 写失败测试**（`MockLanguageModelV4` 返回固定文本并计数调用）
  - `short nodes use own text, no LLM call`
  - `long leaf gets summary, long parent gets prefixSummary`
  - `cache hit after unrelated edit`：改另一节后重跑 → 未变节点 `cached` 计数增加、LLM 调用只针对变化节点
  - `concurrency limit respected`（mock 中记录最大并发 ≤ 2）
  - `retries then reports failure without corrupting store`
  - `estimateSummaryCost matches actual llmCalls`
- [ ] **Step 2:** FAIL。 **Step 3:** 实现（并发用简单 promise 池，不引依赖）。 **Step 4:** PASS。
- [ ] **Step 5:** `git commit -m "feat: cached node summaries and document descriptions"`

### Task 9: 工具契约与实现

**Files:** Create `src/tools/envelope.ts`, `src/tools/contract.ts`, `src/tools/impl.ts`, `src/library.ts`；Test `tests/tools/*.test.ts`

**Interfaces:**
- Consumes: `Store`、`searchNodes`、`walk`
- Produces:
```ts
type Envelope = { success: true; data: unknown; next_steps?: unknown } | { success: false; error: string; code: 'NOT_FOUND'|'INVALID_INPUT'|'INTERNAL_ERROR'; details?: unknown; next_steps: { summary: string; options: string[] } }
const TOOL_CONTRACT: Record<ToolName, { description: string; input: z.ZodObject<any> }>
type ToolName = 'browse_documents'|'get_document'|'get_document_structure'|'get_node_content'|'search_documents'
interface Library { store: Store; root: string; callTool(name: ToolName, args: unknown): Promise<string>; close(): void }
openLibrary(opts: { root: string; dbFile?: string /* 默认 `${root}/.markindex/index.db` */; readonly?: boolean }): Library
splitByBudget<T>(items: T[], budget: number): T[][]   // 移植 PageIndex _split_structure / _split_oversized_node
AGENT_INSTRUCTIONS: string                             // 移植 PageIndex agent_tools.py 的 _DISCOVERY/_DECISION/_PERSISTENCE/_TOOL_USAGE_RULES，页 → 节点/行区间，去掉云端专属内容
```
- 各工具入参（zod）：
  - `browse_documents { folder?: string = '', offset?: int ≥0 = 0, limit?: 1..50 = 10 }` → folders、docs（`path,title,description,tokens`）、`next_offset`
  - `get_document { doc_path }` → 元数据 + `read_structure_first: tokens > STRUCTURE_FIRST_TOKEN_THRESHOLD`
  - `get_document_structure { doc_path, node_id?, depth?: 1..10 = DEFAULT_STRUCTURE_DEPTH, part?: int ≥1 = 1 }` → 不含正文；超出 depth 的节点只给 `child_count`；超预算按 `splitByBudget` 分 part，返回 `pagination: { part, total_parts, has_more }`
  - `get_node_content { doc_path, node_ids: string[] (1..20), part?: int ≥1 = 1 }` → 每节点 `title_path, start_line, end_line, text`（行首带行号 `"123│ "`），按预算分 part
  - `search_documents { query, folder?, doc_path?, limit?: 1..50 = 10 }` → `SearchHit[]`
- 工具描述文案：沿用 PageIndex 措辞风格，写明"先 browse/structure，走不通再 search"、"文档超过阈值必须先看结构"、"node_id 从 structure 或 search 结果原样复制"。

- [ ] **Step 1: 写失败测试**
  - `contract snapshot`：`TOOL_CONTRACT` 的名称、`z.toJSONSchema(input)`、描述文本做 vitest 快照（防止文案被无意改动）
  - `never throws`：对每个工具传入 `null`、`{}`、错误类型参数 → 返回可 `JSON.parse` 的 `success:false` 信封
  - `suggests similar doc names`：`get_document {doc_path:'reprot.md'}` → `next_steps.options` 含 `report.md`（最多 3 个，用编辑距离）
  - `stale node id tells agent to refetch structure`
  - `structure depth and node_id expansion`
  - `structure pagination never exceeds budget`：构造 5000 节点文档，每个 part `JSON.stringify` 长度 ≤ `RESPONSE_CHAR_BUDGET`，合并后节点数不变
  - `get_node_content pages an oversized node`
  - `browse paginates and lists subfolders`
- [ ] **Step 2:** FAIL。 **Step 3:** 实现。 **Step 4:** PASS。
- [ ] **Step 5:** `git commit -m "feat: agent tool contract with budgeted envelopes"`

### Task 10: 适配器（AI SDK、MCP）与 CLI

**Files:** Create `src/adapters/ai-sdk.ts`, `src/adapters/mcp.ts`, `src/cli.ts`；Modify `src/index.ts`；Test `tests/adapters/*.test.ts`, `tests/cli.test.ts`

**Interfaces:**
- Consumes: `Library`、`TOOL_CONTRACT`、`AGENT_INSTRUCTIONS`
- Produces:
  - `createAiSdkTools(lib: Library): Record<ToolName, Tool>` —— 每个 `tool({ description, inputSchema: contract.input, execute: args => lib.callTool(name, args) })`
  - `createMcpServer(lib: Library): McpServer` —— `new McpServer({name:'markindex', version}, {instructions: AGENT_INSTRUCTIONS})`，每个工具 `registerTool(name, {description, inputSchema: contract.input.shape, annotations:{readOnlyHint:true}}, ...)`，结果为 `{content:[{type:'text', text}], isError: !success}`
  - CLI（commander）：`markindex index <root> [--db] [--summary-model <provider:model>] [--estimate]`、`markindex tree <root> <doc> [--depth]`、`markindex search <root> <query>`、`markindex mcp <root> [--reindex-on-start]`（stdio）、`markindex eval ...`（Task 12 填充）。`--summary-model` 只支持已安装的 `@ai-sdk/*` provider，动态 import，缺失时给出安装提示。

- [ ] **Step 1: 写失败测试**
  - `ai-sdk tools execute via generateText`：`MockLanguageModelV4` 第一步发起 `search_documents` 调用、第二步结束 → `steps[0].toolResults[0].output` 为成功信封
  - `mcp lists five tools and calls one`：用 SDK 的 `InMemoryTransport` 连 `Client` → `listTools` 5 个；`callTool('browse_documents')` 返回文本信封
  - `cli index then search`：用 `tsx src/cli.ts` 对 fixture 目录执行 → 退出码 0，输出含命中路径
- [ ] **Step 2:** FAIL。 **Step 3:** 实现。 **Step 4:** PASS。
- [ ] **Step 5:** 手动验收：`claude mcp add markindex -- node dist/cli.js mcp <fixture-root>`，在 Claude Code 中跑一次跨文档检索，记录结果到 PR 描述。
- [ ] **Step 6:** `git commit -m "feat: ai-sdk tools, mcp server and cli"`

### Task 11: 内置 retrieve()

**Files:** Create `src/retrieve.ts`；Test `tests/retrieve.test.ts`

**Interfaces:**
- Consumes: `createAiSdkTools`、`AGENT_INSTRUCTIONS`、`Library`
- Produces:
```ts
interface Evidence { docPath: string; nodeId: string; titlePath: string[]; startLine: number; endLine: number; text: string }
retrieve(lib: Library, question: string, opts: { model: LanguageModel; maxSteps?: number /* 12 */; maxInputTokens?: number /* 200_000 */; folder?: string }):
  Promise<{ evidence: Evidence[]; usage: { inputTokens: number; outputTokens: number }; stopReason: 'done' | 'budget' | 'max_steps' }>
```
- 实现：`generateText({ model, system: AGENT_INSTRUCTIONS + 证据选择指令, prompt: question, tools: { ...createAiSdkTools(lib), select_evidence }, stopWhen: [stepCountIs(maxSteps), <累计 usage 超预算的自定义条件>] })`。`select_evidence { items: {doc_path, node_id, start_line?, end_line?}[] }` 是仅 retrieve 内部注册的终止工具（无 execute，调用即停止）；evidence 文本由库按行号重新读取，**不使用模型复述的文本**。

- [ ] **Step 1: 写失败测试**（mock 模型脚本化多步）
  - `returns evidence read from store, not model text`
  - `stops with budget when usage exceeds maxInputTokens`，evidence 为已选部分
  - `stops with max_steps`
  - `invalid evidence refs are dropped`（不存在的 node_id）
- [ ] **Step 2:** FAIL。 **Step 3:** 实现。 **Step 4:** PASS。
- [ ] **Step 5:** `git commit -m "feat: built-in evidence retrieval loop"`

### Task 12: 评测语料、评测工具、规模基准、README

**Files:** Create `eval/fetch-corpus.ts`, `eval/run-eval.ts`, `eval/README.md`, `README.md`；Modify `src/cli.ts`（`eval` 子命令）

**Interfaces:**
- Produces:
  - 问题文件格式（JSONL，每行）：`{ "id": string, "question": string, "lang": "zh"|"en"|"mixed", "gold": [{ "doc_path": string, "title_path"?: string[], "start_line"?: number, "end_line"?: number }] }`。命中判定：返回证据与任一 gold 的行区间有交集（无行号时按 `title_path` 前缀匹配）。
  - `markindex eval <root> --questions q.jsonl --mode tools|retrieve|bm25 --model <provider:model> --out report.json`：输出每题命中、token、步数，以及汇总（hit@证据、平均 token、按 lang 分组）。`bm25` 模式 = `searchNodes` top-5 作基线。

语料（下载到 `eval/corpus/`，加入 `.gitignore`，不提交）：

| 来源 | 内容 | 许可 | 取量 |
|---|---|---|---|
| HF `astr010/sec-10k-markdown-compressed` | 10-K 年报 MD | MIT | ≥ 150 篇，覆盖多家公司 |
| HF `epfl-llm/guidelines`（`clean_text`） | WHO/NICE/CDC 等临床指南 | Common Crawl ToU | 抽最长的 ≥ 100 篇；先抽样确认含 `#` 标题，不含则记录并改用其他来源 |
| 国家法律法规 / 卫健委诊疗规范（官网 HTML → MD） | 中文法规与诊疗指南 | 著作权法第 5 条不适用 | ≥ 50 篇；中英混排题目从含英文术语、药名、标准号的文档中出 |

- [ ] **Step 1:** 写 `fetch-corpus.ts`（HF 用 `https://huggingface.co/datasets/<id>/resolve/main/<file>` 直链；HTML→MD 用 `turndown`，仅作 devDependency），跑通并记录实际篇数、总 token、最长单篇。
- [ ] **Step 2:** 生成评测题：用 LLM 从随机节点出题并以该节点为 gold，人工抽查 30 题；中/英/混排各 ≥ 50 题。保存 `eval/questions.jsonl`（若语料许可允许则提交题目，不提交语料）。
- [ ] **Step 3:** 规模基准（spec §10.3）：对完整语料（≥ 300 篇）记录关闭摘要的全量索引耗时与峰值内存、单文档增量耗时、每个工具 p50/p95 延迟、DB 文件大小，写入 `eval/README.md`，并据此提出门槛供用户确认。
- [ ] **Step 4:** 跑 `bm25`、`tools`、`retrieve` 三种模式，结果写入 `eval/README.md`；用结果标定 `MAX_NODE_TOKENS`、`ROUTING_COST_TOKENS`、`STRUCTURE_FIRST_TOKEN_THRESHOLD`、`DEFAULT_STRUCTURE_DEPTH`，改动 `src/config.ts` 时附数据。
- [ ] **Step 5:** `README.md`：安装、CLI、库用法、MCP 接入（Claude Code / Cursor 配置）、评测工具用法与问题文件格式（供用户内部验收）。
- [ ] **Step 6:** `git commit -m "feat: eval harness, corpus scripts and benchmarks"`
