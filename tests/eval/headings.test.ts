import { describe, expect, it } from 'vitest'
import { countAtxHeadings, reconstructSecHeadings, reconstructZhHeadings } from '../../eval/lib/headings.js'

describe('corpus heading reconstruction', () => {
  it('SEC: PART / Item lines become h1 / h2, table rows and long lines are untouched, line count kept', () => {
    const src = ['| Item 1. | Business | 3 |', 'PART I', 'Item 1.    Business', 'text', '**Item 1A. Risk Factors**', `Item 7. ${'x'.repeat(200)}`].join('\n')
    const out = reconstructSecHeadings(src).split('\n')
    expect(out).toEqual(['| Item 1. | Business | 3 |', '# PART I', '## Item 1. Business', 'text', '## Item 1A. Risk Factors', `Item 7. ${'x'.repeat(200)}`])
    expect(countAtxHeadings(out.join('\n'))).toBe(3)
  })

  it('SEC: promotes single-cell table rows and skips repeated page headers', () => {
    const src = ['Part I', '| ITEM 1A. RISK FACTORS | | |  |', 'body', 'Part I', 'Item 1A. Risk Factors (continued)', 'PART II', 'Item 5. Market'].join('\n')
    expect(reconstructSecHeadings(src).split('\n')).toEqual([
      '# Part I',
      '## ITEM 1A. RISK FACTORS',
      'body',
      'Part I',
      'Item 1A. Risk Factors (continued)',
      '# PART II',
      '## Item 5. Market',
    ])
  })

  it('zh: 编/章/节/一、/（一） become headings, article lines do not', () => {
    const src = ['第一编　总则', '第一章 基本规定', '第一条　为了保护民事主体的合法权益，制定本法。', '第二节 监护', '一、适用范围', '（一）发热；', '（二）咳嗽', '**第三章 法人**'].join('\n')
    expect(reconstructZhHeadings(src).split('\n')).toEqual([
      '# 第一编　总则',
      '## 第一章 基本规定',
      '第一条　为了保护民事主体的合法权益，制定本法。',
      '### 第二节 监护',
      '### 一、适用范围',
      '（一）发热；',
      '#### （二）咳嗽',
      '## 第三章 法人',
    ])
  })
})
