/**
 * Scale benchmark (spec §10.3) on the downloaded corpus, summaries OFF.
 *
 *   npx tsx eval/bench.ts [--root eval/corpus] [--out eval/results/bench.json] [--calls 60] [--seed 20261023]
 *
 * Phases (index and update run in child processes so each reports its own peak RSS):
 *   1. full index from an empty database
 *   2. single-document incremental update (one file gets a line appended, then the original is restored)
 *   3. p50 / p95 latency of each of the 5 tools with arguments drawn from the corpus (seeded)
 *   4. database size and tree-structure statistics used for calibration
 */
import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { DEFAULT_STRUCTURE_DEPTH, MAX_NODE_TOKENS, STRUCTURE_FIRST_TOKEN_THRESHOLD } from '../src/config.js'
import { indexLibrary } from '../src/library/indexer.js'
import { defaultDbFile, openLibrary } from '../src/library.js'
import { openStore } from '../src/store/db.js'
import type { ToolName } from '../src/tools/contract.js'
import { walk } from '../src/tree/build.js'
import { pick, rng } from './lib/rng.js'

const args = process.argv.slice(2)
const arg = (name: string, def: string) => {
  const i = args.indexOf(name)
  return i === -1 ? def : args[i + 1]!
}
const ROOT = resolve(arg('--root', join(import.meta.dirname, 'corpus')))
const OUT = resolve(arg('--out', join(import.meta.dirname, 'results', 'bench.json')))
const CALLS = Number(arg('--calls', '60'))
const SEED = Number(arg('--seed', '20261023'))
const DB = defaultDbFile(ROOT)
const log = (s: string) => process.stderr.write(`${s}\n`)
const mb = (bytes: number) => Math.round((bytes / 2 ** 20) * 10) / 10

/** Child-process phases print one JSON line on stdout. */
async function childPhase(phase: string) {
  const store = openStore(DB)
  try {
    if (phase === 'index') {
      const t0 = performance.now()
      const r = await indexLibrary({ root: ROOT, store })
      const ms = performance.now() - t0
      return { ms: Math.round(ms), added: r.added.length, skipped: r.skipped, peakRssMB: mb(process.resourceUsage().maxRSS * 1024) }
    }
    if (phase === 'update') {
      const target = arg('--target', '')
      const t0 = performance.now()
      const r = await indexLibrary({ root: ROOT, store })
      const ms = performance.now() - t0
      return { ms: Math.round(ms), target, updated: r.updated, unchanged: r.unchanged.length, peakRssMB: mb(process.resourceUsage().maxRSS * 1024) }
    }
    if (phase === 'noop') {
      const t0 = performance.now()
      const r = await indexLibrary({ root: ROOT, store })
      return { ms: Math.round(performance.now() - t0), unchanged: r.unchanged.length }
    }
  } finally {
    store.close()
  }
  throw new Error(`unknown phase ${phase}`)
}

const runChild = (phase: string, extra: string[] = []) => {
  const out = execFileSync(process.execPath, ['--import', 'tsx', import.meta.filename, '--child', phase, '--root', ROOT, ...extra], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
    maxBuffer: 64 * 2 ** 20,
  })
  return JSON.parse(out.trim().split('\n').at(-1)!)
}

const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b)
  return Math.round(s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]! * 100) / 100
}

const QUERIES = [
  'goodwill impairment', 'credit risk', 'liquidity coverage ratio', 'share repurchase program', 'cybersecurity incident',
  'interest rate risk', 'revenue recognition', 'Basel III', 'LIBOR transition', 'supply chain',
  'dosage in children', 'contraindications', 'antiretroviral therapy', 'tuberculosis screening', 'vaccination schedule',
  'hand hygiene', 'malaria', 'sepsis', 'HIV', 'COVID-19',
  '股东会 决议', '违约责任', '个人信息 处理', '劳动合同 解除', '药品 上市许可',
  '传染病 报告', '诊断标准', '抗病毒治疗', '证券 发行', '保险 合同',
]

function toolCalls(lib: ReturnType<typeof openLibrary>) {
  const r = rng(SEED)
  const docs = lib.store.allDocPaths()
  const folders = [...new Set(['', ...docs.flatMap((d) => d.split('/').slice(0, -1).map((_, i, a) => a.slice(0, i + 1).join('/')))])]
  const nodes = new Map<string, string[]>()
  const nodeIds = (d: string) => {
    let ids = nodes.get(d)
    if (!ids) {
      ids = [...walk(lib.store.getTree(d) ?? [])].map((e) => e.node.nodeId)
      nodes.set(d, ids)
    }
    return ids
  }
  const gen: Record<ToolName, () => unknown> = {
    browse_documents: () => ({ folder: pick(r, folders), limit: pick(r, [10, 50]) }),
    get_document: () => ({ doc_path: pick(r, docs) }),
    get_document_structure: () => {
      const d = pick(r, docs)
      return r() < 0.5 ? { doc_path: d } : { doc_path: d, node_id: pick(r, nodeIds(d)), depth: 2 }
    },
    get_node_content: () => {
      const d = pick(r, docs)
      const ids = nodeIds(d)
      return { doc_path: d, node_ids: Array.from({ length: 1 + Math.floor(r() * 3) }, () => pick(r, ids)) }
    },
    search_documents: () => (r() < 0.3 ? { query: pick(r, QUERIES), folder: pick(r, ['finance-en', 'medical-en', 'zh']) } : { query: pick(r, QUERIES) }),
  }
  return gen
}

