# QASPER

A second benchmark for the comparison in [`../financebench`](../financebench/README.md): the same agent loop, prompt
structure and judge, on research papers instead of filings.

[QASPER](https://allenai.org/data/qasper) ([paper](https://arxiv.org/abs/2105.03011), NAACL 2021, CC BY 4.0) has
information-seeking questions about NLP papers with annotated answers and evidence paragraphs. We use the 416 papers
of its test split (v0.3) as one library and 150 questions, one per paper.

## Results

`claude-sonnet-5-5` for answers and for the judge (Mafin2.5's answer-equivalence prompt, as in FinanceBench).
Runs of 2026-11-12.

| Setup | Accuracy | Evidence page cited | Mean turns | Cost |
|---|---:|---:|---:|---:|
| Single shot, dense (bge-base-en-v1.5), top-10 pages in one prompt | 93.3% | 93.3% | 1 | $7.97 |
| Agent over flat page chunks (BM25 search + read page) | 89.3% | 91.3% | 3.6 | $5.44 |
| Agent, MarkIndex, five tools | 91.3% | 90.0% | 4.2 | $6.70 |

No pair differs significantly (exact McNemar on paired outcomes: MarkIndex against flat chunks 5 to 2, p = 0.45;
MarkIndex against single shot 2 to 5, p = 0.45; flat chunks against single shot 2 to 8, p = 0.11). Every answer of
the two agents cites the right paper.

Why this differs from FinanceBench: retrieval is easy here. The papers are short (about 21,000 characters at the
median) and the question names the paper, so with the question as the query both BM25 and the dense retriever have
an evidence page in their top 10 for 97.3% of the questions, against 14% and 34% on FinanceBench
([`results/retrieval-recall.json`](results/retrieval-recall.json)). The agent loop pays off where single-shot
retrieval misses the evidence and adds nothing where it already finds it. MarkIndex and the flat baseline again do
not differ. MarkIndex indexes the 416 papers in 12 s.

Per-question files: [`results/`](results) (verdict, citations, turns, cost and the system's answer; join on the
QASPER question id, whose first 12 characters follow `qasper_` in `id`).

## Method

[`prepare.py`](prepare.py) lays the data out like `../financebench`, so the same scripts run on it with `--base`:

- **Documents.** One Markdown file per paper: front matter (title, arXiv id), the title as h1, the abstract, the
  sections with QASPER's nested section names as headings, and the figure and table captions. Figures and tables
  themselves are not in the text.
- **Pages.** Papers have no pages. To give page-based baselines a reading unit, each file is cut into pages of at
  most 3,000 characters at paragraph boundaries, each starting with an `<!-- page N -->` line as in the converted
  filings. A heading is never the last line of a page.
- **Questions.** One per paper, sampled with a fixed seed among the questions that no annotator marked
  unanswerable, on which annotators do not give opposite yes / no answers, and for which at least one annotator
  gave evidence in the text. 1,123 questions qualify; the sample has 91 extractive, 37 free-form and 22 yes / no
  questions. Each question is prefixed with the title of its paper, because QASPER questions do not name it.
- **Reference answers and gold locations.** The judge sees every annotator's answer and accepts agreement with any
  of them. The gold location is every page that holds an evidence paragraph of any annotator.
- **Judging.** An LLM judge instead of QASPER's token-level F1, to keep one protocol across both benchmarks. The
  numbers are therefore not comparable with the QASPER leaderboard.

The test split is used for evaluation only; nothing was tuned on it. The baseline settings (chunk size, top-k) were
fixed on FinanceBench beforehand.

## Reproduce

```bash
mkdir -p eval/qasper/data/raw && cd eval/qasper/data/raw
curl -O https://qasper-dataset.s3.us-west-2.amazonaws.com/qasper-test-and-evaluator-v0.3.tgz
tar -xzf qasper-test-and-evaluator-v0.3.tgz qasper-test-v0.3.json
cd ../../../..
PY=eval/financebench/.venv/bin/python; B=eval/qasper     # the venv of ../financebench with numpy + sentence-transformers
$PY -I eval/qasper/prepare.py
$PY -I eval/financebench/baseline_retrieve.py --base $B chunk
$PY -I eval/financebench/baseline_retrieve.py --base $B embed
$PY -I eval/financebench/baseline_retrieve.py --base $B search --method dense
npm run build && node dist/cli.js index $B/md --db $B/runs/lib.db
npx tsx eval/financebench/baseline.ts --base $B --retrieval $B/runs/baseline/retrieval-dense.json --top-k 10 --all --out $B/runs/single-dense-top10.json
npx tsx eval/financebench/run.ts --base $B --root $B/md --db $B/runs/lib.db --all --out $B/runs/agent-markindex.json
npx tsx eval/financebench/run.ts --base $B --root $B/md --flat-chunks $B/runs/baseline/chunks.db --all --out $B/runs/agent-flat.json
python3 eval/financebench/compare.py $B/runs/agent-markindex.json $B/runs/agent-flat.json $B/runs/single-dense-top10.json
```

The three answer runs spend about $20 of Claude usage in total.
