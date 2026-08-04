import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// The one rule the typecheck cannot enforce: everything the HOSTED endpoint reaches must import no
// Node built-in.
//
// A deployment mounts `handleMcpHttpRequest` inside its own backend, and one of the runtimes that
// backend serves is workerd, where `node:fs` does not RESOLVE at build time — so a built-in reached
// from this half is not a runtime fallback, it is a Worker that fails to build. The typecheck cannot
// see it: this package opts into `@types/node` (its `bin` genuinely is a Node process), so
// `import { readFileSync } from 'node:fs'` in `config.ts` type-checks perfectly and breaks a
// deployment nobody runs on this side of the tree.
//
// The list is the CLOSED runtime-neutral half. `bin.ts` and `stdio.ts` are deliberately absent: they
// are the process, and the process is allowed to be one.

const srcDir = resolve(dirname(fileURLToPath(import.meta.url)), '../src')

const RUNTIME_NEUTRAL = [
  'http.ts',
  'server.ts',
  'config.ts',
  'instructions.ts',
  'result.ts',
  'tools.generated.ts',
]

describe('the hosted half', () => {
  it.each(RUNTIME_NEUTRAL)('imports no Node built-in: %s', (file) => {
    const source = readFileSync(join(srcDir, file), 'utf8')
    // Every import form: static, `export … from`, and a dynamic `import('node:…')`, which a bundler
    // resolves at build time exactly like the static one.
    const offenders = [...source.matchAll(/['"](node:[^'"]+)['"]/g)].map((match) => match[1])
    expect(offenders).toEqual([])
  })

  it('keeps the neutral list in step with what the entry point pulls in', () => {
    // A new module reached from `http.ts` that nobody adds above would be unguarded, and the failure
    // it guards against only shows up in another package's build. So the list is checked against the
    // import graph rather than trusted.
    const reachable = new Set<string>()
    const walk = (file: string): void => {
      if (reachable.has(file)) return
      reachable.add(file)
      const source = readFileSync(join(srcDir, file), 'utf8')
      for (const match of source.matchAll(/from '\.\/([\w.-]+\.ts)'/g)) walk(match[1]!)
    }
    walk('http.ts')
    expect([...reachable].sort()).toEqual([...RUNTIME_NEUTRAL].sort())
  })
})
