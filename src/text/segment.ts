const segmenter = new Intl.Segmenter(undefined, { granularity: 'word' })

/**
 * Terms like v2.1, C++, ISO-27001 that the word segmenter would split or truncate. The lookbehind anchors each
 * attempt at the start of an alphanumeric run: without it a long run with no separator backtracks from every
 * position (quadratic). Matches are unchanged, since a match never starts inside a run.
 */
const COMPOUND = /(?<![A-Za-z0-9])[A-Za-z0-9]+(?:[.\-_][A-Za-z0-9]+|[+#]+)+/g

/** Appends the lowercased word-like segments of `text` to `out` (no spread: spans may hold 10^5+ words). */
function words(text: string, out: string[]): void {
  for (const s of segmenter.segment(text)) {
    if (s.isWordLike) out.push(s.segment.toLowerCase())
  }
}

/** NFKC first, so full-width forms (ＡＢＣ, ２７００１) index and query like their ASCII forms. */
function tokenize(raw: string): string[] {
  const text = raw.normalize('NFKC')
  const out: string[] = []
  let last = 0
  for (const m of text.matchAll(COMPOUND)) {
    words(text.slice(last, m.index), out)
    out.push(m[0].toLowerCase())
    last = m.index + m[0].length
  }
  words(text.slice(last), out)
  return out
}

/** Space-separated lowercase tokens, suitable for an FTS5 `unicode61` column. */
export function segmentForIndex(text: string): string {
  return tokenize(text).join(' ')
}

/** FTS5 MATCH expression: each token double-quoted, joined with OR (ranked by bm25). Empty if no tokens. */
export function segmentQuery(q: string): string {
  return tokenize(q)
    .map((t) => `"${t.replaceAll('"', '""')}"`)
    .join(' OR ')
}
