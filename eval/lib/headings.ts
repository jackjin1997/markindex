/**
 * Heading reconstruction for corpus sources whose Markdown lost its headings in conversion.
 * Each function only prefixes `#` marks onto existing lines (never adds or removes lines), so line numbers
 * of the reconstructed file match the source text line for line.
 */

const ATX = /^ {0,3}#{1,6}\s/

export const countAtxHeadings = (md: string) => md.split('\n').filter((l) => ATX.test(l)).length

/**
 * The SEC conversion separates pages with a bare `---` line and has no blank lines between paragraphs, so per
 * CommonMark each `---` turns the whole preceding page into one giant setext heading. Rewriting those lines as
 * `***` (also a thematic break, but never a setext underline) keeps the page break and the line count.
 */
export function neutralizePageBreaks(md: string): string {
  return md.replace(/^ {0,3}-{3,}[ \t]*$/gm, '***')
}

const SEC_PART = /^\s*(?:\*\*)?\s*PART\s+(I{1,3}|IV)\b\.?/i
const SEC_ITEM = /^\s*(?:\*\*)?\s*Item\s+(\d{1,2}[A-C]?)\s*[.:]/i

/** The single non-empty cell of a table row, if it has exactly one (headings that the converter put in tables). */
function soleCell(line: string): string | undefined {
  const cells = line
    .split('|')
    .map((c) => c.trim())
    .filter((c) => c !== '')
  return cells.length === 1 ? cells[0] : undefined
}

/**
 * SEC 10-K: "PART I" lines become h1, "Item 1A. Risk Factors" lines become h2. A line qualifies when it is short
 * and either plain text or a table row with a single non-empty cell (table-of-contents rows have several cells
 * and are left alone). Running page headers repeating the current PART / Item are not promoted again.
 */
export function reconstructSecHeadings(md: string): string {
  let part = ''
  let item = ''
  return md
    .split('\n')
    .map((line) => {
      if (ATX.test(line)) return line
      const t = line.trim().startsWith('|') ? soleCell(line) : line.trim()
      if (!t || t.length > 160) return line
      const plain = t.replace(/\*\*/g, '').replace(/\s+/g, ' ').trim()
      const p = plain.match(SEC_PART)
      if (p) {
        const id = p[1]!.toUpperCase()
        if (id === part) return line
        part = id
        item = ''
        return `# ${plain}`
      }
      const i = plain.match(SEC_ITEM)
      if (i) {
        const id = i[1]!.toUpperCase()
        if (id === item) return line
        item = id
        return `## ${plain}`
      }
      return line
    })
    .join('\n')
}

const CN_NUM = '[一二三四五六七八九十百零〇两\\d]+'
const ZH_RULES: [RegExp, string][] = [
  [new RegExp(`^第${CN_NUM}编(?:[\\s　]|$)`), '#'],
  [new RegExp(`^第${CN_NUM}分编(?:[\\s　]|$)`), '##'],
  [new RegExp(`^第${CN_NUM}章(?:[\\s　]|$)`), '##'],
  [new RegExp(`^第${CN_NUM}节(?:[\\s　]|$)`), '###'],
  [/^[一二三四五六七八九十]+、/, '###'],
  [new RegExp(`^[（(]${CN_NUM}[）)]`), '####'],
]

/**
 * Chinese laws / clinical norms: 第X编 → h1, 第X章 → h2, 第X节 / 一、→ h3, （一）→ h4. Only short lines
 * (titles, not article bodies) qualify; "第X条" article lines are never headings.
 */
export function reconstructZhHeadings(md: string): string {
  return md
    .split('\n')
    .map((line) => {
      const t = line.trim().replace(/^\*\*(.*)\*\*$/, '$1')
      if (t === '' || t.length > 40 || ATX.test(line) || /[。；;]$/.test(t)) return line
      for (const [re, mark] of ZH_RULES) if (re.test(t)) return `${mark} ${t}`
      return line
    })
    .join('\n')
}
