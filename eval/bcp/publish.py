"""Shareable copy of a run.ts run directory: per-question outcomes, with nothing that could reveal the benchmark.

    python3 eval/bcp/publish.py eval/bcp/runs/pilot50-haiku-jev eval/bcp/results/agent-haiku-jev-rerank.json

BrowseComp-Plus distributes its questions and answers encrypted and asks that they never appear online as plain
text. A run file holds the agent's final answer and the judge's output, which repeats the correct answer, so both
are dropped here, and so are the retrieved document ids. What is kept per question: its id, the status, the tool
call counts, turns, cost, evidence recall and the reference judge's verdict. The run's own report (settings and
means) is copied when it sits next to the directory as `<run-dir>.report.json`.
"""
import json
import sys
from pathlib import Path

KEEP = ("model", "turns", "cost_usd", "agent_cost_usd", "recall", "reference_judge", "reference_correct", "intent_calls", "reranked_searches")


def main() -> None:
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    src, dst = Path(sys.argv[1]), Path(sys.argv[2])
    rows = []
    for f in sorted(src.glob("*.json"), key=lambda p: int(p.stem)):
        r = json.loads(f.read_text())
        m = r.get("markindex", {})
        rows.append({"query_id": r["query_id"], "status": r["status"], "tool_call_counts": r["tool_call_counts"], **{k: m.get(k) for k in KEEP if k in m or k not in KEEP[-2:]}})
    report_file = src.with_name(src.name + ".report.json")
    report = json.loads(report_file.read_text()) if report_file.exists() else {}
    dst.parent.mkdir(parents=True, exist_ok=True)
    dst.write_text(json.dumps({**report, "results": rows}, indent=1, ensure_ascii=False) + "\n")
    print(f"{len(rows)} questions -> {dst}")


if __name__ == "__main__":
    main()
