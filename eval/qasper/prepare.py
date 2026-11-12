"""QASPER (test split, v0.3) as a second benchmark, laid out like eval/financebench so the same scripts run on it.

    eval/financebench/.venv/bin/python -I eval/qasper/prepare.py [--questions 150] [--seed 2027]

Reads data/raw/qasper-test-v0.3.json (https://qasper-dataset.s3.us-west-2.amazonaws.com/qasper-test-and-evaluator-v0.3.tgz,
CC BY 4.0) and writes:

    md/papers/<arxiv_id>.md     one Markdown file per paper: front matter, title, abstract, sections, captions
    md-pages/<arxiv_id>.json    line range of every page, {"0": [start, end], ...}
    data/open.jsonl             the sampled questions, in the field layout of FinanceBench's open.jsonl
    data/docs.jsonl             {doc_name, company} per paper ("company" is the folder, always "papers")

Papers have no pages. To give page-based baselines a reading unit, each file is cut into "pages" of at most
PAGE_CHARS characters at paragraph boundaries and each page starts with an "<!-- page N -->" line, as the converted
filings do. A section heading is never the last line of a page.

Questions: one per paper, only questions that no annotator marked unanswerable, on which annotators do not give
opposite yes / no answers, and for which at least one annotator gave evidence in the text (not only in a figure or table, whose content is not in the files). The gold location is
every page that holds an evidence paragraph of any annotator. The question is prefixed with the paper's title,
because QASPER questions are about one paper and do not name it.
"""
import argparse
import json
import random
import re
from pathlib import Path

HERE = Path(__file__).resolve().parent
PAGE_CHARS = 3000
FLOAT = "FLOAT SELECTED: "


def norm(s: str) -> str:
    return re.sub(r"\s+", " ", s).strip()


def blocks_of(paper: dict) -> list[tuple[str, str]]:
    """(kind, text) with kind 'h' (Markdown heading line) or 'p' (one-line paragraph)."""
    out: list[tuple[str, str]] = [("h", f"# {norm(paper['title'])}")]
    if norm(paper.get("abstract") or ""):
        out += [("h", "## Abstract"), ("p", norm(paper["abstract"]))]
    open_path: list[str] = []
    for sec in paper["full_text"]:
        parts = [norm(p) for p in (sec["section_name"] or "").split(" ::: ") if norm(p)]
        for depth, name in enumerate(parts):
            if open_path[: depth + 1] != parts[: depth + 1]:
                out.append(("h", f"{'#' * min(6, depth + 2)} {name}"))
        open_path = parts
        out += [("p", norm(p)) for p in sec["paragraphs"] if norm(p)]
    caps = [norm(f.get("caption") or "") for f in paper.get("figures_and_tables") or []]
    caps = [c for c in caps if c]
    if caps:
        out.append(("h", "## Figures and Tables"))
        out += [("p", c) for c in caps]
    return out


def paginate(blocks: list[tuple[str, str]]) -> list[list[tuple[str, str]]]:
    pages: list[list[tuple[str, str]]] = [[]]
    size = 0
    for kind, text in blocks:
        if pages[-1] and size + len(text) > PAGE_CHARS:
            carry = []
            while pages[-1] and pages[-1][-1][0] == "h":  # a heading goes with the text under it
                carry.insert(0, pages[-1].pop())
            if pages[-1]:
                pages.append(carry)
                size = sum(len(t) for _, t in carry)
            else:
                pages[-1] = carry
        pages[-1].append((kind, text))
        size += len(text)
    return pages


def answer_text(a: dict) -> str:
    if a["extractive_spans"]:
        return "; ".join(norm(s) for s in a["extractive_spans"])
    if a["yes_no"] is not None:
        return "Yes" if a["yes_no"] else "No"
    return norm(a["free_form_answer"])


