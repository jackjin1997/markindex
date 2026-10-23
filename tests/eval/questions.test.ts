import { describe, expect, it } from 'vitest'
import { parseQuestions, QuestionFileError } from '../../src/eval/questions.js'

const q = (o: Record<string, unknown>) => JSON.stringify(o)
const ok = {
  id: 'q1',
  question: 'How do I install it?',
  lang: 'en',
  gold: [{ doc_path: 'en-guide.md', start_line: 12, end_line: 20 }],
}

function issuesOf(text: string) {
  try {
    parseQuestions(text)
  } catch (e) {
    expect(e).toBeInstanceOf(QuestionFileError)
    return (e as QuestionFileError).issues
  }
  throw new Error('expected a QuestionFileError')
}

describe('parseQuestions', () => {
  it('parses valid JSONL, skipping blank lines and tolerating CRLF / BOM', () => {
    const text = `﻿${q(ok)}\r\n\r\n${q({ id: 'q2', question: '如何安装？', lang: 'zh', gold: [{ doc_path: 'zh-manual.md', title_path: ['产品手册', '安装'] }] })}\n`
    const qs = parseQuestions(text)
    expect(qs).toHaveLength(2)
    expect(qs[0]).toMatchObject({ id: 'q1', lang: 'en', line: 1, gold: [{ doc_path: 'en-guide.md', start_line: 12, end_line: 20 }] })
    expect(qs[1]).toMatchObject({ id: 'q2', line: 3, gold: [{ title_path: ['产品手册', '安装'] }] })
  })

  it('accepts an optional note and a doc-level gold (doc_path only)', () => {
    const [x] = parseQuestions(q({ ...ok, note: 'from section 3', gold: [{ doc_path: 'a.md' }] }))
    expect(x!.note).toBe('from section 3')
    expect(x!.gold).toEqual([{ doc_path: 'a.md' }])
  })

  it('reports invalid JSON with its line number', () => {
    const issues = issuesOf(`${q(ok)}\n{"id": "q2", oops}\n`)
    expect(issues).toHaveLength(1)
    expect(issues[0]!.line).toBe(2)
    expect(issues[0]!.message).toMatch(/invalid JSON/)
  })

  it('reports every schema problem with line number and field', () => {
    const issues = issuesOf(
      [
        q({ ...ok, lang: 'fr' }),
        q({ ...ok, id: 'q3', gold: [] }),
        q({ ...ok, id: 'q4', gold: [{ doc_path: 'a.md', startLine: 3 }] }),
        q({ ...ok, id: 'q5', question: '  ' }),
      ].join('\n'),
    )
    expect(issues.map((i) => i.line)).toEqual([1, 2, 3, 4])
    expect(issues[0]!.message).toMatch(/lang/)
    expect(issues[1]!.message).toMatch(/gold/)
    expect(issues[2]!.message).toMatch(/startLine/)
    expect(issues[3]!.message).toMatch(/question/)
  })

  it('requires start_line and end_line together, 1-based and ordered', () => {
    const issues = issuesOf(
      [
        q({ ...ok, gold: [{ doc_path: 'a.md', start_line: 3 }] }),
        q({ ...ok, id: 'b', gold: [{ doc_path: 'a.md', start_line: 9, end_line: 3 }] }),
        q({ ...ok, id: 'c', gold: [{ doc_path: 'a.md', start_line: 0, end_line: 3 }] }),
      ].join('\n'),
    )
    expect(issues.map((i) => i.line)).toEqual([1, 2, 3])
    expect(issues[0]!.message).toMatch(/together/)
    expect(issues[1]!.message).toMatch(/end_line/)
  })

  it('rejects duplicate ids, pointing at both lines', () => {
    const issues = issuesOf(`${q(ok)}\n${q(ok)}`)
    expect(issues).toHaveLength(1)
    expect(issues[0]).toMatchObject({ line: 2 })
    expect(issues[0]!.message).toMatch(/duplicate id "q1".*line 1/)
  })

  it('rejects an empty file', () => {
    expect(issuesOf('\n\n')[0]!.message).toMatch(/no questions/)
  })

  it('formats all issues into the error message with the file name', () => {
    try {
      parseQuestions('nope', 'q.jsonl')
    } catch (e) {
      expect((e as Error).message).toMatch(/^q\.jsonl:1: invalid JSON/m)
      return
    }
    throw new Error('expected throw')
  })
})
