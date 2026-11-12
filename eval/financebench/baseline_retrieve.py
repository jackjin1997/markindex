"""Single-shot retrieval baselines for FinanceBench: dense (local embeddings), sparse (BM25) and hybrid (RRF).

The MarkIndex run lets an agent walk the library. These baselines answer the question "what does the same library
give a retrieve-then-read pipeline?": every filing page is cut into chunks, the chunks are ranked once per question,
and the top pages go to the model in one prompt (baseline.ts). No model is called here.

    .venv/bin/python -I baseline_retrieve.py chunk                      # md/ + md-pages/ -> runs/baseline/chunks.db
    .venv/bin/python -I baseline_retrieve.py embed [--model-dir ...]    # -> runs/baseline/emb-<model>.npy (resumable)
    .venv/bin/python -I baseline_retrieve.py search --method dense|bm25|hybrid [--subset 84]
                                                                        # -> runs/baseline/retrieval-<method>[-84].json

Chunks never cross a page, carry their 1-based line range in the converted file, and are embedded / indexed with a
one-line header (company, document type, period) so that a shared store can tell the filings of different companies
apart. `--subset 84` restricts the candidates to the filings the questions use (the "lib84" setting of run.ts).
"""
import argparse
import json
import re
import sqlite3
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
OUT = HERE / "runs" / "baseline"
DEFAULT_MODEL = "BAAI/bge-base-en-v1.5"
# BGE v1.5 retrieval instruction for queries (passages get none), from the model card.
QUERY_PROMPT = "Represent this sentence for searching relevant passages: "
SLICE = 4096  # chunks embedded between two checkpoints
MAX_CHARS = 1200  # per chunk, before the header; filings are digit-heavy, so this stays under 512 tokens
TOP_K = 20  # ranked pages kept per question
CANDIDATES = 200  # chunks taken from each ranker before pages are merged / fused
RRF_K = 60


def log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


def front_matter(lines: list[str]) -> dict[str, str]:
    meta: dict[str, str] = {}
    if not lines or lines[0].strip() != "---":
        return meta
    for line in lines[1:]:
        if line.strip() == "---":
            break
        key, _, value = line.partition(":")
        meta[key.strip()] = value.strip().strip('"')
    return meta


def split_page(lines: list[str], start: int, end: int) -> list[tuple[int, int, str]]:
    """Cut the 1-based inclusive line range into pieces of at most MAX_CHARS, at line boundaries."""
    pieces: list[tuple[int, int, str]] = []
    buf: list[str] = []
    buf_start = start
    size = 0
    for no in range(start, end + 1):
        line = lines[no - 1]
        if buf and size + len(line) + 1 > MAX_CHARS:
            pieces.append((buf_start, no - 1, "\n".join(buf)))
            buf, buf_start, size = [], no, 0
        buf.append(line)
        size += len(line) + 1
    if buf:
        pieces.append((buf_start, end, "\n".join(buf)))
    return [p for p in pieces if p[2].strip()]


def cmd_chunk(_: argparse.Namespace) -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    db_path = OUT / "chunks.db"
    db_path.unlink(missing_ok=True)
    db = sqlite3.connect(db_path)
    db.execute("create table chunks (id integer primary key, doc_path text, doc_name text, page integer, start_line integer, end_line integer, header text, body text)")
    db.execute("create virtual table fts using fts5(text, tokenize='unicode61')")
    n_docs = n_chunks = 0
    for md in sorted((HERE / "md").glob("*/*.md")):
        doc_name = md.stem
        lines = md.read_text(encoding="utf-8").split("\n")
        meta = front_matter(lines)
        # filings: "company | DOC_TYPE | period N"; other libraries (eval/qasper): the document title
        header = meta["title"] if "title" in meta else f"{meta.get('company', md.parent.name)} | {meta.get('doc_type', '').upper()} | period {meta.get('period', '')}"
        pages = json.loads((HERE / "md-pages" / f"{doc_name}.json").read_text())
        for page, (start, end) in sorted(pages.items(), key=lambda kv: int(kv[0])):
            for s, e, body in split_page(lines, start, min(end, len(lines))):
                cur = db.execute(
                    "insert into chunks (doc_path, doc_name, page, start_line, end_line, header, body) values (?,?,?,?,?,?,?)",
                    (f"{md.parent.name}/{md.name}", doc_name, int(page), s, e, header, body),
                )
                db.execute("insert into fts (rowid, text) values (?, ?)", (cur.lastrowid, f"{header}\n{body}"))
                n_chunks += 1
        n_docs += 1
    db.commit()
    db.close()
    log(f"{n_docs} documents, {n_chunks} chunks -> {db_path}")


