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
  The model matters at least as much as the retrieval layer, and no same-model vector-RAG baseline has been run yet.
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
