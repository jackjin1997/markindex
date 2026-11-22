"""BrowseComp-Plus corpus as a Markdown library for MarkIndex.

    eval/financebench/.venv/bin/python -I eval/bcp/prepare.py [--limit N]

Reads data/raw/corpus/data/*.parquet (Hugging Face dataset Tevatron/browsecomp-plus-corpus, MIT, about 100K web
documents) and writes one file per document: md/docs/<last two digits of the docid>/<docid>.md. The docid and the
URL are added to the document's front matter (most documents come with one: title, date, ...) and the text is
otherwise unchanged. Index the result with `markindex index --no-setext`: web text has bare `---` lines. The file name is the docid, which is how the
run script maps what the agent retrieved back to the benchmark's document ids.

The questions are not handled here. They are distributed encrypted and must not be published in plain text; the
decrypted copy stays in data/queries.jsonl, which is git-ignored.
"""
import argparse
import glob
import json
from pathlib import Path

import pyarrow.parquet as pq

HERE = Path(__file__).resolve().parent


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=0, help="convert only the first N documents (smoke test)")
    a = ap.parse_args()
    files = sorted(glob.glob(str(HERE / "data" / "raw" / "corpus" / "data" / "*.parquet")))
    if not files:
        raise SystemExit("no parquet files under data/raw/corpus/data")
    out = HERE / "md" / "docs"
    n = chars = 0
    for f in files:
        pf = pq.ParquetFile(f)
        for batch in pf.iter_batches(batch_size=2000):
            for row in batch.to_pylist():
                docid = str(row["docid"])
                bucket = out / docid[-2:].rjust(2, "0")
                bucket.mkdir(parents=True, exist_ok=True)
                text = (row.get("text") or "").replace("\r\n", "\n").replace("\r", "\n")
                meta = [f"docid: {json.dumps(docid)}"]
                if row.get("url"):
                    meta.append(f"url: {json.dumps(row['url'])}")
                if text.startswith("---\n"):  # the document has front matter (title, date, ...): add ours to it
                    body = "---\n" + "\n".join(meta) + "\n" + text[4:]
                else:
                    body = "---\n" + "\n".join(meta) + "\n---\n\n" + text
                (bucket / f"{docid}.md").write_text(body.rstrip("\n") + "\n", encoding="utf-8")
                n += 1
                chars += len(text)
                if a.limit and n >= a.limit:
                    print(f"{n} documents, {chars} characters (limit)")
                    return
        print(f"{Path(f).name}: {n} documents so far", flush=True)
    print(f"{n} documents, {chars} characters -> {out}")


if __name__ == "__main__":
    main()
