import { MAX_NODE_TOKENS, ROUTING_COST_TOKENS } from '../config.js'
import type { ParsedDoc } from '../parse/markdown.js'
import { approxTokens, type TokenCounter } from '../text/tokens.js'
import type { TreeNode } from '../types.js'

export interface OptimizeTreeOptions {
  /** Expand threshold, and upper bound for a node created by merge. */
  maxNodeTokens?: number
  /** R(v): constant cost of routing through a node (title, summary, child descriptions). */
  routingCost?: number
  /** Must be the counter the tree was built with. */
  countTokens?: TokenCounter
}

const CHUNK_TITLE_CHARS = 60

/**
 * Token-cost tree optimization, ported from PageIndex `tree_optimize.py` with pages -> tokens (spec §5.3).
 *
 *   S(v)          = v.tokens (whole subtree)
 *   R(v)          = routingCost
 *   S_residual(v) = v.ownTokens
 *   tree_cost(v)  = S(v)                                           v is a leaf
 *                 = R(v) + max(S_residual(v), max_c tree_cost(c))  otherwise
 *
 * Pure: returns a new tree, the input is not mutated. Retained nodes keep their nodeId.
 *
 * 1. expand (no LLM): every node whose own text exceeds `maxNodeTokens` is split deterministically.
 *    The own range is packed greedily into segments of <= maxNodeTokens; the first segment stays the
 *    node's own text, the others become `chunk` children inserted before any existing children
 *    (so a non-leaf with a huge intro is handled too). nodeId = parent id + `-c` + 1-based ordinal.
 *    Split points, coarsest first: starts of top-level mdast blocks (a block plus the blank lines after
 *    it is atomic); only a block that alone exceeds the limit is split by lines, and then never inside a
 *    fenced code block nested in it (e.g. in a list item); only a fenced region that alone exceeds the
 *    limit (including a top-level code block) is split at arbitrary lines. A single line is never split,
 *    so one line above the limit yields an oversized segment.
 * 2. merge, bottom-up: merge(v) iff S(v) <= tree_cost(v) and S(v) <= maxNodeTokens. The second clause
 *    is an addition to PageIndex: merging must not recreate a node that expand would split again.
 *    Removed descendant titles (and their own keyItems) go to v.keyItems in pre-order.
 *
 * Expand runs first so that a large intro next to small children is chunked instead of swallowing the
 * children's headings; chunks are never merged back because their parent always exceeds the limit.
 */
export function optimizeTree(roots: TreeNode[], doc: ParsedDoc, opts: OptimizeTreeOptions = {}): TreeNode[] {
  const ctx: Ctx = {
    doc,
    max: opts.maxNodeTokens ?? MAX_NODE_TOKENS,
    routing: opts.routingCost ?? ROUTING_COST_TOKENS,
    count: opts.countTokens ?? approxTokens,
  }
  return roots.map((root) => {
    const node = expand(structuredClone(root), ctx)
    merge(node, ctx)
    return node
  })
}

interface Ctx {
  doc: ParsedDoc
  max: number
  routing: number
  count: TokenCounter
}

interface Range {
  start: number
  end: number
}

const slice = (doc: ParsedDoc, from: number, to: number) => doc.lines.slice(from - 1, to).join('\n')

// ---------------------------------------------------------------- expand

function expand(node: TreeNode, ctx: Ctx): TreeNode {
  node.children = node.children.map((c) => expand(c, ctx))
  if (node.ownTokens <= ctx.max) return node

  const segments = pack({ start: node.startLine, end: node.ownEndLine }, ctx)
  if (segments.length < 2) return node
  const [own, ...rest] = segments as [Range, ...Range[]]
  node.ownEndLine = own.end
  node.ownTokens = ctx.count(slice(ctx.doc, own.start, own.end))
  const chunks = rest.map((r, i): TreeNode => {
    const tokens = ctx.count(slice(ctx.doc, r.start, r.end))
    return {
      nodeId: `${node.nodeId}-c${i + 1}`,
      title: chunkTitle(ctx.doc.lines.slice(r.start - 1, r.end)) || `Part ${i + 1}`,
      kind: 'chunk',
      level: node.level + 1,
      startLine: r.start,
      endLine: r.end,
      ownEndLine: r.end,
      tokens,
      ownTokens: tokens,
      children: [],
    }
  })
  node.children = [...chunks, ...node.children]
  return node
}

