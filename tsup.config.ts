import { defineConfig } from 'tsup'

// JS only: declarations come from tsc (tsconfig.build.json), which keeps the
// d.ts output independent of tsup's bundled TypeScript version.
export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'react/index': 'src/react/index.ts',
    'ui/index': 'src/ui/index.ts',
    'testing/index': 'src/testing/index.ts',
  },
  format: ['esm'],
  target: 'es2022',
  dts: false,
  splitting: true,
  sourcemap: true,
  treeshake: true,
  external: ['react', 'react/jsx-runtime', 'zod', 'zod/v4'],
})
