import type { z } from 'zod'
import { RESPONSE_CHAR_BUDGET, SIMILAR_NAMES_LIMIT, STRUCTURE_FIRST_TOKEN_THRESHOLD } from '../config.js'
import type { Store } from '../store/db.js'
import { searchNodes } from '../store/search.js'
import { walk } from '../tree/build.js'
import type { DocumentRecord, TreeNode } from '../types.js'
import { TOOL_CONTRACT, type ToolInput, type ToolName } from './contract.js'
import { failure, jsonSize, splitByBudget, success, type Envelope, type NextSteps } from './envelope.js'
import { similarNames } from './similar.js'

const TOOL_NAMES = Object.keys(TOOL_CONTRACT) as ToolName[]
/** Placeholder for part numbers when measuring envelope overhead (no real document has a million parts). */
const MAX_PART = 999_999
/** Minimum room for one content segment, even if a huge title path eats the budget (best effort). */
const MIN_SEGMENT = 256

/**
 * Runs one tool against `store`. Never throws: invalid input, unknown names and internal failures all come back
 * as error envelopes. Every returned envelope serializes to at most RESPONSE_CHAR_BUDGET characters.
 */
export function runTool(store: Store, name: unknown, args: unknown): Envelope {
  let env: Envelope
  try {
    env = dispatch(store, name, args)
  } catch (e) {
    env = failure(
      'INTERNAL_ERROR',
      `Tool failed: ${e instanceof Error ? e.message : String(e)}`,
      {
        summary: 'The library could not be read.',
        options: [
          'Try the request again',
          'If it keeps failing, the index may be closed, missing or corrupt: ask the user to re-run `markindex index`',
        ],
      },
      { tool: String(name) },
    )
  }
  if (jsonSize(env) > RESPONSE_CHAR_BUDGET) {
    env = failure('INTERNAL_ERROR', 'Response too large for the response budget', {
      summary: 'The result does not fit in one response.',
      options: ['Narrow the request: use a smaller `limit`, a deeper `folder`, or fewer `node_ids`'],
    })
  }
  return env
}

function dispatch(store: Store, name: unknown, args: unknown): Envelope {
  if (typeof name !== 'string' || !(TOOL_NAMES as string[]).includes(name)) {
    return failure(
      'INVALID_INPUT',
      `Unknown tool: ${String(name)}`,
      { summary: 'No tool with this name exists.', options: [`Use one of: ${TOOL_NAMES.join(', ')}`] },
      { tool: name === undefined ? null : name },
    )
  }
  const tool = name as ToolName
  const parsed = TOOL_CONTRACT[tool].input.safeParse(args === undefined ? {} : args)
  if (!parsed.success) return invalidArgs(tool, parsed.error)
  const input = parsed.data
  switch (tool) {
    case 'browse_documents':
      return browse(store, input as ToolInput<'browse_documents'>)
    case 'get_document':
      return getDocument(store, input as ToolInput<'get_document'>)
    case 'get_document_structure':
      return getStructure(store, input as ToolInput<'get_document_structure'>)
    case 'get_node_content':
      return getContent(store, input as ToolInput<'get_node_content'>)
    case 'search_documents':
      return search(store, input as ToolInput<'search_documents'>)
  }
}

function invalidArgs(tool: ToolName, error: z.ZodError): Envelope {
  const issues = error.issues.map((i) => ({ path: i.path.map(String).join('.') || '(arguments)', message: i.message }))
  return failure(
    'INVALID_INPUT',
    `Invalid arguments for ${tool}: ${issues.map((i) => `${i.path}: ${i.message}`).join('; ')}`,
    {
      summary: 'The arguments do not match the tool schema.',
      options: [
        `Call ${tool}() with a JSON object matching its input schema`,
        'Copy doc_path, folder and node_id values verbatim from earlier tool results',
      ],
    },
    { issues },
  )
}

// ── lookup helpers ──

const normFolder = (f: string) => f.trim().replace(/^\/+|\/+$/g, '')

