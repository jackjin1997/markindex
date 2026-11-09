"""Convert the FinanceBench PDFs to Markdown for MarkIndex.

Usage: .venv/bin/python -I convert.py [--only-questions] [--workers N]

Writes md/<company>/<doc_name>.md and md-pages/<doc_name>.json ({"<pdf page, 0-based>": [start, end]} with
1-based inclusive line ranges in the .md file). Each page starts with an `<!-- page N -->` comment line (N is
1-based). Conversion is pymupdf4llm (layout mode); the only post-processing is heading cleanup, which never adds or
removes lines:

- heading text: `**`, `<u>`/`</u>` and repeated spaces are removed;
- "PART I/II/III/IV" headings become h1 and "Item 7." / "Item 1A." headings become h2 (also when the converter left
  them as a short plain or bold-only line); every other converter heading becomes h3, so the 10-K outline is
  PART > Item > sub-section instead of flat;
- running page headers that repeat the current PART / Item are not promoted again.

When layout mode fails on a PDF, the filing is converted again in pymupdf4llm's classic mode (font-size headings).
PDFs that are not in data/docs.jsonl get metadata inferred from their file name (company taken from listed filings
with the same name prefix).
"""

from __future__ import annotations

import json
import os
import re
import sys
import time
from concurrent.futures import ProcessPoolExecutor, as_completed

HERE = os.path.dirname(os.path.abspath(__file__))
PDFS = os.path.join(HERE, "pdfs")
MD = os.path.join(HERE, "md")
PAGES = os.path.join(HERE, "md-pages")

HEADING = re.compile(r"^(#{1,6})\s+(.*)$")
PART = re.compile(r"^PART\s+(I{1,3}|IV)\b", re.I)
# converter headings often merge the running page header with the part ("3M COMPANY FORM 10-Q ... PART I. Financial ...")
PART_IN_HEADING = re.compile(r"\bPART\s+(I{1,3}|IV)\b", re.I)
ITEM = re.compile(r"^ITEM\s+(\d{1,2}[A-C]?)\s*[.:\-–—]?(?:\s|$)", re.I)


def clean(text: str) -> str:
    text = re.sub(r"</?u>", "", text).replace("**", "").replace("_", " ")
    return re.sub(r"\s+", " ", text).strip()


def bold_only(line: str) -> str | None:
    s = line.strip()
    if s.startswith("**") and s.endswith("**") and len(s) > 4:
        return clean(s)
    return None


def fix_headings(lines: list[str]) -> list[str]:
    part = item = ""
    out = []
    for line in lines:
        m = HEADING.match(line)
        if m:
            text = clean(m.group(2))
        else:
            text = bold_only(line) or (clean(line) if 0 < len(line.strip()) <= 100 and not line.lstrip().startswith("|") else "")
        level = None
        pm, im = PART.match(text), ITEM.match(text)
        if not pm and m and len(text) <= 160:
            pm = PART_IN_HEADING.search(text)
        if pm and len(text) <= 160:
            key = pm.group(1).upper()
            if key != part:
                part, item, level = key, "", 1
        elif im and len(text) <= 120:
            key = im.group(1).upper()
            if key != item:
                item, level = key, 2
        if level is not None:
            out.append("#" * level + " " + text)
        elif m:
            out.append("### " + text if text else "")
        else:
            out.append(line)
    return out


def front_matter(meta: dict) -> list[str]:
    title = f"{meta['company']} {meta['doc_period']} {meta['doc_type'].upper()}"
    return [
        "---",
        f"title: {json.dumps(title)}",
        f"company: {json.dumps(meta['company'])}",
        f"doc_type: {json.dumps(meta['doc_type'])}",
        f"period: {meta['doc_period']}",
        f"sector: {json.dumps(meta.get('gics_sector') or '')}",
        "---",
        "",
    ]


def folder(company: str) -> str:
    return re.sub(r"[^A-Za-z0-9]+", "_", company).strip("_")


