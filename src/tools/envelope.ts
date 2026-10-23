export type ErrorCode = 'NOT_FOUND' | 'INVALID_INPUT' | 'INTERNAL_ERROR'

/** Guidance for the agent's next call (PageIndex `next_steps`). */
export interface NextSteps {
  summary: string
  options: string[]
}

/** Every tool answers with one of these, serialized as a JSON string (spec §8). */
export type Envelope =
  | { success: true; data: unknown; next_steps?: NextSteps }
  | { success: false; error: string; code: ErrorCode; details?: unknown; next_steps: NextSteps }

export function success(data: unknown, nextSteps?: NextSteps): Envelope {
  return nextSteps === undefined ? { success: true, data } : { success: true, data, next_steps: nextSteps }
}

export function failure(code: ErrorCode, error: string, nextSteps: NextSteps, details?: unknown): Envelope {
  return details === undefined
    ? { success: false, error, code, next_steps: nextSteps }
    : { success: false, error, code, details, next_steps: nextSteps }
}

/** Length of the JSON serialization (UTF-16 code units, i.e. JS string length). */
export const jsonSize = (value: unknown): number => JSON.stringify(value).length

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * Splits `items` into parts whose JSON serialization (`JSON.stringify(part)`, a JSON array) is at most `budget`
 * characters, keeping order. Port of PageIndex `_split_structure` / `_split_oversized_node`: an item too large
 * to fit alone that is an object with a non-empty `nodes` array is split by keeping its shell (every other key)
 * and splitting its `nodes` recursively, so the shell repeats in each resulting part (one per part). An item
 * that is still too large (no `nodes` to split, or a shell that alone exceeds the budget) is emitted in a part
 * of its own. Always returns at least one part (`[[]]` for no items).
 */
export function splitByBudget<T>(items: T[], budget: number): T[][] {
  if (jsonSize(items) <= budget) return [items]
  const parts: T[][] = []
  let group: T[] = []
  let groupSize = 2 // "[]"
  const flush = () => {
    if (group.length) parts.push(group)
    group = []
    groupSize = 2
  }
  for (const item of items) {
    const size = jsonSize(item)
    if (2 + size > budget) {
      flush()
      for (const piece of splitOversized(item, budget)) parts.push([piece])
      continue
    }
    const added = size + (group.length ? 1 : 0)
    if (groupSize + added > budget) flush()
    groupSize += size + (group.length ? 1 : 0)
    group.push(item)
  }
  flush()
  return parts.length ? parts : [[]]
}

/** Pieces of an item that does not fit alone; each `[piece]` fits `budget` whenever splitting is possible. */
function splitOversized<T>(item: T, budget: number): T[] {
  if (!isPlainObject(item)) return [item]
  const children = item['nodes']
  if (!Array.isArray(children) || children.length === 0) return [item]
  const withNodes = (nodes: unknown[]) =>
    Object.fromEntries(Object.entries(item).map(([k, v]) => (k === 'nodes' ? [k, nodes] : [k, v]))) as T
  // size([ {...shell, nodes: chunk} ]) = 2 + (size(shell with nodes: []) - 2) + size(chunk)
  const childBudget = budget - jsonSize(withNodes([]))
  if (childBudget < 2) return [item]
  return splitByBudget(children as unknown[], childBudget).map(withNodes)
}
