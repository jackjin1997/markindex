"""Shareable copy of a run.ts / baseline.ts report: per-question outcomes without the dataset's text.

    python3 eval/financebench/publish.py runs/baseline-dense-top20.json results/single-dense-top20-sonnet.json

Drops `question`, `gold_answer` and the raw judge output (FinanceBench is CC BY-NC 4.0, so its questions and answers
are not redistributed; join on `id` with the dataset). Everything else is kept: run settings, summary, and for each
question the judge's verdict, citations, turns, cost and the system's answer. compare.py reads these files too.
"""
import json
import sys
from pathlib import Path

DROP = {"question", "gold_answer", "judge_raw"}


def main() -> None:
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    src, dst = Path(sys.argv[1]), Path(sys.argv[2])
    report = json.loads(src.read_text())
    report["results"] = [{k: v for k, v in r.items() if k not in DROP} for r in report["results"]]
    dst.parent.mkdir(parents=True, exist_ok=True)
    dst.write_text(json.dumps(report, indent=1, ensure_ascii=False) + "\n")
    print(f"{len(report['results'])} questions -> {dst}")


if __name__ == "__main__":
    main()
