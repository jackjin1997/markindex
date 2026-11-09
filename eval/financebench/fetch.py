"""Download what the FinanceBench evaluation needs (nothing of it is committed).

Usage: python3 -I fetch.py   (stdlib only; idempotent)

- data/open.jsonl, data/docs.jsonl: the 150 open-source questions and the document list, from
  github.com/patronus-ai/financebench (CC BY-NC 4.0).
- pdfs/*.pdf: all 368 filings of that repository (~680 MB). The 150 questions use 84 of them; the others are
  distractors in the full library.
- data/mafin-result-gpt4o.json: VectifyAI's published Mafin2.5 results with their human-review labels
  (github.com/VectifyAI/Mafin2.5-FinanceBench), used by adjudicate.ts to find the questions their reviewers flagged
  as benchmark errors.
"""

from __future__ import annotations

import json
import os
import time
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor

HERE = os.path.dirname(os.path.abspath(__file__))
FB_COMMIT = "cc39aeb4afdf33909ee1412188bf89035950c2eb"  # pinned so results stay comparable
FB = f"https://raw.githubusercontent.com/patronus-ai/financebench/{FB_COMMIT}/"
MAFIN_COMMIT = "1c890d5e0fd9929953d38282614555847727011d"
MAFIN = f"https://raw.githubusercontent.com/VectifyAI/Mafin2.5-FinanceBench/{MAFIN_COMMIT}/result_gpt4o.json"
API = f"https://api.github.com/repos/patronus-ai/financebench/contents/pdfs?ref={FB_COMMIT}"


def get(url: str, path: str, check=None) -> str | None:
    if os.path.exists(path) and os.path.getsize(path) > 0:
        return None
    err = None
    for attempt in range(5):
        try:
            with urllib.request.urlopen(url, timeout=120) as r:
                data = r.read()
            if check and not check(data):
                raise ValueError("unexpected content")
            with open(path + ".tmp", "wb") as f:
                f.write(data)
            os.replace(path + ".tmp", path)
            return None
        except Exception as e:  # retry transient network errors
            err = e
            time.sleep(2 * (attempt + 1))
    return f"{url}: {err}"


def main() -> None:
    os.makedirs(os.path.join(HERE, "data"), exist_ok=True)
    os.makedirs(os.path.join(HERE, "pdfs"), exist_ok=True)
    fails = [
        f
        for f in [
            get(FB + "data/financebench_open_source.jsonl", os.path.join(HERE, "data/open.jsonl")),
            get(FB + "data/financebench_document_information.jsonl", os.path.join(HERE, "data/docs.jsonl")),
            get(MAFIN, os.path.join(HERE, "data/mafin-result-gpt4o.json")),
        ]
        if f
    ]
    with urllib.request.urlopen(API, timeout=60) as r:
        names = [x["name"] for x in json.load(r) if x["name"].endswith(".pdf")]
    with ThreadPoolExecutor(10) as ex:
        fails += [
            f
            for f in ex.map(
                lambda n: get(FB + "pdfs/" + urllib.parse.quote(n), os.path.join(HERE, "pdfs", n), lambda d: d[:4] == b"%PDF"),
                names,
            )
            if f
        ]
    print(f"{len(names)} PDFs listed, {len(fails)} failures")
    for f in fails:
        print("FAIL", f)


if __name__ == "__main__":
    main()
