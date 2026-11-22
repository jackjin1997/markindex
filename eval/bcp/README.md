# BrowseComp-Plus (pilot)

[BrowseComp-Plus](https://github.com/texttron/BrowseComp-Plus) ([paper](https://arxiv.org/abs/2508.06600),
[leaderboard](https://tevatron-browsecomp-plus.hf.space)) has 830 multi-constraint questions over a fixed corpus of
100,195 web documents. This folder runs it through Claude Code and the MarkIndex MCP server.

**Status: a 50-question pilot, not a leaderboard result.** Nothing has been submitted. Answers were judged by
`claude-sonnet-5-5` with the benchmark's grader prompt; the leaderboard only accepts its own Qwen3-32B judge.

## Results

Haiku 5.5 agent with `search_documents`, `get_document_structure` and `get_node_content`, the same 50 questions
in every row, runs of 2026-11-16 and 2026-11-22:

| Setup | Correct | Evidence recall | Searches per question | Cost |
|---|---:|---:|---:|---:|
| MarkIndex search | 41 / 50 (82%) | 73.7% | 16.0 | $3.86 |
| MarkIndex search, results reranked by a decision model | 45 / 50 (90%) | 79.0% | 15.4 | $4.84 + $2.00 |

Four questions are right only with reranking and none only without it (exact McNemar p = 0.125), so at this size
the difference is not significant. Two identical runs of the first row earlier differed on five questions. The
reranked run is no faster: every search takes about 1.5 s instead of 0.3 s and the agent searches as often.

Reranking ([`rerank_server.ts`](rerank_server.ts)): each search fetches 50 section nodes, [Jev](https://docs.typesafe.ai/api)
(TypeSafe's decision model, `jev-1.14.0`) answers one yes/no question per node about a passage of at most 8,000
characters, and the ten most likely nodes are returned. The passage is judged against the question, which the
runner passes to the server; a product version would take it as a tool argument.

Without an agent ([`rerank_eval.ts`](rerank_eval.ts)): one BM25 search with the question as the query, 200 nodes,
reranked the same way, measured against the benchmark's evidence documents.

| | Recall@5 | Recall@10 | nDCG@10 |
|---|---:|---:|---:|
| BM25 | 7.0% | 10.1% | 10.5 |
| BM25, reranked | 21.7% | 23.1% | 29.6 |

The 200 nodes contain 24.6% of the evidence documents, so the reranker brings nearly everything the pool holds
into the top ten, and what limits a single search is the pool.

Per-question outcomes are in [`results/`](results) (ids, verdicts, counts and costs; see below for what is left
out).

## Data handling

The benchmark ships its questions and answers encrypted and asks that they never appear online as plain text.
`data/`, `md/` and `runs/` are git-ignored. A run file contains the agent's answer and the judge's output, which
repeats the correct answer, so run files are not committed either: [`publish.py`](publish.py) writes the copies in
`results/` without them.

## Reproduce

```bash
# corpus (Hugging Face dataset Tevatron/browsecomp-plus-corpus) -> Markdown: 100,195 files, 3.2 GB
eval/financebench/.venv/bin/python -I eval/bcp/prepare.py
# questions: decrypt them with the benchmark's own script into eval/bcp/data/queries.jsonl,
# one JSON object per line with query_id, query, answer and evidence_docids
npm run build
node dist/cli.js index eval/bcp/md --db eval/bcp/runs/lib.db --no-setext     # 19 GB, about 80 minutes

npx tsx eval/bcp/run.ts --root eval/bcp/md --db eval/bcp/runs/lib.db --run-dir eval/bcp/runs/pilot \
  --ids <ids> --model haiku

# with reranking: needs TYPESAFE_API_KEY (or OPENROUTER_API_KEY) in the environment
npx tsx eval/bcp/run.ts --root eval/bcp/md --db eval/bcp/runs/lib.db --run-dir eval/bcp/runs/pilot-jev \
  --ids <ids> --model haiku --rerank jev
npx tsx eval/bcp/rerank_eval.ts --db eval/bcp/runs/lib.db --scorer jev --ids-from eval/bcp/runs/pilot --pool 200 \
  --out eval/bcp/runs/rerank-jev.json
python3 eval/bcp/publish.py eval/bcp/runs/pilot-jev eval/bcp/results/agent-haiku-jev-rerank.json   # shareable copy
```

`--rerank overlap` and `--scorer overlap` use a term-overlap scorer with no network access, for testing the
plumbing. Jev's scores are cached in a JSONL file, so a re-run costs nothing. The ids of the 50 questions are the
ones in `results/`.
