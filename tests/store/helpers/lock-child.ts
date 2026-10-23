// Child process for the lock contention test: try to open a writer, report, hold briefly, exit.
import { openStore, StoreLockedError } from '../../../src/store/db.js'

const file = process.argv[2]!
try {
  const s = openStore(file)
  process.stdout.write('acquired')
  setTimeout(() => s.close(), 1500)
} catch (e) {
  process.stdout.write(e instanceof StoreLockedError ? 'locked' : `error: ${(e as Error).message}`)
}
