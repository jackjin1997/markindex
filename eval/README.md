# MarkIndex evaluation

This folder holds the retrieval evaluation tool's documentation, the development corpus scripts, the development
question set and the measured results. The tool itself is the `markindex eval` command (code in `src/eval/`), so
you can run it on any library — in particular on your own internal documents for the final acceptance.

- [1. Running an evaluation on your own documents](#1-running-an-evaluation-on-your-own-documents)
- [2. Question file format](#2-question-file-format)
- [3. Modes and the report](#3-modes-and-the-report)
- [4. Development corpus](#4-development-corpus)
- [5. Development question set](#5-development-question-set)
- [6. Results: BM25 baseline](#6-results-bm25-baseline)
- [7. Scale benchmark and proposed thresholds](#7-scale-benchmark-and-proposed-thresholds)
- [8. Calibration of the defaults](#8-calibration-of-the-defaults)
- [9. Issues found while evaluating](#9-issues-found-while-evaluating)

## 1. Running an evaluation on your own documents

```bash
# 1. index the folder (no LLM calls)
npx markindex index /path/to/docs

# 2. write questions.jsonl (format below); find gold line ranges with
npx markindex tree /path/to/docs some/doc.md --depth 4          # node titles + L<start>-<end>
npx markindex search /path/to/docs "a distinctive phrase" --json   # docPath, titlePath, startLine, endLine

# 3. keyword baseline — free, no model
npx markindex eval /path/to/docs --questions questions.jsonl --mode bm25 --out bm25.json

# 4. the LLM agent (the built-in retrieve() loop over the five tools) — uses your model and API key
npm install @ai-sdk/anthropic            # or @ai-sdk/openai, @ai-sdk/google, ...
export ANTHROPIC_API_KEY=...
npx markindex eval /path/to/docs --questions questions.jsonl --mode agent \
  --model anthropic:claude-sonnet-5-5 --concurrency 4 --out agent.json
```

Agent mode prints the agent table followed by the BM25 baseline on the same questions (skip it with
`--no-baseline`). Progress goes to stderr (`[12/150] zh-012 HIT`), the summary table to stdout, and the full
per-question report to `--out` (`--json` prints the full report to stdout instead).

Cost control for agent mode: `--max-steps <n>` (default 12 model steps per question) and
`--max-input-tokens <n>` (default 200 000 input tokens per question; the loop stops and keeps the evidence it has
read). Expect roughly `questions × (5–12 steps)` model calls. Try a 10-question file first and look at
`avgTokens` before running the full set.

`--model` takes `<provider>:<model>`: MarkIndex imports `@ai-sdk/<provider>` and calls its `<provider>(model)`
factory, exactly like `markindex index --summary-model`. Any AI SDK provider package that follows that naming
works (`anthropic:…`, `openai:…`, `google:…`, `mistral:…`, …).

## 2. Question file format

JSONL: one JSON object per line, UTF-8, blank lines ignored.

```json
{"id": "hr-001", "question": "员工辞职需要提前多久通知？", "lang": "zh", "gold": [{"doc_path": "人事/员工手册.md", "start_line": 120, "end_line": 134}]}
{"id": "hr-002", "question": "How many days of annual leave do new hires get?", "lang": "en", "gold": [{"doc_path": "hr/handbook.md", "title_path": ["Leave", "Annual leave"]}]}
{"id": "it-007", "question": "VPN 的 MFA 怎么配置？", "lang": "mixed", "gold": [{"doc_path": "it/vpn.md", "start_line": 40, "end_line": 66}, {"doc_path": "it/faq.md"}], "note": "two acceptable sources"}
```

| Field | Required | Meaning |
|---|---|---|
| `id` | yes | Unique, non-empty string. |
| `question` | yes | The question as a user would ask it. |
| `lang` | yes | `"zh"`, `"en"` or `"mixed"` (Chinese with English terms / acronyms / drug names / standard numbers, or the reverse). Used for the per-language breakdown. |
| `gold` | yes | Non-empty list of acceptable answer locations; matching **any one** counts as a hit. |
| `gold[].doc_path` | yes | Library-relative path, exactly as `markindex search` / `tree` print it (case-sensitive, with extension). |
| `gold[].start_line`, `gold[].end_line` | optional, together | 1-based inclusive line range **in the original file** (front matter lines count). |
| `gold[].title_path` | optional | Titles from the top-level section down to the answer node, as in `titlePath` of `markindex search --json` (the document title itself is not included unless it is a heading in the file). Used only when no line range is given. |
| `note` | optional | Free text, ignored. |

Unknown fields are rejected (so a typo such as `startLine` cannot silently turn a line-level gold into a
document-level one).

**Hit rule.** A returned evidence item hits a gold location when it is in the same document and

1. the gold has a line range → the two line ranges overlap (inclusive);
2. otherwise the gold has a `title_path` → one title path is a prefix of the other (the evidence is inside the gold
   section, or contains it);
3. otherwise (only `doc_path`) → any evidence from that document hits.

Prefer line ranges: they survive heading renames and are what citations use. Keep gold ranges tight (the paragraph
or section that actually answers the question): a gold range spanning a whole chapter makes almost any evidence
from that chapter a hit.

**Validation.** Before running, the file is parsed and all problems are reported at once with line numbers;
then every gold is checked against the index (document exists, line range inside the file, title path names a
node). Nothing runs until both checks pass:

```
markindex: 2 problem(s) in the question file:
questions.jsonl:2: invalid JSON (Expected double-quoted property name in JSON at position 13 (line 1 column 14))
questions.jsonl:5: lang: Invalid option: expected one of "zh"|"en"|"mixed"; gold.0: unknown field(s) "startLine"

markindex: 1 problem(s) in the question file:
questions.jsonl:9: question "q9": gold doc_path "Handbook.md" is not in the index (use a library-relative path as printed by `markindex search`)
```

## 3. Modes and the report

| Mode | What runs | Evidence judged | `tokens` | `steps` |
|---|---|---|---|---|
| `bm25` | `searchNodes(question)` top-k (default 5, `--top-k`), no LLM — the "plain keyword search" baseline | each hit node's **own** text range (`startLine..ownEndLine`: the text BM25 actually scored, not the node's whole subtree) | approx. tokens of the hits as JSON, i.e. what an agent would read | 1 |
| `agent` | `retrieve()`: `generateText` + the five library tools + `AGENT_INSTRUCTIONS` + a final `select_evidence` call | the line ranges the model selected (text is re-read from the index) | model input + output tokens | model steps |

**Why one `agent` mode instead of separate `tools` and `retrieve` modes.** The plan listed a "tools" mode (an
agent driving the library tools) and a "retrieve" mode (the built-in loop). In this codebase they are the same
thing: `retrieve()` *is* an agent loop of `generateText` over `createAiSdkTools(lib)` with `AGENT_INSTRUCTIONS`,
plus `select_evidence` so the evidence can be judged. A separate "tools" mode would only differ in how the final
evidence is extracted from free text, which would measure answer parsing rather than retrieval. So both are one
mode, `agent`; `--mode tools` and `--mode retrieve` are accepted as aliases. External agents (Claude Code, Cursor)
use the same tool contract over MCP, so this measures the tool contract + instructions with your model.

`hitAt1` and `mrr` use the order of the evidence list; they are meaningful for the ranked `bm25` output and only
indicative for `agent` (the model's selection order).

Report (`--out`):

```jsonc
{
  "mode": "agent", "model": "anthropic:claude-sonnet-5-5", "createdAt": "…",
  "options": { "maxSteps": 12, "maxInputTokens": 200000 },
  "summary": {
    "overall": { "questions": 150, "hits": 120, "hitRate": 0.8, "hitAt1": 0.7, "mrr": 0.74,
                 "avgTokens": 41000, "avgSteps": 7.2, "errors": 0 },
    "byLang": { "zh": { … }, "en": { … }, "mixed": { … } }
  },
  "baseline": { "mode": "bm25", "topK": 5, "summary": { … } },
  "results": [
    { "id": "zh-001", "lang": "zh", "hit": true, "rank": 1, "tokens": 38211, "steps": 6, "stopReason": "done",
      "evidence": [{ "docPath": "…", "titlePath": ["…"], "startLine": 295, "endLine": 306 }] }
  ]
}
```

A question whose model call fails (rate limit, network) is recorded with `error`, counted as a miss and in
`errors`, and the run continues.

## 4. Development corpus

Downloaded by `npx tsx eval/fetch-corpus.ts` into `eval/corpus/` (gitignored; ~146 MB on disk, idempotent re-runs).
Token counts use MarkIndex's approximate counter (CJK character = 1, other characters / 4).

| Group | Source | License | Docs | Approx. tokens | Docs ≥ 100k tokens | Longest |
|---|---|---|---:|---:|---:|---|
| `finance-en/` | SEC 10-K filings, HF [`astr010/sec-10k-markdown-compressed`](https://huggingface.co/datasets/astr010/sec-10k-markdown-compressed): 20 companies (JPM, C, BX, AES, KEY, AFL, ELV, AIZ, DVA, CYH, AAPL, MSFT, GOOGL, AMZN, NVDA, TSLA, META, UNH, WMT, XOM) × latest 8 filings (2017–2025) | MIT | 160 | 27.87 M | 121 | `JPM/10-K_2020.md` 413 906 |
| `medical-en/` | Clinical guidelines, HF [`epfl-llm/guidelines`](https://huggingface.co/datasets/epfl-llm/guidelines) `clean_text`: the 110 longest guidelines with ≥ 8 `#` headings, ≤ 40 per source (CDC 40, WHO 24, PubMed 22, ICRC 11, NICE 4, WikiDoc 4, CMA 3, SPOR 2) | Common Crawl ToU (open, redistributable subset) | 110 | 9.30 M | 23 | `icrc/d43b425b5762e4e0.md` 407 770 |
| `zh/law-wikisource/` | PRC laws, regulations and the NHC COVID-19 诊疗方案 (第八版, 第十版), latest version of each from zh.wikisource | Official texts — not copyright-protected (著作权法 第5条) | 39 | | | `中华人民共和国民法典.md` 104 220 |
| `zh/wikipedia/` | Long zh.wikipedia finance / medical articles rich in English terms (COVID-19, 糖尿病, 肺癌, 比特币, 联邦储备系统, …) | CC BY-SA 4.0 — local evaluation only | 20 | | | |
| **total** | | | **329** | **38.14 M** | **145** | |

(`zh/` together: 59 docs, 0.97 M tokens.)

What the corpus covers on purpose: English filings with poor structure (converted HTML, few headings, huge tables,
running page headers), well-structured English guidelines (deep `#` outlines), Chinese statutes (编/章/节/条),
Chinese encyclopedia articles with dense English terms, and very large single documents (up to ~414k tokens).

Preprocessing (in `eval/lib/headings.ts`, unit-tested, never changes the line count):

- **SEC 10-K.** The converted Markdown has almost no `#` headings (e.g. AAPL 2016–2025: zero) and separates pages
  with bare `---` lines while having no blank lines between paragraphs. Per CommonMark every `---` therefore turns
  the whole preceding page into one giant setext heading (before the fix, over half of the finance nodes had
  multi-kilobyte titles). The fetch script rewrites bare `---` lines to `***` (still a thematic break, never a
  setext underline) and promotes `PART I` / `Item 1A.` lines (plain or single-cell table rows) to h1 / h2, skipping
  running page headers that repeat the current PART / Item. Filings that already had ≥ 5 headings keep them; some
  (e.g. CYH, BX) use a repeated `##### Table of Contents` page header, which is left as is — realistic noise.
- **epfl-llm/guidelines.** Sampled first: 239 of the first 255 records (94%) had ≥ 3 `#` headings; over the full file
  (37 970 records) 14 854 have ≥ 8. Texts are used unchanged (front matter with title, source and URL added).
- **Chinese.** nhc.gov.cn answers scripted requests with HTTP 412 and flk.npc.gov.cn is a JavaScript-only app, so
  official texts come from their zh.wikisource transcriptions (MediaWiki `action=parse`, rendered HTML → Markdown
  with `turndown`, links / references / navboxes dropped). Wikisource already marks 章/节 as headings; the
  第X编 / 第X章 / 第X节 / 一、/（一） reconstruction only applies when a page has fewer than 3 headings. Pages shorter
  than 8 000 characters are skipped (银行业监督管理法, 中医药法, … ; see the script log).

## 5. Development question set

`eval/questions.jsonl`: **151 questions — 63 zh, 54 en, 34 mixed** — each with one line-range gold.

How they were made (no LLM API was available, and no money was spent): candidate nodes were sampled with
`eval/sample-nodes.ts` (leaf nodes with 120–4 000 own tokens, at most 2 per document) using fixed seeds —
`--group finance-en --seed 101`, `--group medical-en --seed 102`, `--group zh --seed 103`,
`--group zh --latin --seed 104` — and the questions were written by hand from each node's text, gold = that node's
line range. Questions paraphrase rather than copy the node title. Mixed questions are Chinese questions containing
English terms: 28 on Chinese documents that use those terms (e.g. `PaO2/FiO2`, `HFNC`, `BNT162b2`, `FOMC`) and 6
cross-lingual ones on English documents (drug names, `PCSK9`, `JAK1`, SEC file numbers).

Known biases — read the BM25 numbers with them in mind:

- Questions were written *from* the gold text, so they share vocabulary with it; this favours BM25 compared with
  real users' questions.
- Each question has exactly one gold, but 10-K text is largely repeated year over year (same company, 8 filings).
  A hit in the 2018 filing for a question about the 2019 one counts as a miss, which is the right call for
  questions that name a year and harsh for those that do not.

## 6. Results: BM25 baseline

`markindex eval eval/corpus --questions eval/questions.jsonl --mode bm25` (full reports in `results/`):

| Set | n | hit@5 | hit@10 | hit@1 | MRR@5 | avg tokens (top-5 response) |
|---|---:|---:|---:|---:|---:|---:|
| overall | 151 | **80.1%** | 88.7% | 63.6% | 0.709 | 1 182 |
| zh | 63 | 93.7% | 98.4% | 79.4% | 0.856 | 1 545 |
| en | 54 | 64.8% | 77.8% | 38.9% | 0.506 | 645 |
| mixed | 34 | 79.4% | 88.2% | 73.5% | 0.757 | 1 362 |

By source (hit@5): zh statutes + wiki (zh) 59/63, zh with English terms 25/28, medical-en 27/32,
medical cross-lingual 2/4, **finance-en 8/22**, finance cross-lingual 0/2.

Observations:

- Chinese and mixed Chinese/English keyword search works: the `Intl.Segmenter` + trigram fallback finds
  `PaO2/FiO2`, `BNT162b2`, `MAO-B` and statute wording; most misses are near misses in the right document.
- Finance is where keyword search breaks down. Of the 16 finance misses, 12 returned the right company but a
  different year or a neighbouring page of near-identical boilerplate — exactly the case where browsing
  (`finance-en/CYH/` → `10-K_2019.md` → `Item 7`) should beat keyword ranking. This is the main thing the agent
  run should show.
- Cross-lingual questions (Chinese question, English document) only match through the English terms they contain.

**Agent mode was not run here**: no LLM API key is available in the development environment. It is implemented
and tested offline with a mock model (`tests/eval/run.test.ts`, `tests/cli.test.ts`). To produce the agent numbers
on this corpus:

```bash
npx tsx eval/fetch-corpus.ts && npx markindex index eval/corpus
npx markindex eval eval/corpus --questions eval/questions.jsonl --mode agent \
  --model anthropic:claude-sonnet-5-5 --concurrency 4 --out eval/results/agent.json
```

## 7. Scale benchmark and proposed thresholds

`npx tsx eval/bench.ts` on the full corpus (329 docs, 38.1 M approx. tokens, summaries OFF), Apple M4, 32 GB,
Node 24.5, macOS. Raw numbers: [`results/bench.json`](results/bench.json).

| Measure | Result |
|---|---|
| Full index from empty DB | **88.4 s** (329 docs; ~430k tokens/s) |
| Peak RSS during full index | **1 764 MB** |
| No-op re-index (nothing changed: scan + hash 329 files) | 0.08 s |
| Single-document update (`JPM/10-K_2024.md`, 397k tokens, one line appended), incl. scan of the library | **1.40 s**, peak RSS 881 MB |
| DB size (SQLite + WAL) | **872 MB** (corpus 146 MB) — trigram FTS 519 MB, word FTS 193 MB, original lines 149 MB, nodes 8 MB |
| Nodes | 38 329 (3 065 `chunk` nodes, 3 041 of them in finance) |

Tool latency, 60 calls each with seeded arguments drawn from the corpus (random folders, documents, node ids,
30 en/zh queries), warm in-process library:

| Tool | p50 | p95 | max | largest response |
|---|---:|---:|---:|---:|
| `browse_documents` | 0.10 ms | 0.26 ms | 1.3 ms | 4.9k chars |
| `get_document` | 0.01 ms | 0.01 ms | 0.2 ms | 0.8k chars |
| `get_document_structure` | 0.09 ms | 0.84 ms | 2.4 ms | 94.9k chars (paginated) |
| `get_node_content` | 0.40 ms | 2.93 ms | 4.1 ms | 94.9k chars (paginated) |
| `search_documents` | 5.3 ms | 33.0 ms | 51 ms | 7.3k chars |

Where the cost is: peak memory comes from building the mdast of the largest files — parsing `JPM/10-K_2020.md`
(1.7 M chars, table-heavy) alone peaks at ~900 MB RSS and takes ~1 s. Search time is dominated by common English
terms over 38k nodes plus the trigram pass.

**Proposed thresholds (for the user to confirm; not asserted in tests).** For a library of this size (~330 docs,
~40 M tokens) on a developer laptop, with summaries off:

| Measure | Proposed limit | Measured | Headroom |
|---|---|---|---|
| Full index | ≤ 5 min | 1.5 min | 3.4× |
| Peak RSS, full index | ≤ 3 GB | 1.8 GB | 1.7× |
| Single-document update (incl. library scan) | ≤ 5 s | 1.4 s | 3.6× |
| No-op re-index | ≤ 2 s | 0.08 s | — |
| `browse_documents`, `get_document` p95 | ≤ 10 ms | < 0.3 ms | — |
| `get_document_structure`, `get_node_content` p95 | ≤ 50 ms | < 3 ms | — |
| `search_documents` p95 | ≤ 200 ms | 33 ms | 6× |
| Any tool response | ≤ 95 000 chars | 94 918 | by construction |
| DB size | ≤ 8× corpus bytes | 6.0× | 1.3× |

The memory and DB-size limits are the tight ones. If they matter for your deployment, the two cheapest levers are
(a) contentless FTS tables (the FTS content columns duplicate the stored lines: ~300 MB here) and (b) streaming
the parse of very large files; neither is done in this version.

## 8. Calibration of the defaults

Structure statistics of the indexed corpus (from `results/bench.json`):

- Node own tokens: p50 211, p75 655, p90 2 691, p99 7 881, max 8 420 (one single line longer than the limit).
- Depth: p75 = 1, p90 = 2, max 4 — real documents here are flat; 10-K trees are PART → Item → chunks.
- 289 of 329 documents (88%) are above `STRUCTURE_FIRST_TOKEN_THRESHOLD` (15 000).
- `get_document_structure` first-part size by depth (p50 / p90 chars): depth 1: 1.4k / 36.6k; **depth 2: 4.7k /
  37.6k**; depth 3: 7.4k / 38.4k. Only 4 documents need a second part at any depth.

| Default | Value | Verdict |
|---|---|---|
| `MAX_NODE_TOKENS` | 8 000 | **Keep.** An 8 000-token node is ≤ ~32k chars of English or ~8k CJK chars, so one `get_node_content` part (95k chars) always holds a whole node — lowering it buys no pagination savings and would multiply the finance `chunk` nodes (already 3 041), raising the cost of reading structure. Whether a smaller limit improves agent precision needs the agent run. |
| `STRUCTURE_FIRST_TOKEN_THRESHOLD` | 15 000 | **Keep.** 15k tokens is ≤ ~60k chars of English or ~15k CJK chars — a document under the threshold fits in one response, so "read it directly" is safe; documents above it do not, so the threshold coincides with the response budget. |
| `DEFAULT_STRUCTURE_DEPTH` | 2 | **Keep.** Depth 2 shows 3.3× more nodes than depth 1 at the median (31 vs 9) for ~3.3k extra chars; depth 3 adds little because trees are shallow; the p90 response is the same at all depths (wide flat outlines). |
| `ROUTING_COST_TOKENS` | 150 | **Keep (not calibratable offline).** It only decides merges of small subtrees; with summaries off the true routing cost is a title line (~20 tokens), with summaries it is ~100–200. Its effect is on how many steps the agent needs, which only the agent run measures. |

`src/config.ts` is unchanged: the BM25 baseline does not depend on these values (it ranks node own text, which merges
change only marginally), and the structure statistics support the current values. Re-check after the agent run:
if agent precision suffers from long `chunk` reads, try `MAX_NODE_TOKENS` 4 000; if agents spend many steps
expanding outlines, try `DEFAULT_STRUCTURE_DEPTH` 3.

## 9. Issues found while evaluating

- **Fixed: duplicate node ids** (5 guidelines failed to index with `UNIQUE constraint failed: nodes.doc_path,
  nodes.node_id`). Two same-title sections (e.g. two `# Conclusions`) with same-title children (`## Harms`)
  produced identical ids for the children, because the id hashes the title path plus the node's own same-title
  ordinal. Ids are now assigned in document order and only a node whose title-path id is **already taken** falls
  back to a disambiguated key (the JSON-encoded chain of ancestor titles and their same-title ordinals). Every id
  that was unique before is unchanged. Regression tests in `tests/tree/build.test.ts`. The question set and
  results reference documents by path and line range only, so they are unaffected (the BM25 run reproduces
  byte-identical results after re-indexing).
- **Converter artifacts can create giant setext headings.** Markdown converted from HTML/PDF often has no blank
  lines between paragraphs and uses `---` as a page separator; CommonMark then makes each page a level-2 setext
  heading whose title is the whole page. MarkIndex follows CommonMark (spec §5.1), so such files get huge titles.
  The dev corpus is pre-processed (section 4); if your internal documents come from a converter, check
  `markindex tree` for very long titles. A parser option to ignore multi-line setext headings would be a
  reasonable follow-up.
- **Memory for very large table-heavy files** — see section 7.
