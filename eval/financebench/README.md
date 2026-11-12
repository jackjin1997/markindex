# FinanceBench

MarkIndex on the 150 open-source questions of [FinanceBench](https://github.com/patronus-ai/financebench)
([paper](https://arxiv.org/abs/2311.11944)): questions about US public-company filings (10-K, 10-Q, 8-K, earnings
releases) whose answers sit on one or a few pages of a filing, often with a calculation on top.

The setup follows the one VectifyAI used for [Mafin2.5 / PageIndex](https://github.com/VectifyAI/Mafin2.5-FinanceBench):
every filing sits in **one** library, the agent is not told which filing a question is about, and answers are judged
with Mafin2.5's own judge prompt.

## Results

Agent: Claude Code in headless mode with `claude-sonnet-5-5`, one fresh session per question, whose **only** tools are
the five MarkIndex MCP tools (no file reading, no shell, no web). Runs of 2026-11-09.

| Library | Judge: Mafin2.5 prompt, Sonnet | Same prompt, Opus | Strict prompt, Opus | 3-judge majority | Adjudicated | Right filing cited | Evidence page cited | Mean turns | Cost |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| **all 367 filings** | 88.0% | 90.0% | 87.3% | 88.7% | **92.0%** | 88.7% | 68.0% | 5.4 | $8.45 |
| the 84 filings the questions use | 88.0% | 90.0% | 85.3% | 87.3% | **92.0%** | 96.7% | 74.0% | 5.2 | $8.03 |

All 150 questions in both runs. Adjudicated accuracy by question type, full library: domain-relevant 96%,
metrics-generated 96%, novel-generated 84% (84 filings: 92%, 98%, 86%). Cost is Claude Code's own estimate for the
agent and the first judge, about $0.05 per question. Per-question results:
[`results/lib367-sonnet.json`](results/lib367-sonnet.json), [`results/lib84-sonnet.json`](results/lib84-sonnet.json)
(answers, cited line ranges, judge votes; join on `id` with the dataset for the question text).

What the columns mean:

- **Judges.** The first is Mafin2.5's `check_answer_equivalence` prompt, verbatim, run by `claude-sonnet-5-5`
  (Mafin2.5 ran it with `gpt-4o-2024-11-20`; no OpenAI key was used here). The second is the same prompt run by
  `claude-opus-5-5`. The third is a stricter prompt run by `claude-opus-5-5` that only accepts the golden figure or
  conclusion ([`rejudge.ts`](rejudge.ts)). The two Opus judges agree with the first on 98% of the full-library
  answers (95–96% on the 84-filing run).
- **3-judge majority.** Correct when at least two of the three judges say so.
- **Adjudicated.** The majority, except for questions Mafin2.5's human reviewers labeled as a benchmark error (BE),
  multiple valid approaches (MVA) or same evidence, different conclusion (SEDC). Mafin2.5 counts those as correct for
  itself. Such a question counts as correct here only when our answer reaches the same conclusion as Mafin2.5's
  reviewed answer. That applied to 5 questions in the full-library run and 7 in the 84-filing run. Each case is
  listed with its reason in [`review-lib367.json`](review-lib367.json) and [`review-lib84.json`](review-lib84.json),
  including the flagged questions that stayed wrong. No other question was re-graded.
- **Right filing / evidence page cited.** Whether any cited line range is in a filing, or on a page, that FinanceBench
  lists as evidence. With all 367 filings in the library the agent more often answered from another filing of the
  same company, such as an earnings release instead of the 10-K. 14 of the 17 such answers were still correct.

The two runs land on the same adjudicated score, but they are not identical: two questions flip in each direction
between them (listed under "Where it fails"). Read differences of a few points between runs or setups as noise.

### Controlled baselines: same model, same judge

What does the same library give other retrieval setups? All rows below use the 150 questions, all 367 filings in one
library, `claude-sonnet-5-5` unless noted, and one judge (Mafin2.5's prompt run by `claude-sonnet-5-5`). Runs of
2026-11-12.

| Setup | Model | Accuracy | Right filing cited | Evidence page cited | Mean turns | Cost |
|---|---|---:|---:|---:|---:|---:|
| Single shot, BM25, top-10 pages in one prompt | Sonnet 5.5 | 24.0% | 24.7% | 13.3% | 1 | $11.77 |
| Single shot, dense (bge-base-en-v1.5), top-10 pages | Sonnet 5.5 | 53.3% | 58.0% | 31.3% | 1 | $11.88 |
| Single shot, dense, top-20 pages | Sonnet 5.5 | 67.3% | 74.0% | 44.7% | 1 | $21.35 |
| Agent over flat page chunks (BM25 search + read page) | Sonnet 5.5 | 89.3% | 90.7% | 71.3% | 3.9 | $7.07 |
| Agent, MarkIndex with `search_documents` + `get_node_content` only | Sonnet 5.5 | 88.0% | 88.0% | 70.0% | 4.2 | $8.50 |
| **Agent, MarkIndex, five tools** (the run above) | Sonnet 5.5 | 88.0% | 88.7% | 68.0% | 5.4 | $8.45 |
| Agent over flat page chunks | Haiku 5.5 | 88.0% | 88.0% | 74.0% | 5.4 | $1.61 |
| Agent, MarkIndex, five tools | Haiku 5.5 | 90.7% | 91.3% | 78.7% | 6.4 | $1.69 |

What this shows, with exact McNemar tests on paired outcomes ([`compare.py`](compare.py)):

- **The agent loop is what beats single-shot retrieval.** The MarkIndex agent is 20.7 points above the strongest
  single-shot setup (34 questions only the agent gets right, 3 the other way, p = 1.2e-7) at 40% of its cost.
  With the question as the query, BM25 has an evidence page in its top 10 for 14% of the questions and the dense
  retriever for 34% ([`results/retrieval-recall.json`](results/retrieval-recall.json)); an agent that writes its own
  queries and reads on gets to 88-89% over the same kind of keyword index.
- **The tree-navigation tools do not add accuracy here.** Without `browse_documents`, `get_document` and
  `get_document_structure` the agent scores the same 88.0% (3 questions each way) in 1.2 fewer turns.
- **The section tree does not beat flat chunks here.** An agent with a plain BM25 search over page chunks and a
  read-page tool ([`flat_server.ts`](flat_server.ts)) reaches 89.3% with Sonnet (4 against 6 discordant questions,
  p = 0.75). With Haiku MarkIndex is ahead, 90.7% against 88.0%, but 5 against 1 discordant questions is not
  significant (p = 0.22).
- **A small model is enough.** Haiku 5.5 with MarkIndex costs $1.69 for the 150 questions including the judge.
- **Indexing cost.** MarkIndex indexes the 367 filings from scratch in 233 s on one CPU process (Apple M4) with no
  model call. Embedding the 205,542 chunks of the dense baseline took about five hours on the same machine's GPU.
  The flat BM25 baseline is as cheap to index as MarkIndex.

So on this benchmark MarkIndex's accuracy comes from giving an agent a cheap lexical index with line-addressed
reading, not from the tree. [`../qasper`](../qasper/README.md) repeats the comparison on research papers, where
single-shot retrieval already finds the evidence and all setups perform alike.

Caveats: the baselines have one judge (no Opus re-judges, majority or adjudication), so compare them with the 88.0%
column, not with 92.0%. The dense retriever is an open model of moderate size without a reranker. In the tool
ablation the server instructions still mention the removed tools. Per-question files:
`results/single-*.json`, `results/agent-*.json`.

**How the baselines are built.** [`baseline_retrieve.py`](baseline_retrieve.py) cuts every page into chunks of at
most 1,200 characters with a "company | document type | period" header, ranks them with SQLite FTS5 BM25, with
`BAAI/bge-base-en-v1.5` embeddings or with both (reciprocal rank fusion), and turns chunk ranks into page ranks.
[`baseline.ts`](baseline.ts) puts the top-k pages into one prompt with no tools. [`flat_server.ts`](flat_server.ts)
is an MCP server over the same chunks with two tools, `search_chunks` and `get_page_content`; it uses MarkIndex's
snippet length and response budget, and `run.ts --flat-chunks` runs the same agent loop, prompt and judge over it.
`run.ts --only-tools` removes MarkIndex tools from the model's context.

### Context: other results on the same 150 questions

| System | Accuracy | Graded by | Source |
|---|---:|---|---|
| GPT-4-Turbo, one vector store for all filings | 19% | humans | FinanceBench paper, Table 2 |
| GPT-4-Turbo, one vector store per filing | 50% | humans | FinanceBench paper, Table 2 |
| GPT-4-Turbo, the whole filing in the prompt | 79% | humans | FinanceBench paper, Table 2 |
| GPT-4-Turbo, given the evidence pages (oracle) | 85% | humans | FinanceBench paper, Table 2 |
| Mafin2.5 (PageIndex), all filings in one database | 98.7% | LLM judge, then human review of all 150 answers | Mafin2.5-FinanceBench |
| **MarkIndex + Claude Sonnet 5.5, all 367 filings in one library** | **92.0%** adjudicated, 88.7% majority | 3 LLM judges + Mafin2.5's review labels | this folder |

Read this table with care:

- **It is not a controlled comparison of retrieval methods.** The paper's numbers come from GPT-4-Turbo in 2023.
  The model matters at least as much as the retrieval layer. For same-model baselines see the section above.
- **Grading differs.** Mafin2.5's 98.7% is 148 of 150 answers labeled AL / BE / MVA / SEDC by its reviewers, after
  human review of every answer. Ours is graded by LLM judges. Mafin2.5's labels are borrowed only for the questions
  they flagged, and only where our answer agrees with theirs.
- **Input format differs.** PageIndex reads the PDFs. MarkIndex reads Markdown converted from them (below), so
  conversion quality is part of what this measures.

### Where it fails

The 12 questions that are wrong after adjudication in the full-library run:

- **Finding the passage (4).** One question names no company. The agent assumed Amcor without searching the library
  for the right one (Ulta Beauty, `00601`). In Pfizer `00283` it answered from the 2019 10-K instead of the Q2 2023
  10-Q, a mistake the 84-filing run, which has no 2019 Pfizer filing, did not make. In Boeing `00494` it read the
  777X-9 program note ("paused during 2022 and 2023") instead of the risk-factor sentence on the evidence page
  ("expected to resume in 2023"). In AMD `00757` it found the receivables concentration (18%) but not the customer
  that made up 16% of revenue.
- **Calculation or definition (5).** In AES `10420` (ROA) the agent used consolidated net loss instead of the loss
  attributable to AES (−1.42% vs −1.53%). In MGM `01911` it left rent out of Adjusted EBIT. In JPMorgan `02119` it
  gave book value per common share ($82.31) where the gold answer is $66.56. In Corning `02981` it left the
  amortization of purchased intangibles out of operating income (11.3% vs 10.3%), which the 84-filing run got right.
  In 3M `00807` it computed a quick ratio of 0.85 from cash, securities and receivables, while the gold answer uses
  current assets less inventory (0.96).
- **Interpretation (3).** In J&J `00651` it used reported rather than operational EPS guidance (4.0% vs 3.5% growth
  at the midpoint). In PepsiCo `01328` it answered 0 because the income statement has no restructuring line, while
  the gold answer takes $411M from the notes. In Pfizer `02416` it listed the pending Arena acquisition, the same
  mistake Mafin2.5 made.

The 84-filing run got Pfizer `00283` and Corning `02981` right but missed two Verizon questions: an addition error
on total debt (`00566`) and a hedged conclusion on a correct quick ratio (`00216`).

## Method

**Documents.** [`fetch.py`](fetch.py) downloads the questions, the document list and all 368 PDFs of the FinanceBench
repository. The questions use 84 of them. The document list covers 360 filings (one is listed twice). For the 8
PDFs it misses, [`convert.py`](convert.py) infers company, type and period from the file name. One PDF in the
repository (`ACTIVISIONBLIZZARD_2016_10K`, 15 KB) has no readable pages, so the full library has 367 filings:
53,870 pages, 1.79 million lines and a 1.3 GB index.

`convert.py` converts each PDF with pymupdf4llm 2.1 in layout mode, falling back to its classic mode when layout
analysis fails. It writes `md/<company>/<filing>.md` and records each page's line range in `md-pages/<filing>.json`.
Each filing starts with front matter (company, document type, period, sector), and each page starts with an
`<!-- page N -->` line. Headings are cleaned up without adding or removing lines: "PART I" becomes h1, "Item 7."
becomes h2 and every other heading h3, so a 10-K's outline is PART › Item › section. Converting all filings took
several hours with 4 workers on a 10-core Apple Silicon Mac, about 150 s for a typical 10-K. The 84 question filings
went through an earlier per-page heading pass and then `convert.py --refix`. Files converted now in one pass can
differ from them only in running page headers.

**Gold locations.** FinanceBench gives each answer's evidence as a 0-based PDF page. That page's line range in the
converted file is the gold location used for "evidence page cited".

**Agent.** [`run.ts`](run.ts) starts one `claude -p` session per question with the MarkIndex MCP server
(`markindex mcp`) as its only tool source, `--tools ""` to remove the built-in tools and `--setting-sources ""` to
ignore local settings. It allows up to 30 turns and 600 s per question and runs 3 questions at a time. The prompt
describes the library layout (one folder per company, front matter, page markers) and asks for a JSON reply with the
answer and at most 5 cited line ranges. The report is rewritten after every question, and a re-run resumes it.

**Judging.** `run.ts` judges with Mafin2.5's prompt. [`rejudge.ts`](rejudge.ts) re-judges the same answers with
another model or the strict prompt. [`adjudicate.ts`](adjudicate.ts) computes the majority and the adjudicated score
and writes the shareable report without the dataset's question and answer text (FinanceBench is CC BY-NC 4.0). A
review entry records a hash of the answer it reviewed, and `adjudicate.ts` refuses it if the run's answer differs.

## Reproduce

Converting all 368 PDFs takes a few hours. Add `--only-questions` to convert just the 84 that the questions use.
A run spends Claude usage: about $8 for the agent and the first judge, plus the two re-judges.

```bash
cd eval/financebench
python3 -I fetch.py
uv venv -p 3.12 .venv && uv pip install -p .venv/bin/python pymupdf4llm
.venv/bin/python -I convert.py --workers 4
cd ../.. && npm run build
node dist/cli.js index eval/financebench/md --db eval/financebench/runs/lib.db
npx tsx eval/financebench/run.ts --root eval/financebench/md --db eval/financebench/runs/lib.db --all --out eval/financebench/runs/full150.json
npx tsx eval/financebench/rejudge.ts --in eval/financebench/runs/full150.json --judge-model opus --prompt mafin --out eval/financebench/runs/full150.opus-mafin.json
npx tsx eval/financebench/rejudge.ts --in eval/financebench/runs/full150.json --judge-model opus --prompt strict --out eval/financebench/runs/full150.opus-strict.json
npx tsx eval/financebench/adjudicate.ts --run eval/financebench/runs/full150.json --judges eval/financebench/runs/full150.opus-mafin.json,eval/financebench/runs/full150.opus-strict.json --review eval/financebench/review-full150.json --out eval/financebench/results/full150.json
```

`adjudicate.ts` stops with the list of flagged questions to review (with their answer hashes) until the review file
covers them. `run.ts --sample 10` runs every 15th question, which is enough to check a setup before a full run.

The controlled baselines (the dense index needs a GPU or patience; each answer run spends $7-21 of Claude usage):

```bash
cd eval/financebench
uv pip install -p .venv/bin/python numpy sentence-transformers
.venv/bin/python -I baseline_retrieve.py chunk                      # runs/baseline/chunks.db
.venv/bin/python -I baseline_retrieve.py embed                      # resumable; about 5 h on an Apple M4 GPU
.venv/bin/python -I baseline_retrieve.py search --method dense      # also bm25, hybrid; prints recall
cd ../..
npx tsx eval/financebench/baseline.ts --retrieval eval/financebench/runs/baseline/retrieval-dense.json --top-k 20 --all --out eval/financebench/runs/single-dense-top20.json
npx tsx eval/financebench/run.ts --root eval/financebench/md --flat-chunks eval/financebench/runs/baseline/chunks.db --all --out eval/financebench/runs/agent-flat.json
npx tsx eval/financebench/run.ts --root eval/financebench/md --db eval/financebench/runs/lib.db --only-tools search_documents,get_node_content --all --out eval/financebench/runs/agent-search-read.json
python3 eval/financebench/compare.py eval/financebench/runs/full150.json eval/financebench/runs/single-dense-top20.json eval/financebench/runs/agent-flat.json
python3 eval/financebench/publish.py eval/financebench/runs/agent-flat.json eval/financebench/results/agent-flat-sonnet.json   # shareable copy
```

`baseline.ts --dry-run` builds every prompt and prints their sizes without calling a model. Add `--model haiku` to
`run.ts` for the Haiku rows.
