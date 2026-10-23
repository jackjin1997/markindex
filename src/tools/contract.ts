import { z } from 'zod'
import { DEFAULT_STRUCTURE_DEPTH, STRUCTURE_FIRST_TOKEN_THRESHOLD } from '../config.js'

export type ToolName =
  | 'browse_documents'
  | 'get_document'
  | 'get_document_structure'
  | 'get_node_content'
  | 'search_documents'

const T = STRUCTURE_FIRST_TOKEN_THRESHOLD

const docPath = () =>
  z
    .string()
    .min(1)
    .describe(
      'Library-relative path of the document, copied verbatim from a browse_documents() or search_documents() ' +
        'result (case-sensitive, include the extension). Example: "guides/setup.md". Never construct one.',
    )

const part = () =>
  z
    .int()
    .min(1)
    .default(1)
    .describe(
      'Part number for pagination (1-based, default 1). Increment until the response\'s `pagination.has_more` ' +
        'becomes false.',
    )

const folder = (what: string) =>
  z
    .string()
    .describe(
      `${what} Library-relative folder path, copied verbatim from a \`folders\` entry of a browse_documents() ` +
        'response ("" = library root). Never construct one.',
    )

const browseInput = z.strictObject({
  folder: folder('Folder to list (default "", the library root).').default(''),
  offset: z
    .int()
    .min(0)
    .default(0)
    .describe(
      'Zero-based pagination offset. Pass the value of `next_offset` from the previous response to fetch the next page.',
    ),
  limit: z
    .int()
    .min(1)
    .max(50)
    .default(10)
    .describe('Number of documents to return per page (1-50, default 10).'),
})

const getDocumentInput = z.strictObject({ doc_path: docPath() })

const structureInput = z.strictObject({
  doc_path: docPath(),
  node_id: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Expand only the subtree of this node (depth counts from it). Copy it verbatim from a ' +
        'get_document_structure() or search_documents() result; omit for the whole document.',
    ),
  depth: z
    .int()
    .min(1)
    .max(10)
    .default(DEFAULT_STRUCTURE_DEPTH)
    .describe(
      `Number of outline levels to return (1-10, default ${DEFAULT_STRUCTURE_DEPTH}). Deeper nodes are ` +
        'summarized by `child_count`.',
    ),
  part: part(),
})

const contentInput = z.strictObject({
  doc_path: docPath(),
  node_ids: z
    .array(z.string().min(1))
    .min(1)
    .max(20)
    .describe(
      'Ids of the nodes to read (1-20), each copied verbatim from a get_document_structure() or ' +
        'search_documents() result. Never construct one.',
    ),
  part: part(),
})

const searchInput = z.strictObject({
  query: z
    .string()
    .min(1)
    .describe(
      'Keywords to look for: distinctive terms, names or identifiers as they appear in the text ' +
        '(e.g. "ISO-27001 audit", "离职 补偿"). Not a natural-language question.',
    ),
  folder: folder('Restrict the search to documents under this folder.').optional(),
  doc_path: docPath().optional().describe(
    'Restrict the search to this document (takes precedence over `folder`). Copy it verbatim from a ' +
      'browse_documents() or search_documents() result.',
  ),
  limit: z.int().min(1).max(50).default(10).describe('Maximum number of matching nodes to return (1-50, default 10).'),
})

/**
 * Tool names, descriptions and input schemas. The descriptions are the agent's usage guide and part of the
 * contract (spec §8): a snapshot test guards them.
 */