/** Splits `range` into consecutive segments of <= ctx.max tokens where possible. */
function pack(range: Range, ctx: Ctx): Range[] {
  const blockStarts = ctx.doc.blocks.map((b) => b.startLine).filter((l) => l > range.start && l <= range.end)
  const atoms = cut(range, blockStarts).flatMap((r) => refine(r, ctx))

  const segments: Range[] = []
  let cur: Range[] = []
  let estimate = 0
  const flush = () => {
    // The additive estimate is an upper bound for the default counter; verify against the real counter.
    while (cur.length > 0) {
      let n = cur.length
      while (n > 1 && ctx.count(slice(ctx.doc, cur[0]!.start, cur[n - 1]!.end)) > ctx.max) n--
      segments.push({ start: cur[0]!.start, end: cur[n - 1]!.end })
      cur = cur.slice(n)
    }
  }
  for (const atom of atoms) {
    const t = ctx.count(slice(ctx.doc, atom.start, atom.end))
    if (cur.length > 0 && estimate + 1 + t > ctx.max) {
      flush()
      estimate = 0
    }
    estimate = cur.length === 0 ? t : estimate + 1 + t
    cur.push(atom)
  }
  flush()
  return segments
}

/** Ranges starting at range.start and at each of `points` (sorted, inside (start, end]). */
function cut(range: Range, points: number[]): Range[] {
  const starts = [range.start, ...points]
  return starts.map((s, i) => ({ start: s, end: i + 1 < starts.length ? starts[i + 1]! - 1 : range.end }))
}

/** An atom above the limit is cut at lines outside fenced code, then (fence too big) at every line. */
function refine(atom: Range, ctx: Ctx): Range[] {
  if (atom.end === atom.start || ctx.count(slice(ctx.doc, atom.start, atom.end)) <= ctx.max) return [atom]
  const outside = cut(atom, linesOutsideFences(ctx.doc, atom))
  return outside.flatMap((r) =>
    r.end > r.start && ctx.count(slice(ctx.doc, r.start, r.end)) > ctx.max
      ? cut(r, range(r.start + 1, r.end))
      : [r],
  )
}

const FENCE = /^\s*(`{3,}|~{3,})/

/** Lines in (atom.start, atom.end] that do not lie inside a fenced code block (closing fence counts as inside). */
function linesOutsideFences(doc: ParsedDoc, atom: Range): number[] {
  const legal: number[] = []
  let open: string | undefined
  for (let l = atom.start; l <= atom.end; l++) {
    if (l > atom.start && open === undefined) legal.push(l)
    const m = FENCE.exec(doc.lines[l - 1]!)
    if (!m) continue
    const fence = m[1]!
    if (open === undefined) open = fence
    else if (fence[0] === open[0] && fence.length >= open.length && doc.lines[l - 1]!.trim() === fence) open = undefined
  }
  return legal
}

const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i)

/** First non-empty line with markdown syntax removed, truncated to 60 characters. */
function chunkTitle(lines: string[]): string {
  for (const raw of lines) {
    if (FENCE.test(raw)) continue
    const t = raw
      .replace(/^\s*(?:>\s*)+/, '')
      .replace(/^\s*#{1,6}\s+/, '')
      .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '')
      .replace(/^\[[ xX]\]\s+/, '')
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]*)\]\[[^\]]*\]/g, '$1')
      .replace(/<[^>]+>/g, '')
      .replace(/\*\*|__|~~|[*`]/g, '')
      .replace(/\|/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
    if (t !== '' && !/^[-:\s]+$/.test(t)) return Array.from(t).slice(0, CHUNK_TITLE_CHARS).join('').trimEnd()
  }
  return ''
}

// ---------------------------------------------------------------- merge

/** Bottom-up merge; returns tree_cost(node) after the decision. */
function merge(node: TreeNode, ctx: Ctx): number {
  if (node.children.length === 0) return node.tokens
  const childCost = Math.max(...node.children.map((c) => merge(c, ctx)))
  const treeCost = ctx.routing + Math.max(node.ownTokens, childCost)
  if (node.tokens > treeCost || node.tokens > ctx.max) return treeCost

  const keyItems = [...(node.keyItems ?? [])]
  const collect = (nodes: TreeNode[]) => {
    for (const c of nodes) {
      if (c.kind !== 'chunk') keyItems.push(c.title)
      keyItems.push(...(c.keyItems ?? []))
      collect(c.children)
    }
  }
  collect(node.children)
  node.children = []
  node.ownEndLine = node.endLine
  node.ownTokens = node.tokens
  if (keyItems.length > 0) node.keyItems = keyItems
  return node.tokens
}
