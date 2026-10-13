import { defineConfig } from 'vitest/config'

// Node by default; DOM tests opt in with a `// @vitest-environment jsdom` docblock.
export default defineConfig({
  test: { include: ['src/**/*.test.{ts,tsx}', 'test/**/*.test.{ts,tsx}'], environment: 'node' },
})
