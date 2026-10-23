const segmenter = new Intl.Segmenter(undefined, { granularity: 'word' })

/** Terms like v2.1, C++, ISO-27001 that the word segmenter would split or truncate. */
const COMPOUND = /[A-Za-z0-9]+(?:[.\-_][A-Za-z0-9]+|[+#]+)+/g

function words(text: string): string[] {
  const out: string[] = []
  for (const s of segmenter.segment(text)) {
    if (s.isWordLike) out.push(s.segment.toLowerCase())
  }
  return out
}

function tokenize(text: string): string[] {
  const out: string[] = []
  let last = 0
  for (const m of text.matchAll(COMPOUND)) {
    out.push(...words(text.slice(last, m.index)))
    out.push(m[0].toLowerCase())
    last = m.index + m[0].length
  }
  out.push(...words(text.slice(last)))
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
