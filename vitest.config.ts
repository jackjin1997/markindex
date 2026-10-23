import { defineConfig } from 'vitest/config'

export default defineConfig({
  // a few tests index 200k-word / multi-MB inputs or spawn the CLI; 5 s is too tight on a loaded machine
  test: { include: ['tests/**/*.test.ts'], testTimeout: 20_000 },
})
