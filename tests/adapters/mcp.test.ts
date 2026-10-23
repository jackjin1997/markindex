import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createMcpServer } from '../../src/adapters/mcp.js'
import { openLibrary, type Library } from '../../src/library.js'
import { AGENT_INSTRUCTIONS } from '../../src/tools/contract.js'
import { indexedFixtureRoot } from './helpers.js'

let lib: Library
let cleanup: () => void
let client: Client
beforeEach(async () => {
  const f = await indexedFixtureRoot()
  cleanup = f.cleanup
  lib = openLibrary({ root: f.root })
  const server = createMcpServer(lib)
  const [a, b] = InMemoryTransport.createLinkedPair()
  client = new Client({ name: 'test', version: '0' })
  await Promise.all([server.connect(a), client.connect(b)])
})
afterEach(async () => {
  await client.close()
  lib.close()
  cleanup()
})

describe('createMcpServer', () => {
  it('mcp lists five tools and calls one', async () => {
    const { tools } = await client.listTools()
    expect(tools.map((t) => t.name).sort()).toEqual([
      'browse_documents',
      'get_document',
      'get_document_structure',
      'get_node_content',
      'search_documents',
    ])
    for (const t of tools) expect(t.annotations?.readOnlyHint).toBe(true)
    expect(client.getInstructions()).toBe(AGENT_INSTRUCTIONS)

    const res = await client.callTool({ name: 'browse_documents', arguments: {} })
    expect(res.isError).toBe(false)
    const text = (res.content as { type: string; text: string }[])[0]!.text
    expect(JSON.parse(text).success).toBe(true)
    expect(text).toContain('en-guide.md')
  })

  it('does not list defaulted fields as required in the input schema', async () => {
    const { tools } = await client.listTools()
    const by = Object.fromEntries(tools.map((t) => [t.name, t.inputSchema as { required?: string[]; properties: Record<string, unknown> }]))
    expect(by.browse_documents!.required ?? []).toEqual([])
    expect(by.get_document_structure!.required).toEqual(['doc_path'])
    expect(by.get_node_content!.required!.sort()).toEqual(['doc_path', 'node_ids'])
    expect(by.search_documents!.required).toEqual(['query'])
    expect(Object.keys(by.search_documents!.properties).sort()).toEqual(['doc_path', 'folder', 'limit', 'query'])
  })

  it('reports tool failures as isError with the envelope text', async () => {
    const res = await client.callTool({ name: 'get_document', arguments: { doc_path: 'nope.md' } })
    expect(res.isError).toBe(true)
    expect(JSON.parse((res.content as { text: string }[])[0]!.text).success).toBe(false)
  })
})
