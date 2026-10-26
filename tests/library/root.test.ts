import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { indexLibrary } from '../../src/library/indexer.js'
import { openLibrary } from '../../src/library.js'
import { openStore } from '../../src/store/db.js'

let dir: string
beforeEach(() => void (dir = mkdtempSync(join(tmpdir(), 'markindex-root-'))))
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('library root validation', () => {
  it('indexLibrary rejects a missing root and a file root', async () => {
    const store = openStore(join(dir, 'db', 'index.db'))
    try {
      writeFileSync(join(dir, 'f.md'), '# x\n')
      await expect(indexLibrary({ root: join(dir, 'nope'), store })).rejects.toThrow(/does not exist/)
      await expect(indexLibrary({ root: join(dir, 'f.md'), store })).rejects.toThrow(/not a directory/)
    } finally {
      store.close()
    }
  })

  it('openLibrary rejects a missing root without creating anything', () => {
    const missing = join(dir, 'nope')
    expect(() => openLibrary({ root: missing })).toThrow(/does not exist/)
    expect(() => openLibrary({ root: missing, readonly: false })).toThrow(/does not exist/)
    expect(readdirSync(dir)).toEqual([])
  })
})
