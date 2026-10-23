import { createHash } from 'node:crypto'
import type { ParsedDoc } from '../parse/markdown.js'
import { approxTokens, type TokenCounter } from '../text/tokens.js'
import type { TreeNode } from '../types.js'

export interface BuildTreeOptions {
  /** Title for a doc without headings (root node). */
  fileTitle: string
  countTokens?: TokenCounter
}

const SEP = '\u001f'
const PREFACE_TITLE = 'Preface'

/**
 * Build the section tree (stack algorithm, like PageIndex `build_tree_from_nodes`).
 *
 * Conventions:
 * - `level` is 0 for the preface and for the title-less root of a headless doc.
 * - Blank-only lines before the first heading are absorbed into the first heading's node
 *   (no spurious preface); non-blank text produces a `preface` node.
 * - A doc without headings yields one root `section` titled `fileTitle`, covering all non-frontmatter lines.
 * - A doc with no lines outside frontmatter yields `[]`.
 * - Every line outside frontmatter belongs to exactly one node's own range [startLine, ownEndLine].
 */
export function buildTree(doc: ParsedDoc, opts: BuildTreeOptions): TreeNode[] {
  const count = opts.countTokens ?? approxTokens
  const total = doc.lines.length
  const first = doc.firstContentLine
  if (first > total) return []

  const text = (from: number, to: number) => doc.lines.slice(from - 1, to).join('\n')
  const make = (title: string, kind: TreeNode['kind'], level: number, startLine: number): TreeNode => ({
    nodeId: '',
    title,
    kind,
    level,
    startLine,
    endLine: total,
    ownEndLine: total,
    tokens: 0,
    ownTokens: 0,
    children: [],
  })

  const roots: TreeNode[] = []
  const headings = doc.headings

  if (headings.length === 0) {
    roots.push(make(opts.fileTitle, 'section', 0, first))
  } else {
    const firstHeading = headings[0]!.line
    let hasPreface = false
    for (let i = first; i < firstHeading; i++) {
      if (doc.lines[i - 1]!.trim() !== '') {
        hasPreface = true
        break
      }
    }
    if (hasPreface) {
      const p = make(PREFACE_TITLE, 'preface', 0, first)
      p.endLine = p.ownEndLine = firstHeading - 1
      roots.push(p)
    }
    const stack: TreeNode[] = []
    headings.forEach((h, idx) => {
      const node = make(h.title, 'section', h.level, !hasPreface && idx === 0 ? first : h.line)
      while (stack.length > 0 && stack[stack.length - 1]!.level >= h.level) {
        stack.pop()!.endLine = h.line - 1
      }
      const parent = stack[stack.length - 1]
      if (parent) parent.children.push(node)
      else roots.push(node)
      stack.push(node)
    })
  }

  finalize(roots, [], text, count)
  return roots
}

/** Fills ownEndLine, tokens and nodeId (needs titlePath + sibling ordinal). */
function finalize(
  siblings: TreeNode[],
  parentPath: string[],
  text: (from: number, to: number) => string,
  count: TokenCounter,
): void {
  const seen = new Map<string, number>()
  for (const node of siblings) {
    const ordinal = seen.get(node.title) ?? 0
    seen.set(node.title, ordinal + 1)
    const path = [...parentPath, node.title]
    node.nodeId = makeId(path, ordinal)
    const firstChild = node.children[0]
    node.ownEndLine = firstChild ? firstChild.startLine - 1 : node.endLine
    node.ownTokens = count(text(node.startLine, node.ownEndLine))
    node.tokens = firstChild ? count(text(node.startLine, node.endLine)) : node.ownTokens
    finalize(node.children, path, text, count)
  }
}

function makeId(titlePath: string[], ordinal: number): string {
  return createHash('sha1')
    .update(titlePath.join(SEP) + SEP + ordinal)
    .digest('hex')
    .slice(0, 10)
}

/** Depth-first pre-order traversal with the title path of each node. */
export function* walk(roots: TreeNode[]): Generator<{ node: TreeNode; titlePath: string[] }> {
  function* rec(nodes: TreeNode[], parent: string[]): Generator<{ node: TreeNode; titlePath: string[] }> {
    for (const node of nodes) {
      const titlePath = [...parent, node.title]
      yield { node, titlePath }
      yield* rec(node.children, titlePath)
    }
  }
  yield* rec(roots, [])
}

/** Throws when spec §5.2 invariants are violated. Test / debug helper. */
export function assertCoverage(doc: ParsedDoc, roots: TreeNode[]): void {
  const total = doc.lines.length
  const first = doc.firstContentLine
  let expected = first
  for (const { node, titlePath } of walk(roots)) {
    const label = titlePath.join(' > ')
    if (node.startLine !== expected) {
      throw new Error(`coverage: "${label}" starts at ${node.startLine}, expected ${expected}`)
    }
    if (node.ownEndLine < node.startLine || node.ownEndLine > node.endLine) {
      throw new Error(`coverage: "${label}" has invalid own range ${node.startLine}-${node.ownEndLine} (end ${node.endLine})`)
    }
    const firstChild = node.children[0]
    if (firstChild && firstChild.startLine !== node.ownEndLine + 1) {
      throw new Error(`coverage: "${label}" ownEndLine ${node.ownEndLine} does not precede first child at ${firstChild.startLine}`)
    }
    const lastChild = node.children[node.children.length - 1]
    if (lastChild && lastChild.endLine !== node.endLine) {
      throw new Error(`coverage: "${label}" endLine ${node.endLine} != last child endLine ${lastChild.endLine}`)
    }
    expected = node.ownEndLine + 1
  }
  if (expected !== Math.max(first, total + 1)) {
    throw new Error(`coverage: lines ${expected}..${total} are not covered`)
  }
}
