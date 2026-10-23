import { generateText, stepCountIs } from 'ai'
import { MockLanguageModelV4 } from 'ai/test'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createAiSdkTools } from '../../src/adapters/ai-sdk.js'
import { openLibrary, type Library } from '../../src/library.js'
import { TOOL_CONTRACT } from '../../src/tools/contract.js'
import { indexedFixtureRoot } from './helpers.js'

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

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
}

describe('createAiSdkTools', () => {
  it('exposes the five contract tools with contract descriptions', () => {
    const tools = createAiSdkTools(lib)
    expect(Object.keys(tools).sort()).toEqual(Object.keys(TOOL_CONTRACT).sort())
    expect(tools.search_documents.description).toBe(TOOL_CONTRACT.search_documents.description)
  })

  it('ai-sdk tools execute via generateText', async () => {
    let call = 0
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        call++
        if (call === 1) {
          return {
            content: [
              { type: 'tool-call' as const, toolCallId: 'c1', toolName: 'search_documents', input: JSON.stringify({ query: 'npm install' }) },
            ],
            finishReason: { unified: 'tool-calls' as const, raw: undefined },
            usage,
            warnings: [],
          }
        }
        return { content: [{ type: 'text' as const, text: 'done' }], finishReason: { unified: 'stop' as const, raw: undefined }, usage, warnings: [] }
      },
    })
    const res = await generateText({ model, prompt: 'find it', tools: createAiSdkTools(lib), stopWhen: stepCountIs(3) })
    const out = res.steps[0]!.toolResults[0]!.output as string
    const env = JSON.parse(out)
    expect(env.success).toBe(true)
    expect(JSON.stringify(env.data)).toContain('en-guide.md')
    expect(res.text).toBe('done')
  })
})
