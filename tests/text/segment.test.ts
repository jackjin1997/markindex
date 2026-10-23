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

test('symbol-bearing terms have exact tokens', () => {
  expect(segmentForIndex('见 C++ 规定')).toBe('见 c++ 规定')
  expect(segmentForIndex('ISO-27001')).toBe('iso-27001')
  expect(segmentForIndex('v2.1')).toBe('v2.1')
  expect(segmentForIndex('C#')).toBe('c#')
})
test('trailing punctuation is not glued to tokens', () => {
  expect(segmentForIndex('use React.')).toBe('use react')
  expect(segmentForIndex('v2.')).toBe('v2')
  expect(segmentForIndex('foo- bar')).toBe('foo bar')
})
test('drops emoji and full-width punctuation', () =>
  expect(segmentForIndex('合同，解除。😀')).toBe('合同 解除'))

test('segments a ~200k-word span without overflowing the stack', () => {
  const out = segmentForIndex('alpha '.repeat(200_000) + 'v2.1 ' + 'beta '.repeat(200_000))
  expect(out.split(' ')).toHaveLength(400_001)
})

test('segments a 250k-char alphanumeric run in linear time', () => {
  const start = performance.now()
  expect(segmentForIndex(`x ${'L'.repeat(250_000)} y`)).toBe(`x ${'l'.repeat(250_000)} y`)
  expect(performance.now() - start).toBeLessThan(2_000)
})

test('NFKC: full-width letters/digits match their ASCII forms in index and query', () => {
  expect(segmentForIndex('ＡＢＣ ＩＳＯ－２７００１')).toBe(segmentForIndex('ABC ISO-27001'))
  expect(segmentQuery('ＡＢＣ')).toBe(segmentQuery('abc'))
})
