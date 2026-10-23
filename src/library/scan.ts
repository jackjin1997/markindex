import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import ignore, { type Ignore } from 'ignore'

export interface ScannedFile {
  /** Library-relative path with posix separators. */
  path: string
  abs: string
}

const EXTENSIONS = ['.md', '.markdown']
/** Holds the index database. */
const STORE_DIR = '.markindex'

interface Rules {
  /** posix path of the directory the .gitignore lives in ('' = root) */
  base: string
  ig: Ignore
}

/**
 * Lists `.md` / `.markdown` files under `root` (spec §6), sorted by path.
 * Skips `.mdx`, symbolic links (files and directories), dot-directories (`.git`, `.markindex`, ...)
 * and anything matched by `.gitignore` files at any level.
 */
export function scanLibrary(root: string): ScannedFile[] {
  const out: ScannedFile[] = []

  const ignored = (rel: string, isDir: boolean, rules: Rules[]) =>
    rules.some(({ base, ig }) => {
      const sub = base === '' ? rel : rel.slice(base.length + 1)
      return ig.ignores(isDir ? `${sub}/` : sub)
    })

  const visit = (dirRel: string, inherited: Rules[]) => {
    const abs = dirRel === '' ? root : join(root, dirRel)
    const rules = [...inherited]
    try {
      rules.push({ base: dirRel, ig: ignore().add(readFileSync(join(abs, '.gitignore'), 'utf8')) })
    } catch {
      // no .gitignore here
    }
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
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

  visit('', [])
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}
