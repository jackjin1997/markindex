/**
 * Table-of-contents navigation by a decision model: which filing, then which sections, from names alone.
 * Shared by toc_eval.ts (offline test) and toc_server.ts (the same steps as an agent tool). Evaluation only.
 *
 * The model (TypeSafe Jev, ../lib/jev.ts) sees the question and folder names, filing labels and section title
 * paths from MarkIndex's tree. It never sees body text unless `previewChars` is set.
 */
import type { Store } from '../../src/store/db.js'
import type { TreeNode } from '../../src/types.js'
import type { JevClient } from '../lib/jev.js'

/** Jev accepts at most 255 options per choice. */
const MAX_OPTIONS = 250

export interface Doc { path: string; title: string; folder: string; label: string }
export interface Sec { id: string; parent: string | null; title: string; path: string[]; start: number; ownEnd: number; end: number; ownTokens: number; children: Sec[] }

/**
 * Ranks `options` by asking for one choice at a time and removing the winner, `k` times. Jev's probabilities are
 * close to one-hot, so a single call does not order the runners-up. More options than one call takes are split
 * into groups whose winners meet in a final round.
 */
export async function rankByChoice<T>(jev: JevClient, state: unknown, instructions: string, options: T[], describe: (o: T) => string, k: number): Promise<T[]> {
  const pickOne = async (pool: T[]): Promise<T | null> => {
    if (pool.length === 0) return null
    if (pool.length === 1) return pool[0]!
    if (pool.length > MAX_OPTIONS) {
      const winners: T[] = []
      for (let i = 0; i < pool.length; i += MAX_OPTIONS) {
        const w = await pickOne(pool.slice(i, i + MAX_OPTIONS))
        if (w !== null) winners.push(w)
      }
      return pickOne(winners)
    }
    const criteria = Object.fromEntries(pool.map((o, i) => [`n${i + 1}`, describe(o)]))
    const a = await jev.ask(state, { type: 'choice', instructions, criteria })
    const m = /^n(\d+)$/.exec(a?.choice ?? '')
    return m ? (pool[Number(m[1]) - 1] ?? null) : null
  }
  const ranked: T[] = []
  let pool = [...options]
  while (ranked.length < k && pool.length > 0) {
    const w = await pickOne(pool)
    if (w === null) break
    ranked.push(w)
    pool = pool.filter((o) => o !== w)
  }
  return ranked
}

export function loadDocs(store: Store): { docs: Doc[]; folders: string[] } {
  const docs = (store.db.prepare('SELECT path, title, metadata FROM docs ORDER BY path').all() as { path: string; title: string; metadata: string }[]).map((d): Doc => {
    const m = JSON.parse(d.metadata) as { company?: string; doc_type?: string; period?: number }
    return { path: d.path, title: d.title, folder: d.path.split('/')[0]!, label: [m.company, m.doc_type?.toUpperCase(), m.period].filter(Boolean).join(' | ') || d.title }
  })
  return { docs, folders: [...new Set(docs.map((d) => d.folder))] }
}

export function loadTree(store: Store, docPath: string): { roots: Sec[]; all: Sec[] } {
  const rows = store.db.prepare('SELECT node_id AS id, parent_id AS parent, json FROM nodes WHERE doc_path = ?').all(docPath) as { id: string; parent: string | null; json: string }[]
  const byId = new Map<string, Sec>()
  for (const r of rows) {
    const n = JSON.parse(r.json) as TreeNode
    byId.set(r.id, { id: r.id, parent: r.parent, title: n.title.replace(/\s+/g, ' ').trim(), path: [], start: n.startLine, ownEnd: n.ownEndLine, end: n.endLine, ownTokens: n.ownTokens, children: [] })
  }
  const all = [...byId.values()].sort((a, b) => a.start - b.start)
  const roots: Sec[] = []
  for (const s of all) {
    const p = s.parent ? byId.get(s.parent) : undefined
    if (p) p.children.push(s)
    else roots.push(s)
  }
  const setPath = (s: Sec, prefix: string[]) => {
    s.path = [...prefix, s.title]
    for (const c of s.children) setPath(c, s.path)
  }
  for (const r of roots) setPath(r, [])
  return { roots, all }
}

/** What the model reads for a section: its title path, and the start of its own text when `previewChars` > 0. */
export function describeSection(store: Store, docPath: string, s: Sec, previewChars: number): string {
  const name = s.path.join(' > ')
  if (previewChars <= 0) return name
  const text = store.getLines(docPath, s.start, s.ownEnd).slice(1).join(' ').replace(/\s+/g, ' ').trim().slice(0, previewChars)
  return text ? `${name} — begins: ${text}` : name
}

/** Filings ranked for the question: the two most likely folders, up to three filings from each. */
export async function routeFilings(jev: JevClient, question: string, docs: Doc[], folders: string[]): Promise<Doc[]> {
  const topFolders = await rankByChoice(jev, { question }, 'Which company is `question` about?', folders, (f) => f.replaceAll('_', ' '), 2)
  const ranked: Doc[] = []
  for (const f of topFolders) {
    const inFolder = docs.filter((d) => d.folder === f)
    ranked.push(...(await rankByChoice(jev, { question }, 'Which filing contains the information needed to answer `question`? Go by the fiscal period and the type of report that `question` refers to.', inFolder, (d) => d.label, 3)))
  }
  return ranked
}

/** Every section of `doc` with the probability that the question is answered there, best first. One call per section. */
export async function scoreSections(jev: JevClient, store: Store, question: string, doc: Doc, all: Sec[], previewChars = 0): Promise<{ sec: Sec; p: number }[]> {
  const scores = await Promise.all(
    all.map((s) =>
      jev.ask({ question, filing: doc.label, section: describeSection(store, doc.path, s, previewChars) }, {
        type: 'noul',
        instructions: 'Is `section` the part of `filing` where the information needed to answer `question` is reported?',
      }),
    ),
  )
  return all
    .map((sec, i) => ({ sec, i, p: scores[i]?.noul ?? -1 }))
    .sort((a, b) => b.p - a.p || a.i - b.i)
    .map(({ sec, p }) => ({ sec, p }))
}