def emb_path(model: str) -> Path:
    return OUT / f"emb-{model.split('/')[-1]}.npy"


def load_encoder(a: argparse.Namespace):
    """sentence-transformers on the GPU when there is one (Apple MPS / CUDA), else the CPU."""
    import torch
    from sentence_transformers import SentenceTransformer

    device = "mps" if torch.backends.mps.is_available() else "cuda" if torch.cuda.is_available() else "cpu"
    model = SentenceTransformer(a.model_dir or a.model, device=device)
    model.max_seq_length = 512
    log(f"{a.model} on {device}")
    return model


def cmd_embed(a: argparse.Namespace) -> None:
    import numpy as np

    db = sqlite3.connect(OUT / "chunks.db")
    rows = db.execute("select header, body from chunks order by id").fetchall()
    if a.limit:
        rows = rows[: a.limit]
    texts = [f"{h}\n{b}" for h, b in rows]
    model = load_encoder(a)
    dim = model.get_sentence_embedding_dimension()
    final = emb_path(a.model)
    part = final.with_suffix(".part.npy")
    state = final.with_suffix(".part.json")
    done = 0
    if not a.limit and part.exists() and state.exists():
        st = json.loads(state.read_text())
        if st["total"] == len(texts) and st["dim"] == dim:
            done = st["done"]
    if a.limit:
        out = np.zeros((len(texts), dim), dtype=np.float16)
    else:
        out = np.lib.format.open_memmap(part, mode="r+" if done else "w+", dtype=np.float16, shape=(len(texts), dim))
    log(f"{len(texts)} chunks, {done} already embedded")
    t0 = time.time()
    for start in range(done, len(texts), SLICE):
        end = min(start + SLICE, len(texts))
        out[start:end] = model.encode(texts[start:end], batch_size=a.batch_size, normalize_embeddings=True, show_progress_bar=False)
        rate = (end - done) / (time.time() - t0)
        log(f"{end}/{len(texts)}  {rate:.0f} chunks/s  eta {(len(texts) - end) / rate / 60:.0f} min")
        if not a.limit:
            out.flush()
            state.write_text(json.dumps({"total": len(texts), "dim": dim, "done": end}))
    if a.limit:
        return  # speed test only
    del out
    part.rename(final)
    state.unlink()
    log(f"-> {final}")


WORD = re.compile(r"[A-Za-z0-9]+")


def fts_query(question: str) -> str:
    seen: list[str] = []
    for tok in WORD.findall(question.lower()):
        if tok not in seen:
            seen.append(tok)
    return " OR ".join(f'"{t}"' for t in seen)


def load_questions() -> list[dict]:
    return [json.loads(line) for line in (HERE / "data" / "open.jsonl").read_text().strip().split("\n")]


