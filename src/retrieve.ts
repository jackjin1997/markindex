import { generateText, stepCountIs, tool, type LanguageModel, type StopCondition, type ToolSet } from 'ai'
import { z } from 'zod'
import { createAiSdkTools } from './adapters/ai-sdk.js'
import type { Library } from './library.js'
import { AGENT_INSTRUCTIONS } from './tools/contract.js'
import { walk } from './tree/build.js'
import type { TreeNode } from './types.js'

export interface Evidence {
  docPath: string
  nodeId: string
  titlePath: string[]
  startLine: number
  endLine: number
  /** Re-read from the store by line range; never the model's own text. */
  text: string
}

export interface RetrieveOptions {
  model: LanguageModel
  /** Max model steps (default 12). */
  maxSteps?: number
  /** Stop once cumulative input tokens over completed steps reach this (default 200_000). */
  maxInputTokens?: number
  /** Restrict the search to this folder (prompt-level instruction; the tools take a `folder` argument). */
  folder?: string
}

export interface RetrieveResult {
  evidence: Evidence[]
  usage: { inputTokens: number; outputTokens: number }
  /** 'done': the model finished (selected evidence, or answered without selecting). */
  stopReason: 'done' | 'budget' | 'max_steps'
  /** Number of selected items dropped because the doc / node / range was invalid. */
  dropped: number
}

const SELECT_EVIDENCE = 'select_evidence'

const selectEvidenceInput = z.object({
  items: z.array(
    z.object({
      doc_path: z.string(),
      node_id: z.string(),
      start_line: z.number().int().optional(),
      end_line: z.number().int().optional(),
    }),
  ),
})

const EVIDENCE_INSTRUCTIONS = [
  'You are gathering evidence, not answering. Use the discovery tools to find the relevant sections, read them to confirm,',
  `then call ${SELECT_EVIDENCE} exactly once with every section (doc_path + node_id, optionally a narrower start_line/end_line) that`,
  'supports the question. Do not write a final answer; the evidence text is read back from the library by line range.',
].join(' ')

/**
 * Built-in evidence retrieval loop. Returns evidence + usage + stopReason, never an answer.
 *
 * Termination: `select_evidence` is registered without `execute`; per the AI SDK, a step that calls a tool without
 * `execute` ends the loop on its own (no extra `hasToolCall` condition needed). Evidence is taken from the last
 * `select_evidence` call; if the model never calls it (budget / max_steps / plain text), evidence is [].
 * Invalid refs (unknown doc, unknown node, empty clamped range) are dropped and counted in `dropped`.
 * `folder` is a prompt-level scoping instruction only.
 */
export async function retrieve(lib: Library, question: string, opts: RetrieveOptions): Promise<RetrieveResult> {
  const maxSteps = opts.maxSteps ?? 12
  const maxInputTokens = opts.maxInputTokens ?? 200_000

  const tools = {
    ...createAiSdkTools(lib),
    [SELECT_EVIDENCE]: tool({
      description: 'Submit the final evidence sections. Ends the retrieval.',
      inputSchema: selectEvidenceInput,
    }),
  } as ToolSet

  const overBudget: StopCondition<ToolSet, any> = ({ steps }) =>
    steps.reduce((sum, s) => sum + (s.usage.inputTokens ?? 0), 0) >= maxInputTokens

  const scope = opts.folder
    ? `\n\nRestrict the search to the folder "${opts.folder}": pass folder="${opts.folder}" to browse/search tools.`
    : ''

  const res = await generateText({
    model: opts.model,
    system: `${AGENT_INSTRUCTIONS}\n\n${EVIDENCE_INSTRUCTIONS}${scope}`,
    prompt: question,
    tools,
    stopWhen: [stepCountIs(maxSteps), overBudget],
  })

  let selected: z.infer<typeof selectEvidenceInput>['items'] | undefined
  for (const step of res.steps) {
    for (const call of step.toolCalls) {
      if (call.toolName !== SELECT_EVIDENCE) continue
      const parsed = selectEvidenceInput.safeParse(call.input)
      if (parsed.success) selected = parsed.data.items
    }
  }

  const { evidence, dropped } = resolveEvidence(lib, selected ?? [])

  let stopReason: RetrieveResult['stopReason'] = 'done'
  if (selected === undefined) {
    const input = res.steps.reduce((sum, s) => sum + (s.usage.inputTokens ?? 0), 0)
    if (input >= maxInputTokens) stopReason = 'budget'
    else if (res.steps.length >= maxSteps && res.steps.at(-1)?.finishReason === 'tool-calls') stopReason = 'max_steps'
  }

  return {
    evidence,
    usage: {
      inputTokens: res.totalUsage.inputTokens ?? 0,
      outputTokens: res.totalUsage.outputTokens ?? 0,
    },
    stopReason,
    dropped,
  }
}

function resolveEvidence(
  lib: Library,
  items: z.infer<typeof selectEvidenceInput>['items'],
): { evidence: Evidence[]; dropped: number } {
  const evidence: Evidence[] = []
  const seen = new Set<string>()
  let dropped = 0
  const nodeIndex = new Map<string, Map<string, { node: TreeNode; titlePath: string[] }>>()
  for (const item of items) {
    let index = nodeIndex.get(item.doc_path)
    if (!index) {
      const roots = lib.store.getDoc(item.doc_path) ? lib.store.getTree(item.doc_path) : undefined
      index = new Map()
      for (const e of walk(roots ?? [])) index.set(e.node.nodeId, e)
      nodeIndex.set(item.doc_path, index)
    }
    const hit = index.get(item.node_id)
    if (!hit) {
      dropped++
      continue
    }
    const startLine = Math.max(hit.node.startLine, item.start_line ?? hit.node.startLine)
    const endLine = Math.min(hit.node.endLine, item.end_line ?? hit.node.endLine)
    const key = `${item.doc_path}\0${item.node_id}\0${startLine}\0${endLine}`
    if (endLine < startLine || seen.has(key)) {
      dropped++
      continue
    }
    seen.add(key)
    evidence.push({
      docPath: item.doc_path,
      nodeId: item.node_id,
      titlePath: hit.titlePath,
      startLine,
      endLine,
      text: lib.store.getLines(item.doc_path, startLine, endLine).join('\n'),
    })
  }
  return { evidence, dropped }
}
