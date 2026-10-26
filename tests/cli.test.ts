import { execFile } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { resolveSummaryModel, ProviderError } from '../src/llm/provider.js'
import { defaultDbFile } from '../src/library.js'
import { openStore } from '../src/store/db.js'
import { indexedFixtureRoot } from './adapters/helpers.js'

const exec = promisify(execFile)
const repo = join(import.meta.dirname, '..')
const tsx = (...args: string[]) =>
  exec(process.execPath, ['--import', 'tsx', join(repo, 'src/cli.ts'), ...args], { cwd: repo }).then(
    (r) => ({ code: 0, stdout: r.stdout, stderr: r.stderr }),
    (e: { code: number; stdout: string; stderr: string }) => ({ code: e.code, stdout: e.stdout, stderr: e.stderr }),
  )

let fixture: Awaited<ReturnType<typeof indexedFixtureRoot>>
let empty: string
beforeAll(async () => {
  fixture = await indexedFixtureRoot()
  empty = mkdtempSync(join(tmpdir(), 'markindex-empty-'))
})
afterAll(() => {
  fixture.cleanup()
  rmSync(empty, { recursive: true, force: true })
})

describe('cli', () => {
  it('cli index then search', async () => {
    const root = mkdtempSync(join(tmpdir(), 'markindex-cli-'))
    try {
      const { cpSync } = await import('node:fs')
      cpSync(join(repo, 'tests/fixtures/md'), root, { recursive: true })
      const idx = await tsx('index', root)
      expect(idx.code).toBe(0)
      expect(idx.stdout).toMatch(/added \d+/)
      const res = await tsx('search', root, 'npm install')
      expect(res.code).toBe(0)
      expect(res.stdout).toContain('en-guide.md')
      const js = await tsx('search', root, 'npm install', '--json')
      expect(JSON.parse(js.stdout)[0].docPath).toBe('en-guide.md')
      const st = openStore(defaultDbFile(root))
      st.setMeta('index_format', 'stale')
      st.close()
      const re = await tsx('index', root)
      expect(re.stdout).toMatch(/^full rebuild: index format changed/m)
      expect(re.stdout).toMatch(/unchanged 0/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('index warns about page-break setext headings and --no-setext turns them off', async () => {
    const root = mkdtempSync(join(tmpdir(), 'markindex-cli-'))
    try {
      writeFileSync(join(root, 'pdf.md'), 'Page one line one\npage one line two\n---\nPage two\n')
      const on = await tsx('index', root)
      expect(on.code).toBe(0)
      expect(on.stdout).toMatch(/warning pdf\.md: 1 setext h2 heading\(s\) look like page breaks/)
      expect(on.stdout).toContain('--no-setext')
      const off = await tsx('index', root, '--no-setext', '--json')
      const report = JSON.parse(off.stdout)
      expect(report.rebuilt.reason).toMatch(/index format changed/)
      expect(report.warnings).toEqual([])
      const st = openStore(defaultDbFile(root))
      expect(JSON.parse(st.getMeta('index_format')!).setext).toBe(false)
      expect(st.getTree('pdf.md')!.map((n) => n.title)).toEqual(['pdf'])
      st.close()
      const plain = JSON.parse((await tsx('index', root, '--json')).stdout)
      expect(plain.rebuilt).toBeUndefined()
      expect(plain.unchanged).toEqual(['pdf.md'])
      const back = JSON.parse((await tsx('index', root, '--setext', '--json')).stdout)
      expect(back.rebuilt.reason).toMatch(/index format changed/)
      expect(back.warnings).toHaveLength(1)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('index --ignore is repeatable and drops newly ignored files', async () => {
    const root = mkdtempSync(join(tmpdir(), 'markindex-cli-'))
    try {
      const { mkdirSync } = await import('node:fs')
      mkdirSync(join(root, 'drafts'))
      mkdirSync(join(root, 'tmp'))
      writeFileSync(join(root, 'a.md'), '# A\n')
      writeFileSync(join(root, 'drafts', 'b.md'), '# B\n')
      writeFileSync(join(root, 'tmp', 'c.md'), '# C\n')
      expect(JSON.parse((await tsx('index', root, '--json')).stdout).added).toEqual(['a.md', 'drafts/b.md', 'tmp/c.md'])
      const r = await tsx('index', root, '--ignore', 'drafts/', '--ignore', 'tmp/', '--json')
      expect(r.code).toBe(0)
      expect(JSON.parse(r.stdout).removed).toEqual(['drafts/b.md', 'tmp/c.md'])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('tree prints the outline, --json prunes by depth', async () => {
    const t = await tsx('tree', fixture.root, 'en-guide.md', '--depth', '1')
    expect(t.code).toBe(0)
    expect(t.stdout).toContain('Acme SDK')
    expect(t.stdout).not.toContain('Install')
    const j = await tsx('tree', fixture.root, 'en-guide.md', '--json', '--depth', '1')
    expect(JSON.parse(j.stdout)[0].children ?? []).toEqual([])
    const bad = await tsx('tree', fixture.root, 'nope.md')
    expect(bad.code).toBe(1)
    expect(bad.stderr).toContain('not found')
  })

  it('--estimate prints the cost estimate without calling a model', async () => {
    const r = await tsx('index', fixture.root, '--summary-model', 'anthropic:x', '--estimate')
    expect(r.code).toBe(0)
    expect(r.stdout).toMatch(/Summary estimate: \d+ nodes.*LLM calls/)
    const j = await tsx('index', fixture.root, '--estimate', '--json')
    expect(JSON.parse(j.stdout).estimate).toHaveProperty('llmCalls')
  })

  it('missing provider package exits non-zero with an install hint', async () => {
    const r = await tsx('index', fixture.root, '--summary-model', 'nosuchprovider:m')
    expect(r.code).toBe(1)
    expect(r.stderr).toContain('npm install @ai-sdk/nosuchprovider')
  })

  it('mcp without an index exits with guidance', async () => {
    const r = await tsx('mcp', empty)
    expect(r.code).toBe(1)
    expect(r.stderr).toContain('markindex index')
  })

  it('eval bm25 writes a report and prints the summary', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'markindex-evalq-'))
    try {
      const qfile = join(dir, 'q.jsonl')
      const out = join(dir, 'report.json')
      writeFileSync(
        qfile,
        [
          { id: 'a', question: 'npm install acme', lang: 'en', gold: [{ doc_path: 'en-guide.md', start_line: 12, end_line: 16 }] },
          { id: 'b', question: '系统要求', lang: 'zh', gold: [{ doc_path: 'zh-manual.md' }] },
        ]
          .map((x) => JSON.stringify(x))
          .join('\n'),
      )
      const r = await tsx('eval', fixture.root, '--questions', qfile, '--mode', 'bm25', '--out', out)
      expect(r.code).toBe(0)
      expect(r.stdout).toMatch(/overall\s+2\s+2\s+100\.0%/)
      expect(r.stdout).toMatch(/zh\s+1/)
      const report = JSON.parse(readFileSync(out, 'utf8'))
      expect(report.mode).toBe('bm25')
      expect(report.summary.overall.hits).toBe(2)
      expect(report.results).toHaveLength(2)
      expect(r.stdout).toMatch(/ev lines\s+med\s+prec/)
      expect(report.results[0].evidenceLines).toBeGreaterThan(0)
      const strict = await tsx('eval', fixture.root, '--questions', qfile, '--mode', 'bm25', '--max-evidence-lines', '1', '--json')
      expect(strict.code).toBe(0)
      const sr = JSON.parse(strict.stdout)
      expect(sr.options.maxEvidenceLines).toBe(1)
      expect(sr.summary.overall.hits).toBeLessThan(2)
      expect((await tsx('eval', fixture.root, '--questions', qfile, '--max-evidence-lines', '0')).code).toBe(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('eval rejects a malformed question file with line numbers', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'markindex-evalq-'))
    try {
      const qfile = join(dir, 'q.jsonl')
      writeFileSync(qfile, `${JSON.stringify({ id: 'a', question: 'x', lang: 'en', gold: [{ doc_path: 'nope.md' }] })}\n{bad\n`)
      const r = await tsx('eval', fixture.root, '--questions', qfile)
      expect(r.code).toBe(1)
      expect(r.stderr).toMatch(/q\.jsonl:2: invalid JSON/)
      writeFileSync(qfile, JSON.stringify({ id: 'a', question: 'x', lang: 'en', gold: [{ doc_path: 'nope.md' }] }))
      const g = await tsx('eval', fixture.root, '--questions', qfile)
      expect(g.code).toBe(1)
      expect(g.stderr).toMatch(/q\.jsonl:1: .*nope\.md.*not in the index/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('eval agent mode needs --model; tools/retrieve are aliases of agent', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'markindex-evalq-'))
    try {
      const qfile = join(dir, 'q.jsonl')
      writeFileSync(qfile, JSON.stringify({ id: 'a', question: 'x', lang: 'en', gold: [{ doc_path: 'en-guide.md' }] }))
      for (const mode of ['agent', 'tools', 'retrieve']) {
        const r = await tsx('eval', fixture.root, '--questions', qfile, '--mode', mode)
        expect(r.code).toBe(1)
        expect(r.stderr).toContain('--model')
      }
      const bad = await tsx('eval', fixture.root, '--questions', qfile, '--mode', 'vector')
      expect(bad.code).toBe(1)
      expect(bad.stderr).toMatch(/--mode/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('resolveSummaryModel', () => {
  it('imports @ai-sdk/<provider> and calls its factory', async () => {
    let asked = ''
    const model = await resolveSummaryModel('anthropic:claude-sonnet-5-5', async (s) => {
      asked = s
      return { anthropic: (id: string) => ({ id }) }
    })
    expect(asked).toBe('@ai-sdk/anthropic')
    expect(model).toEqual({ id: 'claude-sonnet-5-5' })
  })
  it('rejects malformed specs and unsafe provider names', async () => {
    for (const bad of ['nomodel', ':m', 'a:', '../x:m', 'Foo:m']) {
      await expect(resolveSummaryModel(bad)).rejects.toBeInstanceOf(ProviderError)
    }
  })
})

describe('stdio smoke (built dist)', () => {
  beforeAll(async () => {
    await exec('npm', ['run', 'build'], { cwd: repo })
  }, 120_000)

  it('serves five tools over stdio and answers browse_documents', async () => {
    const transport = new StdioClientTransport({ command: process.execPath, args: [join(repo, 'dist/cli.js'), 'mcp', fixture.root], stderr: 'pipe' })
    const client = new Client({ name: 'smoke', version: '0' })
    await client.connect(transport)
    try {
      expect((await client.listTools()).tools).toHaveLength(5)
      const res = await client.callTool({ name: 'browse_documents', arguments: {} })
      expect(res.isError).toBe(false)
      expect((res.content as { text: string }[])[0]!.text).toContain('en-guide.md')
    } finally {
      await client.close()
    }
  }, 30_000)

  it('mcp --reindex-on-start honours --no-setext and --ignore', async () => {
    const f = await indexedFixtureRoot()
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [join(repo, 'dist/cli.js'), 'mcp', f.root, '--reindex-on-start', '--no-setext', '--ignore', 'zh-*.md'],
      stderr: 'pipe',
    })
    const client = new Client({ name: 'smoke', version: '0' })
    await client.connect(transport)
    try {
      await client.listTools()
      const st = openStore(defaultDbFile(f.root), { readonly: true })
      expect(JSON.parse(st.getMeta('index_format')!).setext).toBe(false)
      expect(st.allDocPaths()).toContain('en-guide.md')
      expect(st.allDocPaths().filter((p) => p.startsWith('zh-'))).toEqual([])
      st.close()
    } finally {
      await client.close()
      f.cleanup()
    }
  }, 30_000)

  it('--reindex-on-start builds a missing index before serving', async () => {
    const f = await indexedFixtureRoot()
    rmSync(join(f.root, '.markindex'), { recursive: true, force: true })
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [join(repo, 'dist/cli.js'), 'mcp', f.root, '--reindex-on-start'],
      stderr: 'pipe',
    })
    const client = new Client({ name: 'smoke', version: '0' })
    await client.connect(transport)
    try {
      const res = await client.callTool({ name: 'browse_documents', arguments: {} })
      expect((res.content as { text: string }[])[0]!.text).toContain('en-guide.md')
    } finally {
      await client.close()
      f.cleanup()
    }
  }, 30_000)
})
