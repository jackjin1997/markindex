import { execFile } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { indexedFixtureRoot } from './adapters/helpers.js'

const exec = promisify(execFile)
const repo = join(import.meta.dirname, '..')
const cli = ['--import', 'tsx', join(repo, 'src/cli.ts')]
const KEYS = ['TYPESAFE_API_KEY', 'OPENROUTER_API_KEY', 'JEV_BASE_URL', 'JEV_API_KEY', 'JEV_MODEL']
/** The environment of this process without any reranker key, so the tests never reach a real endpoint. */
const cleanEnv = (extra: Record<string, string> = {}) =>
  ({ ...Object.fromEntries(Object.entries(process.env).filter(([k, v]) => v !== undefined && !KEYS.includes(k))), ...extra }) as Record<string, string>
const run = (args: string[], env: Record<string, string>) =>
  exec(process.execPath, [...cli, ...args], { cwd: repo, env }).then(
    (r) => ({ code: 0, stderr: r.stderr }),
    (e: { code: number; stderr: string }) => ({ code: e.code, stderr: e.stderr }),
  )

let fixture: Awaited<ReturnType<typeof indexedFixtureRoot>>
let endpoint: Server
const requests: { auth: string | undefined; question: string }[] = []
beforeAll(async () => {
  fixture = await indexedFixtureRoot()
  // A stand-in for the decision model: every passage gets the same score.
  endpoint = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      requests.push({ auth: req.headers.authorization, question: (JSON.parse(body) as { state: { question: string } }).state.question })
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ model: 'jev-fake', answers: { relevant: { type: 'noul', noul: 0.5 } } }))
    })
  })
  await new Promise<void>((r) => endpoint.listen(0, '127.0.0.1', r))
})
afterAll(async () => {
  fixture.cleanup()
  await new Promise((r) => endpoint.close(r))
})

describe('markindex mcp --rerank', () => {
  it('refuses to start without a key and names the variables to set', async () => {
    const r = await run(['mcp', fixture.root, '--rerank', 'jev'], cleanEnv())
    expect(r.code).toBe(1)
    expect(r.stderr).toContain('TYPESAFE_API_KEY')
  })

  it('refuses an unknown reranker', async () => {
    const r = await run(['mcp', fixture.root, '--rerank', 'nope'], cleanEnv())
    expect(r.code).toBe(1)
    expect(r.stderr).toMatch(/--rerank.*jev/)
  })

  it('reranks search results through the configured endpoint and says where text is sent', async () => {
    const url = `http://127.0.0.1:${(endpoint.address() as AddressInfo).port}/v1/systemone`
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [...cli, 'mcp', fixture.root, '--rerank', 'jev'],
      cwd: repo,
      env: cleanEnv({ JEV_BASE_URL: url, JEV_API_KEY: 'test-key' }),
      stderr: 'pipe',
    })
    let stderr = ''
    transport.stderr!.on('data', (c) => (stderr += String(c)))
    const client = new Client({ name: 'smoke', version: '0' })
    await client.connect(transport)
    try {
      const res = await client.callTool({ name: 'search_documents', arguments: { query: 'npm install', intent: 'How do I install the package?' } })
      expect(res.isError).toBe(false)
      const env = JSON.parse((res.content as { text: string }[])[0]!.text)
      expect(env.data.rerank).toMatchObject({ by: 'jev:custom:jev-latest', scored: env.data.rerank.candidates })
      expect(env.data.results[0].relevance).toBe(0.5)
      expect(requests.length).toBe(env.data.rerank.candidates)
      expect(requests.every((q) => q.auth === 'Bearer test-key' && q.question === 'How do I install the package?')).toBe(true)
      expect(stderr).toContain(url)
      expect(stderr).not.toContain('test-key')
    } finally {
      await client.close()
    }
  }, 30_000)
})