def convert(meta: dict) -> tuple[str, int, float]:
    import pymupdf4llm  # imported per worker

    name = meta["doc_name"]
    out_md = os.path.join(MD, folder(meta["company"]), name + ".md")
    out_pages = os.path.join(PAGES, name + ".json")
    if os.path.exists(out_md) and os.path.exists(out_pages):
        return name, -1, 0.0
    t = time.time()
    pdf = os.path.join(PDFS, name + ".pdf")
    try:
        chunks = pymupdf4llm.to_markdown(pdf, page_chunks=True, show_progress=False)
    except Exception as e:  # pymupdf errors can carry SWIG objects that cannot be pickled back to the parent
        first = f"{type(e).__name__}: {e}"
        pymupdf4llm.use_layout(False)
        try:
            chunks = pymupdf4llm.to_markdown(pdf, page_chunks=True, show_progress=False)
        except Exception as e2:
            raise RuntimeError(f"layout: {first}; classic: {type(e2).__name__}: {e2}") from None
        finally:
            pymupdf4llm.use_layout(True)
        print(f"{name}: layout mode failed ({first}); converted in classic mode", file=sys.stderr, flush=True)
    lines = front_matter(meta)
    ranges = {}
    for c in chunks:
        md = c["metadata"]
        page = md.get("page_number") or md["page"]  # 1-based in both modes
        body = c["text"].replace("\r", "").split("\n")
        start = len(lines) + 1
        lines.append(f"<!-- page {page} -->")
        lines.extend(body)
        lines.append("")
        ranges[str(page - 1)] = [start, len(lines)]
    head = len(front_matter(meta))
    lines = lines[:head] + fix_headings(lines[head:])  # whole document, so running headers are recognized
    os.makedirs(os.path.dirname(out_md), exist_ok=True)
    with open(out_md + ".tmp", "w") as f:
        f.write("\n".join(lines) + "\n")
    with open(out_pages, "w") as f:
        json.dump(ranges, f)
    os.replace(out_md + ".tmp", out_md)
    return name, len(chunks), time.time() - t


def infer_meta(name: str, listed: list[dict]) -> dict:
    """Metadata for a PDF missing from docs.jsonl, e.g. ADOBE_2022Q2_10Q or AMCOR_2022_8K_2022-04-26."""
    parts = name.split("_")
    if parts[0] == "BOSTONPROPERTIES":  # the only unlisted company without a listed filing
        listed = [{"doc_name": "BOSTONPROPERTIES_", "company": "Boston Properties", "gics_sector": "Real Estate"}]
    same = [d for d in listed if d["doc_name"].split("_")[0] == parts[0]]
    kind = parts[2].lower() if len(parts) > 2 else ""
    return {
        "doc_name": name,
        "company": same[0]["company"] if same else parts[0].title(),
        "gics_sector": same[0].get("gics_sector", "") if same else "",
        "doc_type": "Earnings" if kind == "earnings" else kind,
        "doc_period": int(parts[1][:4]),
    }


def refix(path: str) -> None:
    """Re-run the (idempotent) heading cleanup on an already converted file, in place; line count is unchanged."""
    lines = open(path).read().split("\n")
    end = lines.index("---", 1) + 1 if lines and lines[0] == "---" else 0
    fixed = lines[:end] + fix_headings(lines[end:])
    assert len(fixed) == len(lines)
    with open(path + ".tmp", "w") as f:
        f.write("\n".join(fixed))
    os.replace(path + ".tmp", path)


def main() -> None:
    if "--refix" in sys.argv:
        for d, _, fs in os.walk(MD):
            for f in fs:
                if f.endswith(".md"):
                    refix(os.path.join(d, f))
        return
    only_q = "--only-questions" in sys.argv
    workers = int(sys.argv[sys.argv.index("--workers") + 1]) if "--workers" in sys.argv else 4
    listed = [json.loads(l) for l in open(os.path.join(HERE, "data/docs.jsonl"))]
    asked = {json.loads(l)["doc_name"] for l in open(os.path.join(HERE, "data/open.jsonl"))}
    by_name = {d["doc_name"]: d for d in listed}  # docs.jsonl lists one filing twice
    for f in sorted(os.listdir(PDFS)):
        if f.endswith(".pdf") and f[:-4] not in by_name:
            by_name[f[:-4]] = infer_meta(f[:-4], listed)
    docs = [d for d in by_name.values() if os.path.exists(os.path.join(PDFS, d["doc_name"] + ".pdf"))]
    docs.sort(key=lambda d: (d["doc_name"] not in asked, d["doc_name"]))
    if only_q:
        docs = [d for d in docs if d["doc_name"] in asked]
    os.makedirs(PAGES, exist_ok=True)
    done = 0
    with ProcessPoolExecutor(workers) as ex:
        futs = {ex.submit(convert, d): d["doc_name"] for d in docs}
        for f in as_completed(futs):
            done += 1
            try:
                name, pages, secs = f.result()
                print(f"[{done}/{len(docs)}] {name} pages={pages} {secs:.0f}s", flush=True)
            except Exception as e:  # keep going; report at the end
                print(f"[{done}/{len(docs)}] FAIL {futs[f]}: {e!r}", flush=True)


if __name__ == "__main__":
    main()
