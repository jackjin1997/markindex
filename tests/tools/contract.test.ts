import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { AGENT_INSTRUCTIONS, TOOL_CONTRACT, type ToolName } from '../../src/tools/contract.js'

describe('TOOL_CONTRACT', () => {
  it('contract snapshot', () => {
    const names = Object.keys(TOOL_CONTRACT) as ToolName[]
    expect(names).toEqual([
      'browse_documents',
      'get_document',
      'get_document_structure',
      'get_node_content',
      'search_documents',
    ])
    const contract = Object.fromEntries(
      names.map((n) => [
        n,
        { description: TOOL_CONTRACT[n].description, input: z.toJSONSchema(TOOL_CONTRACT[n].input, { io: 'input' }) },
      ]),
    )
    expect(contract).toMatchSnapshot()
  })

  it('instructions snapshot', () => {
    expect(AGENT_INSTRUCTIONS).toMatchSnapshot()
  })

  it('descriptions carry the navigation rules', () => {
    expect(TOOL_CONTRACT.browse_documents.description).toMatch(/search_documents\(\)/)
    expect(TOOL_CONTRACT.get_document_structure.description).toMatch(/REQUIRED for documents over 15000 tokens/)
    expect(TOOL_CONTRACT.get_node_content.description).toMatch(/verbatim/)
    expect(TOOL_CONTRACT.get_node_content.description).toMatch(/subsections/)
    expect(AGENT_INSTRUCTIONS).toMatch(/\[doc_path, L<start>-<end>\]/)
  })
})