def answer_type(a: dict) -> str:
    return "extractive" if a["extractive_spans"] else "yes_no" if a["yes_no"] is not None else "free_form"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--questions", type=int, default=150)
    ap.add_argument("--seed", type=int, default=2027)
    a = ap.parse_args()
    data = json.loads((HERE / "data" / "raw" / "qasper-test-v0.3.json").read_text())
    md_dir, pages_dir = HERE / "md" / "papers", HERE / "md-pages"
    md_dir.mkdir(parents=True, exist_ok=True)
    pages_dir.mkdir(parents=True, exist_ok=True)

    page_of_para: dict[str, dict[str, int]] = {}
    n_pages = n_lines = 0
    for pid, paper in sorted(data.items()):
        title = norm(paper["title"]).replace('"', "'")
        lines = ["---", f'title: "{title}"', f'arxiv_id: "{pid}"', "---", ""]
        ranges: dict[str, list[int]] = {}
        where: dict[str, int] = {}
        for no, page in enumerate(paginate(blocks_of(paper))):
            start = len(lines) + 1
            lines += [f"<!-- page {no + 1} -->", ""]
            for kind, text in page:
                lines += [text, ""]
                if kind == "p":
                    where.setdefault(text, no)
            ranges[str(no)] = [start, len(lines)]
        (md_dir / f"{pid}.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
        (pages_dir / f"{pid}.json").write_text(json.dumps(ranges))
        page_of_para[pid] = where
        n_pages += len(ranges)
        n_lines += len(lines)

    rng = random.Random(a.seed)
    pids = sorted(data)
    rng.shuffle(pids)
    questions = []
    eligible = 0
    for pid in pids:
        paper = data[pid]
        picks = []
        for q in paper["qas"]:
            answers = [x["answer"] for x in q["answers"]]
            if not answers or any(x["unanswerable"] for x in answers):
                continue
            if len({x["yes_no"] for x in answers if x["yes_no"] is not None}) > 1:
                continue  # annotators disagree on yes / no
            gold_pages = sorted(
                {
                    page_of_para[pid][norm(e)]
                    for x in answers
                    for e in x["evidence"]
                    if not e.startswith(FLOAT) and norm(e) in page_of_para[pid]
                }
            )
            refs = list(dict.fromkeys(t for t in (answer_text(x) for x in answers) if t))
            if gold_pages and refs:
                picks.append((q, answers, gold_pages, refs))
        eligible += len(picks)
        if not picks or len(questions) >= a.questions:
            continue
        q, answers, gold_pages, refs = rng.choice(picks)
        title = norm(paper["title"])
        gold = refs[0] if len(refs) == 1 else "Reference answers by different annotators (any one is acceptable): " + " ".join(
            f"({i + 1}) {r}" for i, r in enumerate(refs)
        )
        questions.append(
            {
                "financebench_id": f"qasper_{q['question_id'][:12]}",
                "company": "papers",
                "doc_name": pid,
                "question_type": answer_type(answers[0]),
                "question_reasoning": None,
                "question": f'In the paper "{title}": {norm(q["question"])}',
                "answer": gold,
                "evidence": [{"doc_name": pid, "evidence_page_num": p} for p in gold_pages],
            }
        )
    (HERE / "data" / "open.jsonl").write_text("".join(json.dumps(q, ensure_ascii=False) + "\n" for q in questions))
    (HERE / "prompt.json").write_text(
        json.dumps(
            {
                "benchmark": f"QASPER test v0.3, {len(questions)} sampled questions (seed {a.seed})",
                "agent_intro": 'You are a research assistant answering a question about a research paper from a library of NLP papers. The library has one folder, papers/, with one Markdown file per paper; every document starts with front matter (title, arxiv_id) and every page with an "<!-- page N -->" line.',
                "single_intro": "You are a research assistant answering a question about a research paper from a library of NLP papers.",
                "single_pages": "The pages may come from different papers; use the ones that answer the question.",
            },
            indent=2,
        )
        + "\n"
    )
    (HERE / "data" / "docs.jsonl").write_text("".join(json.dumps({"doc_name": pid, "company": "papers"}) + "\n" for pid in sorted(data)))
    types: dict[str, int] = {}
    for q in questions:
        types[q["question_type"]] = types.get(q["question_type"], 0) + 1
    print(f"{len(data)} papers, {n_pages} pages, {n_lines} lines; {eligible} eligible questions, {len(questions)} sampled {types}")


if __name__ == "__main__":
    main()
