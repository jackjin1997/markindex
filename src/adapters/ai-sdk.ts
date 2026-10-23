import { tool, type Tool } from 'ai'
import type { Library } from '../library.js'
import { TOOL_CONTRACT, type ToolName } from '../tools/contract.js'

/**
 * The five agent tools as Vercel AI SDK tools, backed by `lib.callTool`. Each `execute` resolves to the JSON
 * envelope string (never rejects), so the model always sees a structured result.
 */
export function createAiSdkTools(lib: Library): Record<ToolName, Tool> {
  const entries = (Object.keys(TOOL_CONTRACT) as ToolName[]).map((name) => {
    const contract = TOOL_CONTRACT[name]
    return [
      name,
      tool({
        description: contract.description,
        inputSchema: contract.input,
        execute: (args: unknown) => lib.callTool(name, args),
      }),
    ] as const
  })
  return Object.fromEntries(entries) as Record<ToolName, Tool>
}
