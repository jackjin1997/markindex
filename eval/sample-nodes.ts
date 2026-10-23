/**
 * Prints randomly sampled index nodes as question-writing candidates (gold = the node's doc_path + line range).
 *
 *   npx tsx eval/sample-nodes.ts --group zh --n 70 --seed 1 [--latin] [--root eval/corpus] [--excerpt 700]
 *
 * --group  library folder prefix to sample from (finance-en | medical-en | zh | "" for all)
 * --latin  only nodes whose own text contains Latin-script terms (for mixed zh/en questions)
 * Only leaf nodes with 120-4000 own tokens are sampled (enough text to ask about, gold range = own text).
 * At most 2 nodes per document, so questions spread over the library.
 */
import { join, resolve } from 'node:path'
import { openLibrary } from '../src/library.js'
import { walk } from '../src/tree/build.js'
import { rng } from './lib/rng.js'

const args = process.argv.slice(2)
const arg = (name: string, def: string) => {
  const i = args.indexOf(name)
  return i === -1 ? def : args[i + 1]!
}
const ROOT = resolve(arg('--root', join(import.meta.dirname, 'corpus')))
const GROUP = arg('--group', '')
const N = Number(arg('--n', '50'))
const SEED = Number(arg('--seed', '1'))
const EXCERPT = Number(arg('--excerpt', '700'))
const LATIN = args.includes('--latin')
const MIN_OWN = 120
const MAX_OWN = 4000
const PER_DOC = 2

const lib = openLibrary({ root: ROOT })
try {
  const r = rng(SEED)
  const docs = lib.store.allDocPaths().filter((d) => GROUP === '' || d.startsWith(`${GROUP}/`))
  const candidates: { doc: string; titlePath: string[]; start: number; end: number; text: string }[] = []
  for (const doc of docs) {
    for (const { node, titlePath } of walk(lib.store.getTree(doc) ?? [])) {
      if (node.children.length > 0 || node.ownTokens < MIN_OWN || node.ownTokens > MAX_OWN) continue
      candidates.push({ doc, titlePath, start: node.startLine, end: node.endLine, text: '' })
    }
  }
  // Fisher-Yates with the seeded generator
  for (let i = candidates.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1))
    ;[candidates[i], candidates[j]] = [candidates[j]!, candidates[i]!]
  }
  const perDoc = new Map<string, number>()
  let shown = 0
  for (const c of candidates) {
    if (shown >= N) break
    if ((perDoc.get(c.doc) ?? 0) >= PER_DOC) continue
    const text = lib.store.getLines(c.doc, c.start, c.end).join('\n')
    if (LATIN && !/[A-Za-z]{3,}/.test(text.replace(/https?:\S+/g, ''))) continue
    perDoc.set(c.doc, (perDoc.get(c.doc) ?? 0) + 1)
    shown++
    const excerpt = text.replace(/\|[\s|]*\|/g, '|').replace(/\s+/g, ' ').slice(0, EXCERPT)
    process.stdout.write(`### ${shown}. ${c.doc} L${c.start}-${c.end}\n${JSON.stringify(c.titlePath)}\n${excerpt}\n\n`)
  }
  process.stderr.write(`group=${GROUP || '(all)'} seed=${SEED} candidates=${candidates.length} shown=${shown}\n`)
} finally {
  lib.close()
}