def cmd_search(a: argparse.Namespace) -> None:
    import numpy as np

    db = sqlite3.connect(OUT / "chunks.db")
    meta = db.execute("select id, doc_path, doc_name, page, start_line, end_line from chunks order by id").fetchall()
    row_of = {m[0]: i for i, m in enumerate(meta)}
    questions = load_questions()
    allowed = None
    if a.subset == "84":
        used = {e["doc_name"] for q in questions for e in q["evidence"]} | {q["doc_name"] for q in questions}
        allowed = np.array([m[2] in used for m in meta])
        log(f"subset: {len(used)} filings, {int(allowed.sum())} of {len(meta)} chunks")

    def dense_ranks() -> list[list[int]]:
        emb = np.load(emb_path(a.model)).astype(np.float32)
        model = load_encoder(a)
        qv = model.encode([QUERY_PROMPT + q["question"] for q in questions], batch_size=32, normalize_embeddings=True, show_progress_bar=False)
        scores = np.asarray(qv, dtype=np.float32) @ emb.T
        if allowed is not None:
            scores[:, ~allowed] = -1e9
        top = np.argsort(-scores, axis=1)[:, :CANDIDATES]
        return [[int(i) for i in row] for row in top]

    def bm25_ranks() -> list[list[int]]:
        out = []
        for q in questions:
            hits = db.execute("select rowid from fts where fts match ? order by bm25(fts) limit ?", (fts_query(q["question"]), CANDIDATES * 20)).fetchall()
            rows = [row_of[h[0]] for h in hits]
            if allowed is not None:
                rows = [r for r in rows if allowed[r]]
            out.append(rows[:CANDIDATES])
        return out

    if a.method == "dense":
        ranked = dense_ranks()
    elif a.method == "bm25":
        ranked = bm25_ranks()
    else:
        d, s = dense_ranks(), bm25_ranks()
        ranked = []
        for dr, sr in zip(d, s):
            score: dict[int, float] = {}
            for lst in (dr, sr):
                for rank, row in enumerate(lst):
                    score[row] = score.get(row, 0.0) + 1.0 / (RRF_K + rank + 1)
            ranked.append(sorted(score, key=lambda r: -score[r])[:CANDIDATES])

    # chunks -> pages: a page ranks where its best chunk ranks
    page_range: dict[tuple[str, int], list[int]] = {}
    for _, doc_path, _, page, s, e in meta:
        r = page_range.setdefault((doc_path, page), [s, e])
        r[0], r[1] = min(r[0], s), max(r[1], e)
    path_of = {m[2]: m[1] for m in meta}
    results = {}
    ks = (1, 3, 5, 10, 20)
    page_hits = {k: 0 for k in ks}
    doc_hits = {k: 0 for k in ks}
    for q, rows in zip(questions, ranked):
        pages: list[tuple[str, int]] = []
        for row in rows:
            key = (meta[row][1], meta[row][3])
            if key not in pages:
                pages.append(key)
            if len(pages) == TOP_K:
                break
        gold_pages = {(path_of[e["doc_name"]], int(e["evidence_page_num"])) for e in q["evidence"]}
        gold_docs = {p for p, _ in gold_pages}
        for k in ks:
            page_hits[k] += any(p in gold_pages for p in pages[:k])
            doc_hits[k] += any(p[0] in gold_docs for p in pages[:k])
        results[q["financebench_id"]] = [
            {"doc_path": p, "page": n, "start_line": page_range[(p, n)][0], "end_line": page_range[(p, n)][1]} for p, n in pages
        ]
    n = len(questions)
    summary = {
        "method": a.method,
        "model": a.model if a.method != "bm25" else None,
        "subset": a.subset or "all",
        "questions": n,
        "chunks": int(allowed.sum()) if allowed is not None else len(meta),
        "evidence_page_recall": {f"@{k}": round(page_hits[k] / n, 4) for k in ks},
        "right_filing_recall": {f"@{k}": round(doc_hits[k] / n, 4) for k in ks},
    }
    name = f"retrieval-{a.method}{'-84' if a.subset == '84' else ''}.json"
    (OUT / name).write_text(json.dumps({"summary": summary, "results": results}, indent=1) + "\n")
    print(json.dumps(summary, indent=2))
    log(f"-> {OUT / name}")


def main() -> None:
    global HERE, OUT
    p = argparse.ArgumentParser()
    p.add_argument("--base", default=None, help="benchmark folder with md/, md-pages/ and data/open.jsonl (default: this folder)")
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("chunk").set_defaults(fn=cmd_chunk)
    e = sub.add_parser("embed")
    e.add_argument("--model", default=DEFAULT_MODEL)
    e.add_argument("--model-dir", default=None, help="local copy of the model (default: download by name)")
    e.add_argument("--batch-size", type=int, default=64)
    e.add_argument("--limit", type=int, default=0, help="embed only the first N chunks and do not save (speed test)")
    e.set_defaults(fn=cmd_embed)
    s = sub.add_parser("search")
    s.add_argument("--method", choices=["dense", "bm25", "hybrid"], required=True)
    s.add_argument("--model", default=DEFAULT_MODEL)
    s.add_argument("--model-dir", default=None)
    s.add_argument("--subset", choices=["84"], default=None)
    s.set_defaults(fn=cmd_search)
    a = p.parse_args()
    if a.base:
        HERE = Path(a.base).resolve()
        OUT = HERE / "runs" / "baseline"
    a.fn(a)


if __name__ == "__main__":
    main()
