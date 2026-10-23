import { MockLanguageModelV4 } from 'ai/test'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openLibrary, type Library } from '../src/library.js'
import { retrieve } from '../src/retrieve.js'
import { walk } from '../src/tree/build.js'
import { indexedFixtureRoot } from './adapters/helpers.js'

let lib: Library
let cleanup: () => void
beforeEach(async () => {
  const f = await indexedFixtureRoot()
  cleanup = f.cleanup
  lib = openLibrary({ root: f.root })
})
afterEach(() => {
  lib.close()
  cleanup()
})

const usage = (input: number) => ({
  inputTokens: { total: input, noCache: input, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 2, text: 2, reasoning: undefined },
})
const call = (toolName: string, input: unknown, id = toolName) => ({
  type: 'tool-call' as const,
  toolCallId: id,
  toolName,
  input: JSON.stringify(input),
})
const toolStep = (calls: ReturnType<typeof call>[], input = 10) => ({
  content: calls,
  finishReason: { unified: 'tool-calls' as const, raw: undefined },
  usage: usage(input),
  warnings: [],
})

/** Mock model that plays the scripted steps in order (last step repeats). */
const scripted = (steps: ReturnType<typeof toolStep>[]) => {
  let i = 0
  return new MockLanguageModelV4({ doGenerate: async () => steps[Math.min(i++, steps.length - 1)]! })
}

function firstNode() {
  const docPath = 'en-guide.md'
  const roots = lib.store.getTree(docPath)!
  const hit = [...walk(roots)].find((e) => e.node.endLine > e.node.startLine)!
  return { docPath, ...hit }
}

describe('retrieve', () => {
  it('returns evidence read from store, not model text', async () => {
    const { docPath, node, titlePath } = firstNode()
    const model = scripted([
      toolStep([call('search_documents', { query: 'npm install' })], 100),
      toolStep([call('select_evidence', { items: [{ doc_path: docPath, node_id: node.nodeId }], text: 'FAKE MODEL TEXT' })], 50),
    ])
    const r = await retrieve(lib, 'how to install?', { model })
    expect(r.stopReason).toBe('done')
    expect(r.evidence).toHaveLength(1)
    const e = r.evidence[0]!
    expect(e).toMatchObject({ docPath, nodeId: node.nodeId, titlePath, startLine: node.startLine, endLine: node.endLine })
    expect(e.text).toBe(lib.store.getLines(docPath, node.startLine, node.endLine).join('\n'))
    expect(e.text).not.toContain('FAKE MODEL TEXT')
    expect(r.usage).toEqual({ inputTokens: 150, outputTokens: 4 })
    expect(r.dropped).toBe(0)
    expect(r.selectedBy).toBe('model')
    expect(r.invalidSelection).toBe(false)
  })

  it('clamps requested line ranges to the node', async () => {
    const { docPath, node } = firstNode()
    const model = scripted([
      toolStep([
        call('select_evidence', {
          items: [{ doc_path: docPath, node_id: node.nodeId, start_line: node.startLine - 5, end_line: node.startLine }],
        }),
      ]),
    ])
    const r = await retrieve(lib, 'q', { model })
    expect(r.evidence[0]).toMatchObject({ startLine: node.startLine, endLine: node.startLine })
  })

  it('stops with budget when usage exceeds maxInputTokens', async () => {
    const model = scripted([toolStep([call('search_documents', { query: 'npm' })], 500)])
    const r = await retrieve(lib, 'q', { model, maxInputTokens: 400, maxSteps: 10 })
    expect(r.stopReason).toBe('budget')
    expect(r.evidence).toEqual([])
    expect(r.selectedBy).toBe('fallback')
    expect(r.usage.inputTokens).toBe(500)
  })

  it('budget stop falls back to nodes read via get_node_content', async () => {
    const { docPath, node } = firstNode()
    const model = scripted([toolStep([call('get_node_content', { doc_path: docPath, node_ids: [node.nodeId] })], 500)])
    const r = await retrieve(lib, 'q', { model, maxInputTokens: 400 })
    expect(r.stopReason).toBe('budget')
    expect(r.selectedBy).toBe('fallback')
    expect(r.evidence).toHaveLength(1)
    expect(r.evidence[0]).toMatchObject({ docPath, nodeId: node.nodeId, startLine: node.startLine, endLine: node.endLine })
    expect(r.evidence[0]!.text).toBe(lib.store.getLines(docPath, node.startLine, node.endLine).join('\n'))
  })

  it('max_steps stop falls back to nodes read via get_node_content', async () => {
    const { docPath, node } = firstNode()
    const model = scripted([toolStep([call('get_node_content', { doc_path: docPath, node_ids: [node.nodeId] })], 1)])
    const r = await retrieve(lib, 'q', { model, maxSteps: 2 })
    expect(r.stopReason).toBe('max_steps')
    expect(r.selectedBy).toBe('fallback')
    expect(r.evidence.map((e) => e.nodeId)).toEqual([node.nodeId])
  })

  it('failed reads are not used as fallback evidence', async () => {
    const model = scripted([toolStep([call('get_node_content', { doc_path: 'missing.md', node_ids: ['x'] })], 1)])
    const r = await retrieve(lib, 'q', { model, maxSteps: 2 })
    expect(r.stopReason).toBe('max_steps')
    expect(r.evidence).toEqual([])
  })

  it('flags a select_evidence input that fails validation', async () => {
    const model = scripted([toolStep([call('select_evidence', { items: [{ doc_path: 1 }] })])])
    const r = await retrieve(lib, 'q', { model, maxSteps: 2 })
    expect(r.invalidSelection).toBe(true)
    expect(r.evidence).toEqual([])
    expect(r.stopReason).toBe('max_steps')
  })

  it('stops with max_steps', async () => {
    const model = scripted([toolStep([call('search_documents', { query: 'npm' })], 1)])
    const r = await retrieve(lib, 'q', { model, maxSteps: 3 })
    expect(r.stopReason).toBe('max_steps')
    expect(model.doGenerateCalls).toHaveLength(3)
    expect(r.evidence).toEqual([])
  })

  it('invalid evidence refs are dropped', async () => {
    const { docPath, node } = firstNode()
    const model = scripted([
      toolStep([
        call('select_evidence', {
          items: [
            { doc_path: docPath, node_id: 'nope' },
            { doc_path: 'missing.md', node_id: node.nodeId },
            { doc_path: docPath, node_id: node.nodeId },
          ],
        }),
      ]),
    ])
    const r = await retrieve(lib, 'q', { model })
    expect(r.evidence).toHaveLength(1)
    expect(r.dropped).toBe(2)
  })

  it('adds a folder scoping instruction to the system prompt', async () => {
    const model = scripted([toolStep([call('select_evidence', { items: [] })])])
    await retrieve(lib, 'q', { model, folder: 'docs/api' })
    expect(JSON.stringify(model.doGenerateCalls[0]!.prompt)).toContain('docs/api')
  })
})
