"""Paired comparison of two report files (run.ts / baseline.ts): accuracy of each and an exact McNemar test.

    python3 eval/financebench/compare.py runs/full150-lib367.json runs/baseline-dense-top20.json [more.json ...]

The first report is compared with each of the others on the questions both contain. Run reports (runs/) and
published ones (results/) both work. A question counts as correct only when the first judge said so (an unjudged or
failed question is not correct). The test is two-sided and exact:
with b questions only A gets right and c only B gets right, p = min(1, 2 * P[X <= min(b, c)]), X ~ Binomial(b + c, 1/2).
"""
import json
import math
import sys
from pathlib import Path


def load(path: str) -> dict[str, bool]:
    """Verdict of the first judge: `correct` in run reports, the "sonnet/mafin" vote in adjudicated reports."""
    out = {}
    for r in json.loads(Path(path).read_text())["results"]:
        out[r["id"]] = (r["correct"] if "correct" in r else r["votes"]["sonnet/mafin"]) is True
    return out


def mcnemar(b: int, c: int) -> float:
    n = b + c
    return min(1.0, 2 * sum(math.comb(n, k) for k in range(min(b, c) + 1)) / 2**n) if n else 1.0


def main() -> None:
    if len(sys.argv) < 3:
        sys.exit(__doc__)
    a_path, *others = sys.argv[1:]
    a = load(a_path)
    print(f"A = {a_path}: {sum(a.values())}/{len(a)} = {100 * sum(a.values()) / len(a):.1f}%")
    for b_path in others:
        b = load(b_path)
        ids = [i for i in a if i in b]
        a_only = sum(a[i] and not b[i] for i in ids)
        b_only = sum(b[i] and not a[i] for i in ids)
        both = sum(a[i] and b[i] for i in ids)
        print(
            f"B = {b_path}: {sum(b.values())}/{len(b)} = {100 * sum(b.values()) / len(b):.1f}% | "
            f"shared {len(ids)}, both {both}, A only {a_only}, B only {b_only}, exact McNemar p = {mcnemar(a_only, b_only):.2g}"
        )


if __name__ == "__main__":
    main()
