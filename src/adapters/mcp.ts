import { readFileSync } from 'node:fs'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Library } from '../library.js'
import { AGENT_INSTRUCTIONS, TOOL_CONTRACT, type ToolName } from '../tools/contract.js'

/** Package version, read from package.json (same relative location from src/ and dist/). */
export function packageVersion(): string {
  const url = new URL('../../package.json', import.meta.url)
  return (JSON.parse(readFileSync(url, 'utf8')) as { version: string }).version
}

/** MCP server exposing the five agent tools over `lib`. Connect it to a transport (stdio for `markindex mcp`). */
export function createMcpServer(lib: Library): McpServer {
  const server = new McpServer({ name: 'markindex', version: packageVersion() }, { instructions: AGENT_INSTRUCTIONS })
  for (const name of Object.keys(TOOL_CONTRACT) as ToolName[]) {
    const contract = TOOL_CONTRACT[name]
    server.registerTool(
      name,
      { description: contract.description, inputSchema: contract.input.shape, annotations: { readOnlyHint: true } },
      async (args: unknown) => {
        const text = await lib.callTool(name, args)
        return { content: [{ type: 'text' as const, text }], isError: !isSuccess(text) }
      },
    )
  }
  return server
}

function isSuccess(envelope: string): boolean {
  try {
    return (JSON.parse(envelope) as { success?: unknown }).success === true
  } catch {
    return false
  }
}
