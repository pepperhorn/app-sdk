// Pre-publish guard (runbook 1.6): the tarball holds only the build, the
// licence, the README and the manifest. Never a .env, a token, a test or a tarball.
import { execFileSync } from 'node:child_process'

const [info] = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { encoding: 'utf8' }))
const files = info.files.map((f) => f.path)
const allowed = (f) => f === 'package.json' || f === 'README.md' || f === 'LICENSE' || f.startsWith('dist/')
const bad = files.filter((f) => !allowed(f) || /(^|\/)\.env|\.test\.|\.tgz$|stub-fetch/.test(f))
const missing = ['dist/index.js', 'dist/index.d.ts', 'dist/react/index.js', 'dist/ui/index.js', 'dist/testing/index.js', 'README.md', 'LICENSE']
  .filter((f) => !files.includes(f))
if (bad.length || missing.length) {
  if (bad.length) console.error('unexpected files in the package:\n  ' + bad.join('\n  '))
  if (missing.length) console.error('missing from the package:\n  ' + missing.join('\n  '))
  process.exit(1)
}
console.log(`pack ok: ${files.length} files, ${info.unpackedSize} bytes unpacked`)