export const TOOL_CONTRACT = {
  browse_documents: {
    description:
      'Primary discovery tool for the Markdown library. The bare call lists the library root: its sub-folders and ' +
      'the documents directly inside it (path, title, description, tokens). Pass `folder` to drill into a ' +
      'sub-folder level by level, and `offset: next_offset` to page through long listings. Browse first — do NOT ' +
      'jump to `search_documents()`: keyword search is an escalation path for when browsing and reading document ' +
      'structures have failed to locate the answer.',
    input: browseInput,
  },
  get_document: {
    description:
      "Get one document's metadata: title, description, frontmatter, size (lines, tokens) and " +
      `\`read_structure_first\` (true for documents over ${T} tokens). Use it to decide how to read the document: ` +
      'small documents can be read directly from their top-level nodes, large ones need ' +
      '`get_document_structure()` first.',
    input: getDocumentInput,
  },
  get_document_structure: {
    description:
      "Get a document's section outline — node_id, title, line range, tokens, summary — without body text. " +
      `REQUIRED for documents over ${T} tokens: call this first to locate the relevant sections, then read them ` +
      'with `get_node_content()`. Returns `depth` levels (default ' +
      `${DEFAULT_STRUCTURE_DEPTH}); nodes below the cut show \`child_count\` — pass their \`node_id\` to expand ` +
      'that subtree. Large outlines are split into parts: increment `part` until `pagination.has_more` is false.',
    input: structureInput,
  },
  get_node_content: {
    description:
      'Read the original Markdown of one or more nodes, every line prefixed with its line number in the file ' +
      '("123│ "). Reading a node returns its whole line range INCLUDING all of its subsections, so prefer the most ' +
      'specific (leaf) nodes for precision and read a parent only when you need the entire section. Copy each ' +
      '`node_id` verbatim from `get_document_structure()` or `search_documents()`; never construct one. Long ' +
      'content is split into parts: increment `part` until `pagination.has_more` is false. Cite what you use as ' +
      '[doc_path, L<start>-<end>] with the line numbers shown.',
    input: contentInput,
  },
  search_documents: {
    description:
      'Keyword (BM25) search over section titles, summaries and text, with a substring fallback; handles mixed ' +
      'Chinese/English text and identifiers such as "C++" or "ISO-27001". Returns matching nodes (doc_path, ' +
      'node_id, title_path, line range, snippet). Escalation path: use it when browsing folders and reading ' +
      'structures has not located the answer, or to find an exact term; scope it with `folder` or `doc_path`. ' +
      'Then read the hits with `get_node_content()`.',
    input: searchInput,
  },
} as const satisfies Record<ToolName, { description: string; input: z.ZodObject }>

export type ToolInput<N extends ToolName> = z.output<(typeof TOOL_CONTRACT)[N]['input']>

// ── agent instructions (adapted from PageIndex agent_tools.py) ──

const HEADER =
  "MarkIndex manages the user's library of long Markdown documents (manuals, specs, notes, knowledge bases). " +
  'Every document is indexed as a tree of sections (nodes) addressed by line ranges in the original file.'

const DISCOVERY = `\
DOCUMENT DISCOVERY:
- browse_documents() — DEFAULT discovery tool, first choice for any document-related question. The bare call returns the library root's folders and documents with titles and descriptions; drill into folders whose names match the user's intent.
- search_documents() — escalation path: use it when browsing and reading structures stalls, or to locate an exact term, name or identifier.`

const DECISION = `\
DECISION:
- "What do I have / list / what's in folder X" → browse_documents()
- ANY question that needs a document to answer → browse_documents(), pick the documents whose path/title/description matches, then read them
- Reading a document: call get_document() first. If read_structure_first is true (over ${T} tokens), call get_document_structure() and read only the relevant nodes with get_node_content(); otherwise you may read its top-level nodes directly.
- Prefer the most specific (leaf) nodes: reading a parent returns all of its subsections.`

const AFTER_DISCOVERY = `\
- Skip discovery ONLY for questions with NO possible document connection (e.g., "capital of France").
- After discovery: 1 match or 1 clearly best match → proceed to read and answer without asking. Multiple equally relevant → ask user to pick.`

const PERSISTENCE = `\
PERSISTENCE (before concluding the answer is not in the library):
Applies both when results are empty AND when returned results do not clearly match the user's intent — treat a mismatch as "not found". Do NOT give up after a single attempt. Follow these steps in order:
1. browse_documents() level by level and compare every folder and document against the user's intent
2. Read the structure of the most plausible documents and follow promising sections
3. search_documents() with the key terms, then again with synonyms, alternative terms or the other language (Chinese/English)
4. Page through the ENTIRE folder with \`limit: 50\` and \`offset: next_offset\` until has_more is false — MANDATORY before concluding "not found"
Only after ALL steps have been tried may you conclude the answer is not in the library. Do NOT fall back to general knowledge — if the user's question references their own documents, exhaust every discovery path first.`

const CITATIONS = `\
GROUNDING AND CITATIONS:
- Answer only from content read with get_node_content(); never fill a gap from general knowledge. When the documents do not answer the question, say so.
- Cite every supported claim right after it as [doc_path, L<start>-<end>], using the line numbers shown in the content (e.g. [guides/setup.md, L120-134]). Cite the narrowest range that supports the claim; use separate references for separate ranges.`

const TOOL_USAGE_RULES = `\
TOOL USAGE RULES:
- Invoke a tool only when all required parameters are present or clearly inferable. Never invent placeholder values.
- Copy doc_path, folder and node_id values verbatim from earlier tool results; never construct or guess them.
- If a node_id is reported unknown, the document was re-indexed: call get_document_structure() again and use the new ids.
- If a tool returns an error, follow the provided next_steps/options (or present them to the user) instead of retrying blindly.`

/** System-prompt guidance for an agent using the tools in `TOOL_CONTRACT`. */
export const AGENT_INSTRUCTIONS = [HEADER, DISCOVERY, DECISION, AFTER_DISCOVERY, PERSISTENCE, CITATIONS, TOOL_USAGE_RULES].join(
  '\n\n',
)
