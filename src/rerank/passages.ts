/** Distinct lowercased words of at least four letters or digits: the terms a relevant passage tends to share. */
export function queryTerms(text: string): string[] {
  return [...new Set(text.toLowerCase().match(/[\p{L}\p{N}]{4,}/gu) ?? [])]
}

/**
 * The stretch of `text` of at most `maxChars` that contains the most distinct `terms` (earliest on a tie).
 * Sections in a web corpus run to tens of thousands of characters; the evidence is rarely at the top.
 */
export function bestWindow(text: string, terms: string[], maxChars: number): string {
  if (text.length <= maxChars) return text
  const lower = text.toLowerCase()
  const step = Math.max(1, Math.floor(maxChars / 2))
  let best = 0
  let bestCount = -1
  for (let from = 0; from < text.length; from += step) {
    const win = lower.slice(from, from + maxChars)
    let count = 0
    for (const t of terms) if (win.includes(t)) count++
    if (count > bestCount) {
      bestCount = count
      best = from
    }
    if (from + maxChars >= text.length) break
  }
  return text.slice(best, best + maxChars)
}

/** Items by score, best first; unscored ones keep their original order after the scored ones. Stable. */
export function orderByScore<T>(items: T[], scores: (number | null)[]): T[] {
  return items
    .map((item, i) => ({ item, i, s: scores[i] ?? null }))
    .sort((a, b) => (a.s === null ? (b.s === null ? a.i - b.i : 1) : b.s === null ? -1 : b.s - a.s || a.i - b.i))
    .map((x) => x.item)
}
