import { describe, expect, it } from 'vitest'
import { failure, splitByBudget, success } from '../../src/tools/envelope.js'

const size = (v: unknown) => JSON.stringify(v).length

interface N {
  id: string
  pad: string
  nodes?: N[]
}

/** Pre-order ids of a forest. */
function ids(nodes: N[]): string[] {
  return nodes.flatMap((n) => [n.id, ...ids(n.nodes ?? [])])
}

describe('envelopes', () => {
  it('builds success and failure envelopes', () => {
    expect(success({ a: 1 })).toEqual({ success: true, data: { a: 1 } })
    expect(success({ a: 1 }, { summary: 's', options: ['o'] })).toEqual({
      success: true,
      data: { a: 1 },
      next_steps: { summary: 's', options: ['o'] },
    })
    expect(failure('NOT_FOUND', 'gone', { summary: 's', options: [] }, { x: 1 })).toEqual({
      success: false,
      error: 'gone',
      code: 'NOT_FOUND',
      details: { x: 1 },
      next_steps: { summary: 's', options: [] },
    })
  })
})

describe('splitByBudget', () => {
  it('keeps everything in one part when it fits', () => {
    const items = [{ id: 'a' }, { id: 'b' }]
    expect(splitByBudget(items, 1000)).toEqual([items])
    expect(splitByBudget([], 10)).toEqual([[]])
  })

  it('groups flat items so every part fits the budget', () => {
    const items = Array.from({ length: 100 }, (_, i) => ({ id: `n${i}`, pad: 'x'.repeat(i % 7) }))
    const parts = splitByBudget(items, 120)
    expect(parts.length).toBeGreaterThan(1)
    for (const p of parts) expect(size(p)).toBeLessThanOrEqual(120)
    expect(parts.flat()).toEqual(items)
  })

  it('splits an oversized node by repeating its shell around chunks of its children', () => {
    const child = (i: number): N => ({ id: `c${i}`, pad: 'y'.repeat(20) })
    const big: N = { id: 'root', pad: 'r', nodes: Array.from({ length: 50 }, (_, i) => child(i)) }
    const items: N[] = [{ id: 'before', pad: '' }, big, { id: 'after', pad: '' }]
    const budget = 300
    const parts = splitByBudget(items, budget)
    for (const p of parts) expect(size(p)).toBeLessThanOrEqual(budget)
    const shells = parts.flat().filter((n) => n.id === 'root')
    expect(shells.length).toBeGreaterThan(1)
    for (const s of shells) expect(s.pad).toBe('r')
    // every node appears; only the split shell repeats
    expect(new Set(parts.flatMap((p) => ids(p)))).toEqual(new Set(ids(items)))
    expect(shells.flatMap((s) => ids(s.nodes!))).toEqual(ids(big.nodes!))
  })

  it('recurses into grandchildren when a child is itself oversized', () => {
    const leaf = (i: number): N => ({ id: `l${i}`, pad: 'z'.repeat(30) })
    const mid: N = { id: 'mid', pad: '', nodes: Array.from({ length: 40 }, (_, i) => leaf(i)) }
    const top: N = { id: 'top', pad: '', nodes: [mid] }
    const parts = splitByBudget([top], 250)
    expect(parts.length).toBeGreaterThan(1)
    for (const p of parts) expect(size(p)).toBeLessThanOrEqual(250)
    expect(new Set(parts.flatMap((p) => ids(p)))).toEqual(new Set(ids([top])))
  })

  it('emits an unsplittable oversized item alone', () => {
    const items = [{ id: 'a' }, { id: 'huge', pad: 'x'.repeat(500) }, { id: 'b' }]
    const parts = splitByBudget(items, 100)
    expect(parts).toEqual([[items[0]], [items[1]], [items[2]]])
  })
})