function allFolders(paths: string[]): string[] {
  const out = new Set<string>()
  for (const p of paths) {
    const segs = p.split('/')
    for (let i = 1; i < segs.length; i++) out.add(segs.slice(0, i).join('/'))
  }
  return [...out].sort()
}

function resolveDoc(store: Store, path: string): { doc: DocumentRecord } | { error: Envelope } {
  const doc = store.getDoc(path)
  if (doc) return { doc }
  const similar = similarNames(path, store.allDocPaths(), SIMILAR_NAMES_LIMIT)
  return {
    error: failure(
      'NOT_FOUND',
      similar.length
        ? `Document not found. Did you mean: ${similar.map((s) => `"${s}"`).join(', ')}?`
        : 'Document not found',
      {
        summary: 'The requested document does not exist in the library index.',
        options: [
          ...similar.map((s) => `Retry with doc_path: "${s}"`),
          'Copy doc_path verbatim from a browse_documents() or search_documents() result (case-sensitive, include the extension)',
          'Use browse_documents() to list the library',
          'Use search_documents() to find the document by keyword',
        ],
      },
      { doc_path: path, similar_paths: similar },
    ),
  }
}

function folderNotFound(store: Store, folder: string): Envelope {
  const similar = similarNames(folder, allFolders(store.allDocPaths()), SIMILAR_NAMES_LIMIT)
  return failure(
    'NOT_FOUND',
    similar.length
      ? `Folder not found. Did you mean: ${similar.map((s) => `"${s}"`).join(', ')}?`
      : 'Folder not found',
    {
      summary: 'No indexed documents live under this folder.',
      options: [
        ...similar.map((s) => `Retry with folder: "${s}"`),
        'Copy folder verbatim from the `folders` of a browse_documents() response',
        'Call browse_documents() without `folder` to start at the library root',
      ],
    },
    { folder, similar_folders: similar },
  )
}

const folderExists = (store: Store, folder: string) =>
  folder === '' || store.allDocPaths().some((p) => p.startsWith(`${folder}/`))

function findNode(tree: TreeNode[], nodeId: string): { node: TreeNode; titlePath: string[] } | undefined {
  for (const e of walk(tree)) if (e.node.nodeId === nodeId) return e
  return undefined
}

function staleNodes(docPath: string, unknown: string[]): Envelope {
  return failure(
    'NOT_FOUND',
    `Unknown node_id for this document: ${unknown.join(', ')}`,
    {
      summary: 'These node ids do not exist in the current index of the document; it may have been re-indexed since you read its structure.',
      options: [
        `Call get_document_structure({ doc_path: "${docPath}" }) again and copy the current node ids verbatim`,
        'Use search_documents() with doc_path to locate the section by keyword',
      ],
    },
    { doc_path: docPath, unknown_node_ids: unknown },
  )
}

function partOutOfRange(tool: ToolName, part: number, total: number): Envelope {
  return failure(
    'INVALID_INPUT',
    `part ${part} is out of range: this response has ${total} part${total === 1 ? '' : 's'}`,
    {
      summary: 'The requested part does not exist.',
      options: [`Request a part between 1 and ${total} (last part: part: ${total})`, `Call ${tool}() with part: 1 to start over`],
    },
    { part, total_parts: total },
  )
}

const pagination = (part: number, total: number) => ({ part, total_parts: total, has_more: part < total })

/**
 * Budget for the paginated payload: RESPONSE_CHAR_BUDGET minus the envelope around it, measured with an empty
 * payload (`[]`) and placeholder part numbers in every next_steps variant.
 */
function payloadBudget(make: (payload: unknown[], part: number, total: number) => Envelope): number {
  const overhead = Math.max(jsonSize(make([], MAX_PART - 1, MAX_PART)), jsonSize(make([], MAX_PART, MAX_PART))) - 2
  return RESPONSE_CHAR_BUDGET - overhead
}

