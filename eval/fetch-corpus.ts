/**
 * Downloads the development evaluation corpus into eval/corpus/ (gitignored, never committed).
 *
 *   npx tsx eval/fetch-corpus.ts [--only finance-en,medical-en,zh] [--out eval/corpus]
 *
 * Idempotent: files already on disk are kept. Sources and licenses are documented in eval/README.md.
 *
 * - finance-en: SEC 10-K filings, HF dataset astr010/sec-10k-markdown-compressed (MIT). The converted Markdown has
 *   (almost) no `#` headings, so "PART I" / "Item 1A." lines are promoted to h1 / h2 (line count unchanged).
 * - medical-en: clinical guidelines, HF dataset epfl-llm/guidelines, field `clean_text` (Common Crawl ToU; only
 *   the redistributable sources are in the open subset). The longest guidelines WITH heading structure are kept.
 * - zh: PRC laws / regulations / clinical norms from zh.wikisource (official texts, not copyright-protected per
 *   著作权法 第5条) and long finance / medical zh.wikipedia articles (CC BY-SA 4.0, local use only), rendered
 *   HTML → Markdown with turndown. Missing headings are reconstructed from 第X章 / 第X节 / 一、 patterns.
 *   (The NHC site nhc.gov.cn answers scripted requests with HTTP 412 and flk.npc.gov.cn is a JS-only app,
 *   so the official texts are taken from their Wikisource transcriptions.)
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { Readable } from 'node:stream'
import TurndownService from 'turndown'
import { approxTokens } from '../src/text/tokens.js'
import { countAtxHeadings, reconstructSecHeadings, reconstructZhHeadings } from './lib/headings.js'

const UA = 'markindex-eval/0.1 (https://github.com/jackjin1997/markindex; corpus fetch for local evaluation)'
const HF_SEC = 'https://huggingface.co/datasets/astr010/sec-10k-markdown-compressed/resolve/main'
const HF_GUIDELINES = 'https://huggingface.co/datasets/epfl-llm/guidelines/resolve/main/open_guidelines.jsonl'

// ── finance-en ─────────────────────────────────────────────────────────────────────────────────────────────
/** 20 companies across banking, insurance, healthcare, energy, tech and retail; extras fill gaps if one fails. */
const SEC_TICKERS = ['JPM', 'C', 'BX', 'AES', 'KEY', 'AFL', 'ELV', 'AIZ', 'DVA', 'CYH', 'AAPL', 'MSFT', 'GOOGL', 'AMZN', 'NVDA', 'TSLA', 'META', 'UNH', 'WMT', 'XOM']
const SEC_EXTRA = ['CVX', 'IBM', 'NFLX', 'HD', 'NKE', 'BA', 'GE', 'VZ']
const SEC_PER_COMPANY = 8
const SEC_TARGET = 160

// ── medical-en ─────────────────────────────────────────────────────────────────────────────────────────────
const GUIDELINES_TARGET = 110
const GUIDELINES_MIN_HEADINGS = 8
const GUIDELINES_PER_SOURCE_CAP = 40

