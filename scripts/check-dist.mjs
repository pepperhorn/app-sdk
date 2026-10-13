// Build guard: every entry and its declaration exist, and the core entry
// never reaches React (directly or through a shared chunk), so a non-React
// app can use the SDK without installing React.
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const problems = []
for (const e of ['index', 'react/index', 'ui/index', 'testing/index']) {
  for (const ext of ['.js', '.d.ts']) if (!existsSync(`dist/${e}${ext}`)) problems.push(`missing dist/${e}${ext}`)
}
for (const start of ['dist/index.js', 'dist/testing/index.js']) {
  const seen = new Set()
  const stack = [start]
  while (stack.length) {
    const f = stack.pop()
    if (seen.has(f) || !existsSync(f)) continue
    seen.add(f)
    const src = readFileSync(f, 'utf8')
    if (/(?:from|import)\s*["']react(?:\/[^"']*)?["']/.test(src)) problems.push(`${f} imports react (reached from ${start})`)
    for (const m of src.matchAll(/(?:from|import)\s*["'](\.\.?\/[^"']+)["']/g)) stack.push(join(dirname(f), m[1]))
  }
}
if (problems.length) {
  console.error(problems.join('\n'))
  process.exit(1)
}
console.log('dist ok')