/** Drops trailing items until the envelope fits the budget (keeps at least one). */
function fitList<T>(items: T[], make: (items: T[]) => Envelope): { env: Envelope; kept: number } {
  let n = items.length
  let env = make(items)
  while (n > 1 && jsonSize(env) > RESPONSE_CHAR_BUDGET) {
    n--
    env = make(items.slice(0, n))
  }
  return { env, kept: n }
}

// ── browse_documents ──

function browse(store: Store, input: ToolInput<'browse_documents'>): Envelope {
  const folder = normFolder(input.folder)
  if (!folderExists(store, folder)) return folderNotFound(store, folder)
  const { offset, limit } = input
  const listing = store.listDocs(folder, offset, limit)
  if (offset > 0 && offset >= listing.total) {
    return failure(
      'INVALID_INPUT',
      `offset ${offset} is past the end of this folder (${listing.total} documents)`,
      {
        summary: 'There are no documents at this offset.',
        options: ['Call browse_documents() with offset: 0', 'Use `next_offset` from the previous response, not a guessed value'],
      },
      { folder, offset, total: listing.total },
    )
  }
  const docs = listing.docs.map((d) => ({
    path: d.path,
    title: d.title,
    ...(d.description === undefined ? {} : { description: d.description }),
    tokens: d.tokens,
  }))
  const make = (page: typeof docs) => {
    const next = offset + page.length < listing.total ? offset + page.length : null
    const options = [
      'Use get_document() / get_document_structure() with a doc_path copied from `docs`',
      'Pass a `folders` entry as `folder` to drill into a sub-folder',
    ]
    if (next !== null) options.unshift(`More documents: call browse_documents() with offset: ${next}`)
    return success(
      { folder, folders: listing.folders, docs: page, total: listing.total, next_offset: next, has_more: next !== null },
      {
        summary: `Showing documents ${listing.total ? offset + 1 : 0}-${offset + page.length} of ${listing.total} in ${folder === '' ? 'the library root' : `"${folder}"`}, plus ${listing.folders.length} sub-folder(s).`,
        options,
      },
    )
  }
  return fitList(docs, make).env
}

// ── get_document ──

function getDocument(store: Store, input: ToolInput<'get_document'>): Envelope {
  const r = resolveDoc(store, input.doc_path)
  if ('error' in r) return r.error
  const d = r.doc
  const readStructureFirst = d.tokens > STRUCTURE_FIRST_TOKEN_THRESHOLD
  return success(
    {
      doc_path: d.path,
      title: d.title,
      ...(d.description === undefined ? {} : { description: d.description }),
      line_count: d.lineCount,
      tokens: d.tokens,
      metadata: d.metadata,
      indexed_at: d.indexedAt,
      read_structure_first: readStructureFirst,
    },
    readStructureFirst
      ? {
          summary: `Large document (${d.tokens} tokens > ${STRUCTURE_FIRST_TOKEN_THRESHOLD}): read its structure first.`,
          options: [
            `Call get_document_structure({ doc_path: "${d.path}" }) to locate the relevant sections`,
            'Then read only those nodes with get_node_content()',
          ],
        }
      : {
          summary: `Small document (${d.tokens} tokens): it can be read directly.`,
          options: [
            `Call get_document_structure({ doc_path: "${d.path}" }) and read its top-level nodes with get_node_content()`,
          ],
        },
  )
}

// ── get_document_structure ──

interface StructureNode {
  node_id: string
  title: string
  kind: TreeNode['kind']
  start_line: number
  end_line: number
  tokens: number
  summary?: string
  child_count?: number
  nodes?: StructureNode[]
}

function formatStructure(node: TreeNode, depth: number): StructureNode {
  const out: StructureNode = {
    node_id: node.nodeId,
    title: node.title,
    kind: node.kind,
    start_line: node.startLine,
    end_line: node.endLine,
    tokens: node.tokens,
  }
  const summary = node.summary ?? node.prefixSummary
  if (summary !== undefined) out.summary = summary
  if (node.children.length) {
    if (depth > 1) out.nodes = node.children.map((c) => formatStructure(c, depth - 1))
    else out.child_count = node.children.length
  }
  return out
}

