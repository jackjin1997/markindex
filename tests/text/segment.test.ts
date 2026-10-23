import { expect, test } from 'vitest'
import { segmentForIndex, segmentQuery } from '../../src/text/segment.js'

test('segments mixed zh/en', () =>
  expect(segmentForIndex('劳动合同的解除条件 React Server')).toBe('劳动 合同 的 解除 条件 react server'))
test('segments symbol-bearing terms consistently', () => {
  for (const t of ['v2.1', 'C++', 'ISO-27001', 'GDPR第17条'])
    expect(segmentForIndex(`见 ${t} 规定`)).toContain(segmentForIndex(t))
})
test('query is escaped for FTS5', () =>
  expect(segmentQuery('"合同" OR x')).toBe('"合同" OR "or" OR "x"'))
test('empty / punctuation-only query', () => expect(segmentQuery('，。！')).toBe(''))
