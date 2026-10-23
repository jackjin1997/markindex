import { z } from 'zod'

/** One acceptable answer location. Lines are 1-based, inclusive, in the original file. */
export interface Gold {
  /** Library-relative document path (same form as `markindex search` prints). */
  doc_path: string
  /** Titles from the top-level section down to the answer node (used when no line range is given). */
  title_path?: string[]
  start_line?: number
  end_line?: number
}

export interface EvalQuestion {
  id: string
  question: string
  lang: 'zh' | 'en' | 'mixed'
  /** Any one gold location counts as a hit. */
  gold: Gold[]
  note?: string
  /** 1-based line of the question file this question came from. */
  line: number
}

export interface QuestionIssue {
  line: number
  message: string
}

export class QuestionFileError extends Error {
  constructor(
    readonly issues: QuestionIssue[],
    file = 'questions',
  ) {
    super(
      `${issues.length} problem(s) in the question file:\n` +
        issues.map((i) => `${file}:${i.line}: ${i.message}`).join('\n'),
    )
  }
}

const lineNo = z.int().min(1)

const goldSchema = z
  .strictObject({
    doc_path: z.string().min(1),
    title_path: z.array(z.string().min(1)).min(1).optional(),
    start_line: lineNo.optional(),
    end_line: lineNo.optional(),
  })
  .superRefine((g, ctx) => {
    if ((g.start_line === undefined) !== (g.end_line === undefined)) {
      ctx.addIssue({ code: 'custom', message: 'start_line and end_line must be given together' })
    } else if (g.start_line !== undefined && g.end_line !== undefined && g.end_line < g.start_line) {
      ctx.addIssue({ code: 'custom', path: ['end_line'], message: 'end_line must be >= start_line' })
    }
  })

const questionSchema = z.strictObject({
  id: z.string().trim().min(1),
  question: z.string().trim().min(1),
  lang: z.enum(['zh', 'en', 'mixed']),
  gold: z.array(goldSchema).min(1, 'gold needs at least one location'),
  note: z.string().optional(),
})

const describeIssue = (i: z.core.$ZodIssue): string => {
  const path = i.path.length ? `${i.path.join('.')}: ` : ''
  if (i.code === 'unrecognized_keys') return `${path}unknown field(s) ${i.keys.map((k) => `"${k}"`).join(', ')}`
  return `${path}${i.message}`
}

/**
 * Parses a JSONL question file (one JSON object per line; blank lines ignored; BOM / CRLF tolerated).
 * Collects every problem and throws one `QuestionFileError` listing them with line numbers.
 *
 * Line format: {"id", "question", "lang": "zh"|"en"|"mixed", "gold": [{"doc_path", "title_path"?, "start_line"?, "end_line"?}], "note"?}
 */
export function parseQuestions(text: string, file?: string): EvalQuestion[] {
  const issues: QuestionIssue[] = []
  const out: EvalQuestion[] = []
  const seen = new Map<string, number>()
  const lines = text.replace(/^﻿/, '').split(/\r?\n/)
  lines.forEach((raw, i) => {
    const line = i + 1
    if (raw.trim() === '') return
    let value: unknown
    try {
      value = JSON.parse(raw)
    } catch (e) {
      issues.push({ line, message: `invalid JSON (${(e as Error).message})` })
      return
    }
    const parsed = questionSchema.safeParse(value)
    if (!parsed.success) {
      issues.push({ line, message: parsed.error.issues.map(describeIssue).join('; ') })
      return
    }
    const prev = seen.get(parsed.data.id)
    if (prev !== undefined) {
      issues.push({ line, message: `duplicate id "${parsed.data.id}" (first used on line ${prev})` })
      return
    }
    seen.set(parsed.data.id, line)
    out.push({ ...parsed.data, line })
  })
  if (issues.length === 0 && out.length === 0) issues.push({ line: 1, message: 'no questions found (expected one JSON object per line)' })
  if (issues.length > 0) throw new QuestionFileError(issues, file)
  return out
}