function getStructure(store: Store, input: ToolInput<'get_document_structure'>): Envelope {
  const r = resolveDoc(store, input.doc_path)
  if ('error' in r) return r.error
  const docPath = r.doc.path
  const tree = store.getTree(docPath) ?? []
  let roots = tree
  let titlePath: string[] | undefined
  if (input.node_id !== undefined) {
    const found = findNode(tree, input.node_id)
    if (!found) return staleNodes(docPath, [input.node_id])
    roots = [found.node]
    titlePath = found.titlePath
  }
  const structure = roots.map((n) => formatStructure(n, input.depth))

  const make = (chunk: unknown[], part: number, total: number) =>
    success(
      {
        doc_path: docPath,
        ...(titlePath === undefined ? {} : { node_id: input.node_id, title_path: titlePath }),
        structure: chunk,
        pagination: pagination(part, total),
      },
      part < total
        ? {
            summary: `Showing part ${part} of ${total} of the outline.`,
            options: [
              `Request the next part with part: ${part + 1}`,
              'Read relevant nodes with get_node_content() using node_id values copied verbatim',
            ],
          }
        : {
            summary: total > 1 ? `Showing the last part (${part} of ${total}) of the outline.` : 'Document outline retrieved.',
            options: [
              'Read relevant nodes with get_node_content() using node_id values copied verbatim',
              'Pass the node_id of a node with child_count as `node_id` to expand it',
            ],
          },
    )
  const chunks = splitByBudget(structure, payloadBudget(make))
  if (input.part > chunks.length) return partOutOfRange('get_document_structure', input.part, chunks.length)
  return make(chunks[input.part - 1]!, input.part, chunks.length)
}

// ── get_node_content ──

interface ContentEntry {
  node_id: string
  title_path: string[]
  start_line: number
  end_line: number
  /** False when this entry holds only some of the node's lines (the rest are in neighbouring parts). */
  complete: boolean
  text: string
}

/** JSON-escaped length of a string's content (without the quotes). */
const escLen = (s: string) => JSON.stringify(s).length - 2

/** `n│ line`, split into several segments with the same prefix when one would exceed `max` escaped chars. */
function segments(n: number, line: string, max: number): string[] {
  const prefix = `${n}│ `
  const whole = prefix + line
  if (escLen(whole) <= max) return [whole]
  const out: string[] = []
  let cur = ''
  let curLen = escLen(prefix)
  for (const ch of line) {
    const l = escLen(ch)
    if (cur !== '' && curLen + l > max) {
      out.push(prefix + cur)
      cur = ''
      curLen = escLen(prefix)
    }
    cur += ch
    curLen += l
  }
  out.push(prefix + cur)
  return out
}

/** Packs the numbered lines of `targets` into parts whose JSON array fits `budget`, splitting nodes as needed. */
function packContent(
  store: Store,
  docPath: string,
  targets: { node: TreeNode; titlePath: string[] }[],
  budget: number,
): ContentEntry[][] {
  const parts: ContentEntry[][] = []
  let part: ContentEntry[] = []
  let used = 2 // "[]" plus closed entries and their separating commas
  const flushPart = () => {
    if (part.length) parts.push(part)
    part = []
    used = 2
  }
  for (const { node, titlePath } of targets) {
    const meta = { node_id: node.nodeId, title_path: titlePath, start_line: node.startLine, end_line: node.endLine }
    const entryBase = jsonSize({ ...meta, complete: false, text: '' })
    const maxSegment = Math.max(MIN_SEGMENT, budget - 2 - entryBase)
    let lines: string[] = []
    let textLen = 0
    let split = false
    const closeEntry = (complete: boolean) => {
      const entry: ContentEntry = { ...meta, complete, text: lines.join('\n') }
      used += jsonSize(entry) + (part.length ? 1 : 0)
      part.push(entry)
      lines = []
      textLen = 0
    }
    const projected = (add: number) => used + (part.length ? 1 : 0) + entryBase + textLen + add
    const raw = store.getLines(docPath, node.startLine, node.endLine)
    raw.forEach((line, i) => {
      for (const seg of segments(node.startLine + i, line, maxSegment)) {
        const add = escLen(seg) + (lines.length ? 2 : 0) // "\n" separator is 2 escaped chars
        if (projected(add) > budget && (lines.length || part.length)) {
          if (lines.length) {
            split = true
            closeEntry(false)
          }
          flushPart()
          lines = []
        }
        textLen += escLen(seg) + (lines.length ? 2 : 0)
        lines.push(seg)
      }
    })
    closeEntry(!split)
  }
  flushPart()
  return parts.length ? parts : [[]]
}

