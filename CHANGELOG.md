# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-10-26

First release.

### Added

- Markdown section parser built on mdast: setext and ATX headings, preface before the first heading, documents
  without headings, front matter, `#` inside code blocks, skipped heading levels, BOM and CR / CRLF / LF line
  endings; every source line belongs to exactly one node. Heading titles are capped at 300 code points and text is
  NFKC-normalized before segmentation.
- Section tree with a deterministic optimization pass (a port of PageIndex's merge / expand cost model, with pages
  replaced by tokens) and stable node ids; oversized sections are split at block boundaries into `chunk` nodes.
- SQLite store (one file per library, WAL) holding the trees, the original lines and a mixed Chinese / English
  BM25 index (`Intl.Segmenter` words plus a trigram substring fallback). Incremental indexing by content hash, one
  transaction per document, a single-writer lock, and an index format fingerprint that triggers a full rebuild
  (reusing cached summaries) when the format or tree parameters change.
- Five read-only agent tools (`browse_documents`, `get_document`, `get_document_structure`, `get_node_content`,
  `search_documents`) with JSON envelopes, `next_steps` guidance, a 95 000-character response budget and a
  1 024-character cap on string arguments; adapters for the Vercel AI SDK and for MCP (stdio server).
- Optional LLM node summaries and document descriptions through any AI SDK provider (`--summary-model
  <provider>:<model>`), cached by node content hash, with a cost estimate (`--estimate`) that makes no LLM calls.
- Built-in `retrieve()` evidence loop: returns original text re-read from the index by line range, usage and a stop
  reason (`done`, `budget`, `max_steps`), never a model-written answer.
- Client-side LLM rate limiting: a dependency-free sliding 60 s window for requests and estimated input tokens
  (FIFO, no deadlock for oversized requests). `rateLimit` option for summaries and `retrieve()`; CLI flags
  `index --summary-rpm / --summary-tpm` and `eval --rpm / --tpm`.
- Setext heading switch: `--setext` / `--no-setext` (library: `setext`) for converter output that uses `---` as a
  page break, with warnings when suspect setext headings are found; the setting is stored in the index.
- Ignore support: `.gitignore` files at any level, an optional root `.markindexignore`, and repeatable
  `--ignore <pattern>` options (library: `ignore`).
- CLI: `index`, `tree`, `search`, `mcp` (with `--reindex-on-start`) and `eval`.
- Evaluation harness: a 151-question zh / en / mixed question set over a public 329-document corpus, a BM25 baseline,
  agent mode through `retrieve()`, evidence size and precision metrics (`--max-evidence-lines`), scale benchmarks,
  and a Claude Code agent-mode runner restricted to the MarkIndex tools (30/30 on the n = 30 run).
- English and Chinese READMEs, third-party notices, and GitHub Actions CI on Ubuntu and macOS with Node 22 and 24.

### Notes

- Requires Node.js >= 22.12. LLM features need an [AI SDK provider](https://ai-sdk.dev/providers) package such as
  `@ai-sdk/anthropic` installed alongside.
- MarkIndex is an independent, unofficial implementation inspired by
  [VectifyAI/PageIndex](https://github.com/VectifyAI/PageIndex); see `THIRD_PARTY_NOTICES.md`.

[Unreleased]: https://github.com/jackjin1997/markindex/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/jackjin1997/markindex/releases/tag/v0.1.0
