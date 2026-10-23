import { createHash } from 'node:crypto'
import { generateText, type LanguageModel } from 'ai'
import { SUMMARY_TOKEN_THRESHOLD } from '../config.js'
import type { Store } from '../store/db.js'
import type { TreeNode } from '../types.js'

export interface SummaryOptions {
  model: LanguageModel
  /** Nodes with `ownTokens` below this use their own text as the summary (default SUMMARY_TOKEN_THRESHOLD). */
  threshold?: number
  /** Max parallel LLM calls (default 8). */
  concurrency?: number
  /** Retries per call, handled by the AI SDK (default 3). */
  maxRetries?: number
  /** Also generate a one-sentence document description (default true). */
  describe?: boolean
}

export interface SummaryFailure {
  /** Node id, or `null` for the document description. */
  nodeId: string | null
  message: string
}

export interface SummarizeResult {
  /** LLM calls made (successful or failed), including the description call. */
  llmCalls: number
  /** Nodes whose summary came from the `summaries` cache. */
  cached: number
  usage: { inputTokens: number; outputTokens: number }
  /** Calls that still failed after retries. Successful summaries are persisted regardless. */
  failures: SummaryFailure[]
}

const DEFAULT_CONCURRENCY = 8
const DEFAULT_MAX_RETRIES = 3
/** PageIndex caps summaries at about this many words; stated in the prompt. */
const SUMMARY_WORD_LIMIT = 150
/** Outline given to the description prompt is cut to this many chars so it cannot overflow the context. */
export const OUTLINE_MAX_CHARS = 12_000
const OUTLINE_SUMMARY_CHARS = 160

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')

/** Port of PageIndex `generate_node_summary`, plus language and length constraints. */
export function nodeSummaryPrompt(text: string): string {
  return `You are given a part of a document, your task is to generate a description of the partial document about what are main points covered in the partial document.

Write the description in the same language as the partial document text. Keep it concise (at most ${SUMMARY_WORD_LIMIT} words).

Partial Document Text: ${text}

Directly return the description, do not include any other text.`
}

/** Port of PageIndex `generate_doc_description`, plus a language constraint. */
export function docDescriptionPrompt(outline: string): string {
  return `You are an expert in generating descriptions for a document.
You are given a structure of a document. Your task is to generate a one-sentence description for the document, which makes it easy to distinguish the document from other documents.

Write the description in the same language as the document structure's titles.

Document Structure:
${outline}

Directly return the description, do not include any other text.`
}

interface Target {
  node: TreeNode
  text: string
  field: 'summary' | 'prefixSummary'
  /** Present when the node is over the threshold and needs the LLM / the cache. */
  hash?: string
}

function flatten(nodes: TreeNode[], out: TreeNode[] = []): TreeNode[] {
  for (const n of nodes) {
    out.push(n)
    flatten(n.children, out)
  }
  return out
}

/** Nodes of a document that get a summary: blank nodes are skipped; short ones carry their own text. */
function targets(store: Store, docPath: string, tree: TreeNode[], threshold: number): Target[] {
  const out: Target[] = []
  for (const node of flatten(tree)) {
    const text = store.getLines(docPath, node.startLine, node.ownEndLine).join('\n')
    if (text.trim() === '') continue
    const field = node.children.length === 0 ? 'summary' : 'prefixSummary'
    out.push(node.ownTokens < threshold ? { node, text, field } : { node, text, field, hash: sha256(text) })
  }
  return out
}

/** Titles + truncated summaries, indented by depth, cut to OUTLINE_MAX_CHARS. */
export function buildOutline(tree: TreeNode[], maxChars = OUTLINE_MAX_CHARS): string {
  const lines: string[] = []
  let size = 0
  const walk = (nodes: TreeNode[], depth: number): boolean => {
    for (const n of nodes) {
      const s = (n.summary ?? n.prefixSummary ?? '').replace(/\s+/g, ' ').trim()
      const line = `${'  '.repeat(depth)}- ${n.title}${s ? `: ${Array.from(s).slice(0, OUTLINE_SUMMARY_CHARS).join('')}` : ''}`
      if (size + line.length + 1 > maxChars) return false
      lines.push(line)
      size += line.length + 1
      if (!walk(n.children, depth + 1)) return false
    }
    return true
  }
  const complete = walk(tree, 0)
  if (!complete) lines.push('- ... (outline truncated)')
  return lines.join('\n')
}

async function runPool<T>(items: T[], concurrency: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0
  const worker = async () => {
    while (next < items.length) await fn(items[next++]!)
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, worker))
}