function getContent(store: Store, input: ToolInput<'get_node_content'>): Envelope {
  const r = resolveDoc(store, input.doc_path)
  if ('error' in r) return r.error
  const docPath = r.doc.path
  const tree = store.getTree(docPath) ?? []
  const byId = new Map<string, { node: TreeNode; titlePath: string[] }>()
  for (const e of walk(tree)) byId.set(e.node.nodeId, e)
  const ids = [...new Set(input.node_ids)]
  const unknown = ids.filter((id) => !byId.has(id))
  if (unknown.length) return staleNodes(docPath, unknown)

  const make = (content: unknown[], part: number, total: number) =>
    success(
      { doc_path: docPath, content, pagination: pagination(part, total) },
      part < total
        ? {
            summary: `Showing part ${part} of ${total} of the requested content.`,
            options: [
              `Request the next part with part: ${part + 1}`,
              'Or read a more specific (child) node: get_document_structure() with node_id lists them',
            ],
          }
        : {
            summary: total > 1 ? `Showing the last part (${part} of ${total}) of the requested content.` : 'Content retrieved.',
            options: [
              `Cite as [${docPath}, L<start>-<end>] using the line numbers shown`,
              'Use get_document_structure() to find related sections',
            ],
          },
    )
  const parts = packContent(store, docPath, ids.map((id) => byId.get(id)!), payloadBudget(make))
  if (input.part > parts.length) return partOutOfRange('get_node_content', input.part, parts.length)
  return make(parts[input.part - 1]!, input.part, parts.length)
}

// ── search_documents ──

function search(store: Store, input: ToolInput<'search_documents'>): Envelope {
  let docPath: string | undefined
  let folder: string | undefined
  if (input.doc_path !== undefined) {
    const r = resolveDoc(store, input.doc_path)
    if ('error' in r) return r.error
    docPath = r.doc.path
  } else if (input.folder !== undefined) {
    folder = normFolder(input.folder)
    if (!folderExists(store, folder)) return folderNotFound(store, folder)
  }
  const hits = searchNodes(store, input.query, { docPath, folder, limit: input.limit }).map((h) => ({
    doc_path: h.docPath,
    node_id: h.nodeId,
    title_path: h.titlePath,
    start_line: h.startLine,
    end_line: h.endLine,
    snippet: h.snippet,
    score: h.score,
    via: h.via,
  }))
  const scope = docPath !== undefined ? { doc_path: docPath } : folder ? { folder } : {}
  const make = (results: typeof hits): Envelope =>
    success(
      { query: input.query, ...scope, results },
      results.length
        ? {
            summary: `Found ${results.length} matching node(s).`,
            options: [
              'Read the most relevant hits with get_node_content() using doc_path and node_id copied verbatim',
              'Use get_document_structure() with node_id to see the surrounding sections',
            ],
          }
        : {
            summary: 'No matching nodes.',
            options: [
              'Rephrase with synonyms, alternative terms or the other language (Chinese/English)',
              'Widen the scope: drop `doc_path` / `folder`',
              'Browse with browse_documents() and read document structures instead',
            ],
          },
    )
  return fitList(hits, make).env
}
