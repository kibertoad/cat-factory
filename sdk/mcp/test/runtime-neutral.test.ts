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

/**
 * Node's built-ins, UNPREFIXED.
 *
 * The `node:` prefix is a convention, not a requirement: `from 'fs'` resolves to the same module and
 * breaks the same Worker build, so a guard matching only the prefixed spelling waves through the
 * spelling someone is most likely to write by habit. Kept as the set that actually exists rather
 * than a pattern, because a bare specifier is otherwise indistinguishable from an npm dependency,
 * which is legitimate here.
 */
const NODE_BUILTINS = new Set([
  'assert',
  'async_hooks',
  'buffer',
  'child_process',
  'cluster',
  'console',
  'constants',
  'crypto',
  'dgram',
  'diagnostics_channel',
  'dns',
  'domain',
  'events',
  'fs',
  'http',
  'http2',
  'https',
  'inspector',
  'module',
  'net',
  'os',
  'path',
  'perf_hooks',
  'process',
  'punycode',
  'querystring',
  'readline',
  'repl',
  'stream',
  'string_decoder',
  'sys',
  'timers',
  'tls',
  'trace_events',
  'tty',
  'url',
  'util',
  'v8',
  'vm',
  'wasi',
  'worker_threads',
  'zlib',
])

/**
 * Every module specifier `source` imports, in each form a bundler resolves at build time.
 *
 * Static `import` / `export … from`, a BARE side-effect `import 'x'` (which has no `from` and so
 * escapes the obvious pattern), and a dynamic `import('x')`, resolved statically too whenever its
 * argument is a literal. Comments are stripped FIRST, because the doc comments in this package
 * legitimately name built-ins in prose and a scan over raw text counts those as violations.
 */
function specifiersOf(source: string): string[] {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
  const patterns = [
    /(?:^|[\s;}])(?:import|export)\b[^'"]*?\sfrom\s*['"]([^'"]+)['"]/g,
    /(?:^|[\s;}])import\s*['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ]
  return patterns.flatMap((pattern) => [...code.matchAll(pattern)].map((match) => match[1]!))
}

/** Whether `specifier` names a Node built-in, prefixed or not. */
function isNodeBuiltin(specifier: string): boolean {
  const bare = specifier.startsWith('node:') ? specifier.slice('node:'.length) : specifier
  // `fs/promises`, `stream/web` — a subpath does not change what the specifier resolves to.
  return NODE_BUILTINS.has(bare.split('/')[0]!)
}

describe('the hosted half', () => {
  it.each(RUNTIME_NEUTRAL)('imports no Node built-in: %s', (file) => {
    const source = readFileSync(join(srcDir, file), 'utf8')
    expect(specifiersOf(source).filter(isNodeBuiltin)).toEqual([])
  })

  it('keeps the neutral list in step with what the entry point pulls in', () => {
    // A new module reached from `http.ts` that nobody adds above would be unguarded, and the failure
    // it guards against only shows up in another package's build. So the list is checked against the
    // import graph rather than trusted — through the SAME extraction as the offender check above, so
    // a form one of them understands can never be a form the other silently misses.
    const reachable = new Set<string>()
    const walk = (file: string): void => {
      if (reachable.has(file)) return
      reachable.add(file)
      const source = readFileSync(join(srcDir, file), 'utf8')
      for (const specifier of specifiersOf(source)) {
        if (specifier.startsWith('./')) walk(specifier.slice('./'.length))
      }
    }
    walk('http.ts')
    expect([...reachable].sort()).toEqual([...RUNTIME_NEUTRAL].sort())
  })

  it('sees the forms a lazier guard waves through, and ignores prose', () => {
    // The extraction IS the guard, so it gets its own case rather than being trusted because the six
    // files above happen to pass: an unprefixed built-in, a side-effect import and a dynamic one all
    // break a Worker build, and a built-in named in a comment must not be mistaken for any of them.
    const sample = [
      `// a comment naming 'fs' and "node:child_process"`,
      `/* a block comment naming 'node:os' */`,
      `import { readFileSync } from 'fs'`,
      `import 'node:crypto'`,
      `const { join } = await import('node:path')`,
      `import { thing } from './neighbour.ts'`,
      `import { dep } from '@scope/pkg'`,
    ].join('\n')
    expect(specifiersOf(sample).filter(isNodeBuiltin).sort()).toEqual([
      'fs',
      'node:crypto',
      'node:path',
    ])
    // …and a relative neighbour is still found, which is what the reachability walk rides on.
    expect(specifiersOf(sample).filter((one) => one.startsWith('./'))).toEqual(['./neighbour.ts'])
  })
})
