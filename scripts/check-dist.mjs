// Build guard: every entry and its declaration exist, and the core entry
// never reaches React (directly or through a shared chunk), so a non-React
// app can use the SDK without installing React.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
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
    // static (`from 'react'`, `import 'react'`) and dynamic (`import('react')`) forms
    if (/(?:from\s*|import\s*\(?\s*)["']react(?:\/[^"']*)?["']/.test(src)) problems.push(`${f} imports react (reached from ${start})`)
    for (const m of src.matchAll(/(?:from\s*|import\s*\(?\s*)["'](\.\.?\/[^"']+)["']/g)) stack.push(join(dirname(f), m[1]))
  }
}
// dist/react and dist/ui must share ONE PhProvider context: exactly one file
// creates it, and both entries import it from that same chunk.
const jsFiles = []
const walk = (d) => {
  for (const n of readdirSync(d, { withFileTypes: true })) {
    if (n.isDirectory()) walk(join(d, n.name))
    else if (n.name.endsWith('.js')) jsFiles.push(join(d, n.name))
  }
}
if (existsSync('dist')) walk('dist')
const creators = jsFiles.filter((f) => /\bcreateContext\s*\(/.test(readFileSync(f, 'utf8')))
if (creators.length !== 1) problems.push(`expected exactly one file creating the PhProvider context, found ${creators.length}: ${creators.join(', ')}`)
else {
  const chunk = creators[0].replace(/^dist\//, '')
  for (const entry of ['dist/react/index.js', 'dist/ui/index.js']) {
    const src = existsSync(entry) ? readFileSync(entry, 'utf8') : ''
    const reaches = [...src.matchAll(/(?:from\s*|import\s*\(?\s*)["'](\.\.?\/[^"']+)["']/g)].some((m) => join(dirname(entry), m[1]) === creators[0])
    if (!reaches) problems.push(`${entry} does not import the shared context chunk ${chunk}`)
  }
}
if (problems.length) {
  console.error(problems.join('\n'))
  process.exit(1)
}
console.log('dist ok')