async function toolLatencies() {
  const lib = openLibrary({ root: ROOT })
  try {
    const gen = toolCalls(lib)
    const out: Record<string, unknown> = {}
    for (const name of Object.keys(gen) as ToolName[]) {
      const times: number[] = []
      let maxChars = 0
      let errors = 0
      for (let i = 0; i < CALLS; i++) {
        const input = gen[name]()
        const t0 = performance.now()
        const res = await lib.callTool(name, input)
        times.push(performance.now() - t0)
        maxChars = Math.max(maxChars, res.length)
        if (!res.startsWith('{"success":true')) errors++
      }
      out[name] = { calls: CALLS, p50ms: pct(times, 50), p95ms: pct(times, 95), maxMs: pct(times, 100), maxResponseChars: maxChars, errorEnvelopes: errors }
      log(`${name}: ${JSON.stringify(out[name])}`)
    }
    return out
  } finally {
    lib.close()
  }
}

function structureStats() {
  const lib = openLibrary({ root: ROOT })
  try {
    const docs = lib.store.allDocPaths()
    const own: number[] = []
    const depths: number[] = []
    const perDoc: number[] = []
    const docTokens: number[] = []
    let chunks = 0
    let overMax = 0
    let leaves = 0
    let structureParts = 0
    let structureChars: number[] = []
    const byGroup: Record<string, { docs: number; nodes: number; chunks: number; tokens: number }> = {}
    for (const d of docs) {
      const doc = lib.store.getDoc(d)!
      const group = d.split('/')[0]!
      const g = (byGroup[group] ??= { docs: 0, nodes: 0, chunks: 0, tokens: 0 })
      g.docs++
      g.tokens += doc.tokens
      docTokens.push(doc.tokens)
      let n = 0
      for (const { node, titlePath } of walk(lib.store.getTree(d)!)) {
        n++
        own.push(node.ownTokens)
        depths.push(titlePath.length)
        if (node.kind === 'chunk') {
          chunks++
          g.chunks++
        }
        if (node.ownTokens > MAX_NODE_TOKENS) overMax++
        if (node.children.length === 0) leaves++
      }
      g.nodes += n
      perDoc.push(n)
    }
    return { docs: docs.length, nodes: own.length, leaves, chunks, overMaxNodeTokens: overMax, byGroup, ownTokens: dist(own), depth: dist(depths), nodesPerDoc: dist(perDoc), docTokens: dist(docTokens), docsOverStructureFirst: docTokens.filter((t) => t > STRUCTURE_FIRST_TOKEN_THRESHOLD).length }
  } finally {
    lib.close()
  }
}

/** Default get_document_structure (depth = DEFAULT_STRUCTURE_DEPTH) response size per document. */
async function structureResponses() {
  const lib = openLibrary({ root: ROOT })
  try {
    const chars: number[] = []
    const shown: number[] = []
    let multiPart = 0
    for (const d of lib.store.allDocPaths()) {
      const res = JSON.parse(await lib.callTool('get_document_structure', { doc_path: d })) as { data?: { pagination?: { has_more?: boolean } } }
      const s = JSON.stringify(res)
      chars.push(s.length)
      shown.push((s.match(/"node_id"/g) ?? []).length)
      if (res.data?.pagination?.has_more) multiPart++
    }
    return { depth: DEFAULT_STRUCTURE_DEPTH, responseChars: dist(chars), nodesShown: dist(shown), docsNeedingMoreParts: multiPart }
  } finally {
    lib.close()
  }
}

function dist(xs: number[]) {
  const s = [...xs].sort((a, b) => a - b)
  const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))] ?? 0
  return { n: s.length, min: s[0] ?? 0, p25: q(0.25), p50: q(0.5), p75: q(0.75), p90: q(0.9), p99: q(0.99), max: s.at(-1) ?? 0, mean: Math.round(s.reduce((a, b) => a + b, 0) / Math.max(1, s.length)) }
}

const dbSizeMB = () => mb(['', '-wal', '-shm'].reduce((s, ext) => s + (existsSync(DB + ext) ? statSync(DB + ext).size : 0), 0))

async function main() {
  const child = args.indexOf('--child')
  if (child !== -1) {
    process.stdout.write(`${JSON.stringify(await childPhase(args[child + 1]!))}\n`)
    return
  }
  log(`corpus ${ROOT}`)
  rmSync(join(ROOT, '.markindex'), { recursive: true, force: true })
  log('phase 1: full index (summaries off)')
  const index = runChild('index')
  log(JSON.stringify({ ...index, skipped: index.skipped.length }))
  const dbAfterIndex = dbSizeMB()

  log('phase 2: no-op re-index and single-document update')
  const noop = runChild('noop')
  const target = 'finance-en/JPM/10-K_2024.md'
  const file = join(ROOT, target)
  const original = readFileSync(file)
  let update
  try {
    appendFileSync(file, '\nBenchmark edit: one appended paragraph.\n')
    update = runChild('update', ['--target', target])
  } finally {
    writeFileSync(file, original)
  }
  runChild('update', ['--target', target]) // restore the index to the original content

  log('phase 3: tool latency')
  const tools = await toolLatencies()
  log('phase 4: structure statistics')
  const structure = structureStats()
  const structureDefault = await structureResponses()

  const result = {
    createdAt: new Date().toISOString(),
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    seed: SEED,
    fullIndex: { ...index, skipped: index.skipped },
    noopReindex: noop,
    singleDocUpdate: { ...update, targetTokens: undefined },
    dbSizeMB: dbAfterIndex,
    tools,
    structure,
    structureDefault,
  }
  mkdirSync(dirname(OUT), { recursive: true })
  writeFileSync(OUT, `${JSON.stringify(result, null, 2)}\n`)
  log(`wrote ${OUT}`)
}

await main()
