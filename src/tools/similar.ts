/** Optimal string alignment distance (Levenshtein + adjacent transposition), by code point. */
export function editDistance(a: string, b: string): number {
  const s = [...a]
  const t = [...b]
  const rows: number[][] = Array.from({ length: s.length + 1 }, (_, i) =>
    Array.from({ length: t.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  )
  for (let i = 1; i <= s.length; i++) {
    for (let j = 1; j <= t.length; j++) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1
      let d = Math.min(rows[i - 1]![j]! + 1, rows[i]![j - 1]! + 1, rows[i - 1]![j - 1]! + cost)
      if (i > 1 && j > 1 && s[i - 1] === t[j - 2] && s[i - 2] === t[j - 1]) d = Math.min(d, rows[i - 2]![j - 2]! + 1)
      rows[i]![j] = d
    }
  }
  return rows[s.length]![t.length]!
}

const basename = (p: string) => p.slice(p.lastIndexOf('/') + 1)

/** 1 = identical, 0 = nothing in common; like difflib's ratio, based on edit distance. */
function similarity(a: string, b: string): number {
  const len = Math.max([...a].length, [...b].length)
  return len === 0 ? 1 : 1 - editDistance(a, b) / len
}

/**
 * Up to `limit` candidates most similar to `query` (difflib `get_close_matches`-like, cutoff 0.5). A candidate is
 * compared both as a whole and by its last path segment against the query's last segment, so `annual.md` finds
 * `reports/annual.md`. Ties keep the candidates' order.
 */
export function similarNames(query: string, candidates: readonly string[], limit: number): string[] {
  const q = query.trim().toLowerCase()
  const qBase = basename(q)
  return candidates
    .map((c, i) => {
      const lc = c.toLowerCase()
      return { c, i, score: Math.max(similarity(q, lc), similarity(qBase, basename(lc))) }
    })
    .filter((x) => x.score >= 0.5)
    .sort((x, y) => y.score - x.score || x.i - y.i)
    .slice(0, limit)
    .map((x) => x.c)
}
