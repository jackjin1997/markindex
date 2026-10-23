import { describe, expect, it } from 'vitest'
import { approxTokens } from '../../src/text/tokens.js'

describe('approxTokens', () => {
  it('counts CJK as 1 token each and others as chars/4 rounded up', () => {
    expect(approxTokens('')).toBe(0)
    expect(approxTokens('abcd')).toBe(1)
    expect(approxTokens('abcde')).toBe(2)
    expect(approxTokens('合同解除')).toBe(4)
    expect(approxTokens('合同 abcd')).toBe(2 + Math.ceil(5 / 4)) // 空格计入非 CJK
  })
})