const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e))

/**
 * Fills node summaries (leaf -> `summary`, non-leaf -> `prefixSummary` of the node's own text only) and, unless
 * `describe` is false and the doc has none yet, the document description. Nodes under the threshold use their own
 * text; others are looked up in the `summaries` cache by sha256 of their own text, then sent to the LLM. A failed
 * call never throws and never touches the store: it is returned in `failures`, everything that succeeded is saved.
 */
export async function summarizeDocument(store: Store, docPath: string, opts: SummaryOptions): Promise<SummarizeResult> {
  const threshold = opts.threshold ?? SUMMARY_TOKEN_THRESHOLD
  const concurrency = opts.concurrency ?? DEFAULT_CONCURRENCY
  const maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES
  const result: SummarizeResult = { llmCalls: 0, cached: 0, usage: { inputTokens: 0, outputTokens: 0 }, failures: [] }

  const doc = store.getDoc(docPath)
  const tree = store.getTree(docPath)
  if (!doc || !tree) throw new Error(`document not found: ${docPath}`)

  const ask = async (prompt: string): Promise<string> => {
    result.llmCalls++
    const res = await generateText({ model: opts.model, prompt, maxRetries })
    result.usage.inputTokens += res.usage?.inputTokens ?? 0
    result.usage.outputTokens += res.usage?.outputTokens ?? 0
    const text = res.text.trim()
    if (text === '') throw new Error('model returned an empty response')
    return text
  }

  const summaryByHash = new Map<string, string>()
  const pending = new Map<string, Target[]>()
  const updates: { nodeId: string; summary?: string; prefixSummary?: string }[] = []
  for (const t of targets(store, docPath, tree, threshold)) {
    if (t.hash === undefined) {
      updates.push({ nodeId: t.node.nodeId, [t.field]: t.text })
      continue
    }
    const hit = summaryByHash.get(t.hash) ?? store.getCachedSummary(t.hash)
    if (hit !== undefined) {
      summaryByHash.set(t.hash, hit)
      result.cached++
      updates.push({ nodeId: t.node.nodeId, [t.field]: hit })
    } else {
      const list = pending.get(t.hash)
      if (list) list.push(t)
      else pending.set(t.hash, [t])
    }
  }

  await runPool([...pending.entries()], concurrency, async ([hash, group]) => {
    try {
      const summary = await ask(nodeSummaryPrompt(group[0]!.text))
      store.putCachedSummary(hash, summary)
      for (const t of group) updates.push({ nodeId: t.node.nodeId, [t.field]: summary })
    } catch (e) {
      for (const t of group) result.failures.push({ nodeId: t.node.nodeId, message: errorMessage(e) })
    }
  })

  if (updates.length > 0) {
    try {
      store.updateNodeSummaries(docPath, updates)
    } catch (e) {
      result.failures.push({ nodeId: null, message: `could not save summaries: ${errorMessage(e)}` })
    }
  }

  // No description from an incomplete outline: it would never be regenerated once stored.
  if (opts.describe !== false && doc.description === undefined && result.failures.length === 0) {
    try {
      const description = await ask(docDescriptionPrompt(buildOutline(store.getTree(docPath)!)))
      store.setDocDescription(docPath, description)
    } catch (e) {
      result.failures.push({ nodeId: null, message: errorMessage(e) })
    }
  }
  return result
}

/**
 * Dry-run over every indexed document: how many nodes are over the threshold, how many LLM calls a full
 * `summarizeDocument` pass would make (unique uncached node texts + one description per undescribed document unless
 * `describe` is false) and the node-text input tokens (description outlines are not counted).
 */
export function estimateSummaryCost(
  store: Store,
  opts: { threshold?: number; describe?: boolean } = {},
): { nodes: number; llmCalls: number; inputTokens: number } {
  const threshold = opts.threshold ?? SUMMARY_TOKEN_THRESHOLD
  let nodes = 0
  let inputTokens = 0
  let descriptions = 0
  const seen = new Set<string>()
  for (const path of store.allDocPaths()) {
    const tree = store.getTree(path)!
    if (opts.describe !== false && store.getDoc(path)!.description === undefined) descriptions++
    for (const t of targets(store, path, tree, threshold)) {
      if (t.hash === undefined) continue
      nodes++
      if (seen.has(t.hash) || store.getCachedSummary(t.hash) !== undefined) continue
      seen.add(t.hash)
      inputTokens += t.node.ownTokens
    }
  }
  return { nodes, llmCalls: seen.size + descriptions, inputTokens }
}