// ── zh ─────────────────────────────────────────────────────────────────────────────────────────────────────
/** Wikisource law / regulation / clinical-norm titles (latest version is resolved via search). */
const ZH_WIKISOURCE = [
  '中华人民共和国民法典', '中华人民共和国公司法', '中华人民共和国证券法', '中华人民共和国商业银行法', '中华人民共和国保险法',
  '中华人民共和国银行业监督管理法', '中华人民共和国反洗钱法', '中华人民共和国中国人民银行法', '中华人民共和国证券投资基金法',
  '中华人民共和国期货和衍生品法', '中华人民共和国信托法', '中华人民共和国票据法', '中华人民共和国会计法', '中华人民共和国审计法',
  '中华人民共和国预算法', '中华人民共和国税收征收管理法', '中华人民共和国企业所得税法', '中华人民共和国个人所得税法',
  '中华人民共和国企业破产法', '中华人民共和国合伙企业法', '中华人民共和国劳动合同法', '中华人民共和国劳动法',
  '中华人民共和国社会保险法', '中华人民共和国反垄断法', '中华人民共和国消费者权益保护法', '中华人民共和国电子商务法',
  '中华人民共和国个人信息保护法', '中华人民共和国数据安全法', '中华人民共和国网络安全法', '中华人民共和国药品管理法',
  '中华人民共和国医师法', '中华人民共和国基本医疗卫生与健康促进法', '中华人民共和国传染病防治法', '中华人民共和国疫苗管理法',
  '中华人民共和国中医药法', '中华人民共和国食品安全法', '中华人民共和国精神卫生法', '中华人民共和国职业病防治法',
  '中华人民共和国刑法', '中华人民共和国民事诉讼法', '中华人民共和国刑事诉讼法', '中华人民共和国行政诉讼法',
  '中华人民共和国行政处罚法', '中华人民共和国招标投标法', '中华人民共和国政府采购法', '医疗器械监督管理条例',
  '医疗机构管理条例', '新型冠状病毒肺炎诊疗方案（试行第八版）', '新型冠状病毒感染诊疗方案（试行第十版）',
]
/** Long zh.wikipedia articles rich in English terms, acronyms and drug names (mixed-language questions). */
const ZH_WIKIPEDIA = [
  '2007年–2008年环球金融危机', '比特币', '巴塞尔协定', '联邦储备系统', '量化宽松', '布雷顿森林体系', '首次公开募股',
  '对冲基金', '2019冠状病毒病', '糖尿病', '阿兹海默病', '乳腺癌', '肺癌', '艾滋病', '结核病', '高血压', '抗生素耐药性',
  '青霉素', '2019冠状病毒病疫苗', '新型冠状病毒', '次级房屋信贷危机', '中国人民银行', '欧洲中央银行', '国际货币基金组织',
  '心肌梗死', '帕金森病', '流行性感冒', '疟疾', '乙型肝炎', '精神分裂症',
]
const ZH_MIN_CHARS = 8_000

const args = process.argv.slice(2)
const argValue = (name: string) => {
  const i = args.indexOf(name)
  return i === -1 ? undefined : args[i + 1]
}
const OUT = resolve(argValue('--out') ?? join(import.meta.dirname, 'corpus'))
const ONLY = new Set((argValue('--only') ?? 'finance-en,medical-en,zh').split(','))

const log = (s: string) => process.stderr.write(`${s}\n`)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function fetchRetry(url: string, init: RequestInit = {}, tries = 4): Promise<Response> {
  let last: unknown
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { ...init, headers: { 'user-agent': UA, ...(init.headers ?? {}) } })
      if (res.ok) return res
      last = new Error(`HTTP ${res.status} for ${url}`)
      if (res.status === 404) break
    } catch (e) {
      last = e
    }
    await sleep(1000 * 2 ** i)
  }
  throw last
}

function write(path: string, text: string) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}

const frontmatter = (fields: Record<string, string>) =>
  `---\n${Object.entries(fields)
    .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
    .join('\n')}\n---\n`

// ── finance-en ─────────────────────────────────────────────────────────────────────────────────────────────

