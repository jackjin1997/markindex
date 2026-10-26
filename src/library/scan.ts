import { type Dirent, readdirSync, readFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import ignore, { type Ignore } from 'ignore'

export interface ScannedFile {
  /** Library-relative path with posix separators. */
  path: string
  abs: string
}

const EXTENSIONS = ['.md', '.markdown']
/** Holds the index database. */
const STORE_DIR = '.markindex'
/** Optional ignore file at the library root (gitignore syntax), for rules that should not live in .gitignore. */
export const IGNORE_FILE = '.markindexignore'

export interface ScanOptions {
  /** Called for a subdirectory that cannot be read (e.g. EACCES); it is skipped and the scan continues. */
  onError?: (path: string, error: Error) => void
  /** Extra gitignore-syntax patterns, relative to `root`, applied on top of `.gitignore` and `.markindexignore`. */
  ignore?: string[]
}

interface Rules {
  /** posix path of the directory the .gitignore lives in ('' = root) */
  base: string
  ig: Ignore
}

/**
 * Makes `ignore` option patterns usable as root-level gitignore patterns: a leading `./` (also after `!`) is
 * stripped, since gitignore would never match it. A leading `/` stays a gitignore anchor (`/drafts/` = only the
 * top-level folder). Throws for filesystem paths — a pattern starting with the library root's absolute path, a
 * drive letter or `~` — and for `../` patterns, which can never match inside the library.
 */
export function normalizeIgnorePatterns(root: string, patterns: string[]): string[] {
  const absRoot = resolve(root).split(sep).join('/')
  return patterns.map((raw) => {
    const neg = raw.startsWith('!') ? '!' : ''
    let p = raw.slice(neg.length) // backslashes are gitignore escapes, so they are left alone
    if (p.startsWith(`${absRoot}/`) || p === absRoot || /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('~')) {
      const rel = p.startsWith(`${absRoot}/`) ? p.slice(absRoot.length + 1) : '<path relative to the library root>'
      throw new Error(`ignore pattern "${raw}" is an absolute path; patterns are gitignore syntax relative to the library root, e.g. "${neg}${rel}"`)
    }
    while (p.startsWith('./')) p = p.slice(2)
    if (p === '..' || p.startsWith('../')) throw new Error(`ignore pattern "${raw}" points outside the library root`)
    return neg + p
  })
}

/**
 * Lists `.md` / `.markdown` files under `root` (spec §6), sorted by path.
 * Skips `.mdx`, symbolic links (files and directories), dot-directories (`.git`, `.markindex`, ...)
 * and anything matched by `.gitignore` files at any level, a `.markindexignore` file at the root, or `opts.ignore`. An unreadable root throws; an unreadable
 * subdirectory is skipped and reported through `opts.onError` with its posix path plus a trailing `/`.
 */
export function scanLibrary(root: string, opts: ScanOptions = {}): ScannedFile[] {
  const out: ScannedFile[] = []

  const ignored = (rel: string, isDir: boolean, rules: Rules[]) =>
    rules.some(({ base, ig }) => {
      const sub = base === '' ? rel : rel.slice(base.length + 1)
      return ig.ignores(isDir ? `${sub}/` : sub)
    })

  const visit = (dirRel: string, inherited: Rules[]) => {
    const abs = dirRel === '' ? root : join(root, dirRel)
    let entries: Dirent[]
    try {
      entries = readdirSync(abs, { withFileTypes: true })
    } catch (e) {
      if (dirRel === '') throw e
      opts.onError?.(`${dirRel}/`, e as Error)
      return
    }
    const rules = [...inherited]
    try {
      rules.push({ base: dirRel, ig: ignore().add(readFileSync(join(abs, '.gitignore'), 'utf8')) })
    } catch {
      // no .gitignore here
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue
      const rel = dirRel === '' ? entry.name : `${dirRel}/${entry.name}`
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.') || entry.name === STORE_DIR) continue
        if (ignored(rel, true, rules)) continue
        visit(rel, rules)
      } else if (entry.isFile()) {
        const lower = entry.name.toLowerCase()
        if (!EXTENSIONS.some((ext) => lower.endsWith(ext))) continue
        if (ignored(rel, false, rules)) continue
        out.push({ path: rel, abs: join(root, rel) })
      }
    }
  }

  const rootRules: Rules[] = []
  try {
    rootRules.push({ base: '', ig: ignore().add(readFileSync(join(root, IGNORE_FILE), 'utf8')) })
  } catch {
    // no .markindexignore
  }
  if (opts.ignore && opts.ignore.length > 0) rootRules.push({ base: '', ig: ignore().add(normalizeIgnorePatterns(root, opts.ignore)) })
  visit('', rootRules)
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}