async function fetchFinance() {
  const dir = join(OUT, 'finance-en')
  let count = existsSync(dir) ? readdirSync(dir).reduce((n, t) => n + readdirSync(join(dir, t)).length, 0) : 0
  const tmp = mkdtempSync(join(tmpdir(), 'markindex-sec-'))
  try {
    for (const ticker of [...SEC_TICKERS, ...SEC_EXTRA]) {
      if (count >= SEC_TARGET) break
      if (existsSync(join(dir, ticker))) continue
      try {
        const res = await fetchRetry(`${HF_SEC}/${ticker}_filings.tar.gz`)
        const tgz = join(tmp, `${ticker}.tar.gz`)
        writeFileSync(tgz, Buffer.from(await res.arrayBuffer()))
        const extract = join(tmp, ticker)
        mkdirSync(extract)
        execFileSync('tar', ['xzf', tgz, '-C', extract])
        const src = join(extract, ticker)
        const filings = readdirSync(src)
          .filter((f) => /^10-K_\d{4}\.md$/.test(f))
          .sort()
          .reverse()
          .slice(0, SEC_PER_COMPANY)
        for (const f of filings) {
          const raw = readFileSync(join(src, f), 'utf8')
          const md = countAtxHeadings(raw) >= 5 ? raw : reconstructSecHeadings(raw)
          write(join(dir, ticker, f), md)
          count++
        }
        log(`finance-en ${ticker}: ${filings.length} filings (total ${count})`)
      } catch (e) {
        log(`finance-en ${ticker}: FAILED ${(e as Error).message}`)
      }
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

// ── medical-en ─────────────────────────────────────────────────────────────────────────────────────────────

interface Guideline {
  id: string
  source: string
  title: string
  url: string
  text: string
  headings: number
}

async function fetchMedical() {
  const dir = join(OUT, 'medical-en')
  if (existsSync(dir) && readdirSync(dir).length > 0) {
    log('medical-en: already present, skipping')
    return
  }
  const res = await fetchRetry(HF_GUIDELINES)
  const rl = createInterface({ input: Readable.fromWeb(res.body as never), crlfDelay: Infinity })
  let seen = 0
  let withHeadings = 0
  let keep: Guideline[] = []
  const stats = new Map<string, { n: number; headed: number }>()
  for await (const line of rl) {
    if (line.trim() === '') continue
    let row: { id: string; source: string; title: string | null; url: string | null; clean_text: string }
    try {
      row = JSON.parse(line)
    } catch {
      continue
    }
    seen++
    const headings = countAtxHeadings(row.clean_text ?? '')
    const s = stats.get(row.source) ?? { n: 0, headed: 0 }
    s.n++
    if (headings >= GUIDELINES_MIN_HEADINGS) {
      s.headed++
      withHeadings++
      keep.push({ id: row.id, source: row.source, title: row.title ?? '', url: row.url ?? '', text: row.clean_text, headings })
      if (keep.length > 2000) keep = keep.sort((a, b) => b.text.length - a.text.length).slice(0, 1000)
    }
    stats.set(row.source, s)
    if (seen % 5000 === 0) log(`medical-en: scanned ${seen} guidelines`)
  }
  keep.sort((a, b) => b.text.length - a.text.length || a.id.localeCompare(b.id))
  const perSource = new Map<string, number>()
  const chosen: Guideline[] = []
  for (const g of keep) {
    if (chosen.length >= GUIDELINES_TARGET) break
    const n = perSource.get(g.source) ?? 0
    if (n >= GUIDELINES_PER_SOURCE_CAP) continue
    perSource.set(g.source, n + 1)
    chosen.push(g)
  }
  for (const g of chosen) {
    const title = g.title && g.title !== 'None' ? g.title : g.id
    write(join(dir, g.source, `${g.id.slice(0, 16)}.md`), `${frontmatter({ title, source: g.source, url: g.url, license: 'see epfl-llm/guidelines (Common Crawl ToU)' })}${g.text}\n`)
  }
  log(`medical-en: scanned ${seen}, ${withHeadings} with >= ${GUIDELINES_MIN_HEADINGS} headings; kept ${chosen.length}`)
  log(`medical-en: per source (total / with headings): ${JSON.stringify(Object.fromEntries(stats))}`)
  log(`medical-en: chosen per source: ${JSON.stringify(Object.fromEntries(perSource))}`)
}

// ── zh ─────────────────────────────────────────────────────────────────────────────────────────────────────

function turndown(): TurndownService {
  const td = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-' })
  td.remove(['style', 'script', 'sup'])
  td.remove((node) => node.nodeName.toLowerCase() === 'math')
  td.addRule('drop-chrome', {
    filter: (node) => {
      const cls = ` ${(node as HTMLElement).getAttribute?.('class') ?? ''} `
      return /\s(mw-editsection|navbox|infobox|metadata|ambox|reflist|references|mw-references-wrap|reference|hatnote|noprint|toc|thumb|gallery|mw-empty-elt|sistersitebox|header_notes|ws-noexport|licenseContainer|licenseBanner)\s/.test(cls)
    },
    replacement: () => '',
  })
  // strip links but keep their text
  td.addRule('unlink', { filter: 'a', replacement: (content) => content })
  td.addRule('img', { filter: 'img', replacement: () => '' })
  return td
}

async function mediawiki(host: string, params: Record<string, string>) {
  const url = `https://${host}/w/api.php?${new URLSearchParams({ format: 'json', formatversion: '2', ...params })}`
  const res = await fetchRetry(url)
  await sleep(300)
  return (await res.json()) as Record<string, any>
}

/** Latest version of a Wikisource law: the exact title, or "<title> (YYYY年)" with the largest year. */
async function resolveWikisource(base: string): Promise<string | undefined> {
  const r = await mediawiki('zh.wikisource.org', { action: 'query', list: 'search', srsearch: `intitle:"${base}"`, srlimit: '50', srnamespace: '0' })
  const titles: string[] = (r.query?.search ?? []).map((x: { title: string }) => x.title)
  const versions = titles
    .map((t) => ({ t, m: t.match(new RegExp(`^${base.replace(/[()（）]/g, '.')} ?[（(](\\d{4})年[)）]$`)) }))
    .filter((x) => x.m)
    .sort((a, b) => Number(b.m![1]) - Number(a.m![1]))
  if (versions[0]) return versions[0].t
  return titles.includes(base) ? base : undefined
}

function cleanMarkdown(md: string): string {
  return md
    .replace(/ /g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .split('\n')
    .map((l) => l.replace(/\s+$/, ''))
    .join('\n')
    .trim()
}

async function fetchZhPage(host: string, title: string, td: TurndownService) {
  const r = await mediawiki(host, { action: 'parse', page: title, prop: 'text', redirects: '1', variant: 'zh-cn', disableeditsection: '1' })
  if (!r.parse) throw new Error(r.error?.info ?? 'no parse result')
  const html: string = r.parse.text
  let md = cleanMarkdown(td.turndown(html))
  if (countAtxHeadings(md) < 3) md = reconstructZhHeadings(md)
  return { title: r.parse.title as string, md }
}

async function fetchZh() {
  const td = turndown()
  const jobs: { host: string; title: string; dir: string; license: string }[] = [
    ...ZH_WIKISOURCE.map((title) => ({ host: 'zh.wikisource.org', title, dir: 'zh/law-wikisource', license: 'PRC official text, not copyrighted (著作权法第5条); via zh.wikisource' })),
    ...ZH_WIKIPEDIA.map((title) => ({ host: 'zh.wikipedia.org', title, dir: 'zh/wikipedia', license: 'CC BY-SA 4.0 (zh.wikipedia); local evaluation use only' })),
  ]
  let ok = 0
  for (const job of jobs) {
    const file = join(OUT, job.dir, `${job.title.replace(/[\\/:*?"<>|]/g, '_')}.md`)
    if (existsSync(file)) {
      ok++
      continue
    }
    try {
      const title = job.host === 'zh.wikisource.org' ? await resolveWikisource(job.title) : job.title
      if (!title) throw new Error('not found on wikisource')
      const page = await fetchZhPage(job.host, title, td)
      if ([...page.md].length < ZH_MIN_CHARS) throw new Error(`too short (${[...page.md].length} chars)`)
      const url = `https://${job.host}/wiki/${encodeURIComponent(page.title)}`
      write(file, `${frontmatter({ title: page.title, source: job.host, url, license: job.license })}\n${page.md}\n`)
      ok++
      log(`zh ${page.title}: ${[...page.md].length} chars, ${countAtxHeadings(page.md)} headings`)
    } catch (e) {
      log(`zh ${job.title}: SKIPPED ${(e as Error).message}`)
    }
  }
  log(`zh: ${ok} documents`)
}

// ── stats ──────────────────────────────────────────────────────────────────────────────────────────────────

function* mdFiles(dir: string): Generator<string> {
  if (!existsSync(dir)) return
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) yield* mdFiles(p)
    else if (e.name.endsWith('.md')) yield p
  }
}

function printStats() {
  for (const group of ['finance-en', 'medical-en', 'zh']) {
    let n = 0
    let tokens = 0
    let longest = { path: '', tokens: 0 }
    let over100k = 0
    for (const f of mdFiles(join(OUT, group))) {
      const t = approxTokens(readFileSync(f, 'utf8'))
      n++
      tokens += t
      if (t >= 100_000) over100k++
      if (t > longest.tokens) longest = { path: f.slice(OUT.length + 1), tokens: t }
    }
    log(`${group}: ${n} docs, ${tokens} approx tokens, ${over100k} docs >= 100k tokens, longest ${longest.path} (${longest.tokens})`)
  }
}

if (ONLY.has('finance-en')) await fetchFinance()
if (ONLY.has('medical-en')) await fetchMedical()
if (ONLY.has('zh')) await fetchZh()
printStats()
