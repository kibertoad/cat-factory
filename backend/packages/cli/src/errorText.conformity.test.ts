import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getErrorMessage as kernelGetErrorMessage } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import { getErrorMessage } from './errorText.js'

// `src/errorText.ts` is a deliberate COPY of kernel's `getErrorMessage` (this package is published
// and stays runtime dependency-free, so it cannot import a `workspace:*` package from `bin.ts` —
// that resolves through pnpm's link locally and is absent on the registry). A copy is only
// acceptable if it cannot drift, so this suite pins the two to byte-identical output over the
// shapes that matter. Kernel is a DEVdependency, which is exactly what makes this import legal.

const coded = (message: string, code: string): Error => Object.assign(new Error(message), { code })
const wrapped = (message: string, cause: unknown): Error => new Error(message, { cause })

const CORPUS: Array<[name: string, thrown: unknown]> = [
  ['plain error', new Error('Could not write .env.local')],
  ['empty-message error', new Error('')],
  ['named error with no message', Object.assign(new Error(''), { name: 'AbortError' })],
  [
    'undici transport failure',
    wrapped('fetch failed', coded('connect ECONNREFUSED 127.0.0.1:443', 'ECONNREFUSED')),
  ],
  [
    'two-deep cause chain',
    wrapped('bootstrap failed', wrapped('fetch failed', new Error('socket hang up'))),
  ],
  [
    'aggregate over both addresses of one host',
    wrapped(
      'fetch failed',
      Object.assign(new AggregateError([], 'all attempts failed'), {
        errors: [
          coded('connect ECONNREFUSED ::1:6443', 'ECONNREFUSED'),
          coded('connect ECONNREFUSED 127.0.0.1:6443', 'ECONNREFUSED'),
        ],
      }),
    ),
  ],
  [
    'wide aggregate past the branch cap',
    Object.assign(new AggregateError([], 'all attempts failed'), {
      errors: Array.from({ length: 40 }, (_unused, i) => new Error(`endpoint ${i} refused`)),
    }),
  ],
  ['transport code the message omits', coded('write EPIPE', 'UND_ERR_SOCKET')],
  ['domain-style lowercase code', coded('Pick a value', 'validation')],
  [
    'self-referential cause',
    (() => {
      const e: Error & { cause?: unknown } = new Error('loops back')
      e.cause = e
      return e
    })(),
  ],
  [
    'credential in a url',
    new Error('clone https://user:ghp_0123456789abcdefghij@github.com/a/b.git'),
  ],
  ['env var name that is not a secret', new Error('Missing required key: GITHUB_TOKEN_SCOPES')],
  ['bearer token echo', new Error('rejected: Authorization: Bearer sk-abcdefghijklmnop1234')],
  ['over the length cap', new Error('x'.repeat(900))],
  ['thrown null', null],
  ['thrown undefined', undefined],
  ['thrown string', 'just a string'],
  ['thrown number', 404],
  ['thrown plain object', { message: 'not an error' }],
]

describe('CLI errorText conforms to kernel getErrorMessage', () => {
  for (const [name, thrown] of CORPUS) {
    it(`matches for ${name}`, () => {
      expect(getErrorMessage(thrown)).toBe(kernelGetErrorMessage(thrown))
    })
  }

  // The properties the copy exists for, asserted directly so a conforming-but-wrong pair (both
  // drifting together) still fails.
  it('reaches the cause a transport failure hides', () => {
    const text = getErrorMessage(
      wrapped('fetch failed', new Error('getaddrinfo ENOTFOUND api.github.com')),
    )
    expect(text).toContain('fetch failed')
    expect(text).toContain('ENOTFOUND')
  })

  it('drops a credential rather than printing it to stderr', () => {
    const text = getErrorMessage(
      new Error('POST failed for https://x:ghp_0123456789abcdefghij@api.github.com'),
    )
    expect(text).not.toContain('ghp_0123456789abcdefghij')
  })
})

// The invariant the copy exists to protect, asserted directly rather than trusted to a comment.
// `dist/` is what gets published, `dependencies` is what gets installed alongside it, and a
// devDependency import is invisible in every local run because pnpm links the workspace: the failure
// only appears for whoever runs `npx cat-factory` and gets ERR_MODULE_NOT_FOUND instead of a CLI.
describe('the published CLI imports nothing it does not depend on', () => {
  const srcDir = dirname(fileURLToPath(import.meta.url))
  const pkg = JSON.parse(readFileSync(join(srcDir, '..', 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>
  }
  const declared = new Set(Object.keys(pkg.dependencies ?? {}))

  /**
   * A file's VALUE imports of bare specifiers, as package names.
   *
   * `import type` is erased at compile time and never installed, so it does not count. Template
   * literals are stripped first: half this package is SCAFFOLDING, and the files it writes out
   * contain their own `import` lines (`templates.ts` emits a `main.ts` importing
   * `@cat-factory/local-server`) which this package never resolves itself.
   */
  function runtimeImports(source: string): string[] {
    const code = source.replace(/`(?:[^`\\]|\\[\s\S])*`/g, '``')
    return [...code.matchAll(/^import\s+(?!type\s)[^'"]*from\s*'([^'"]+)'/gm)]
      .map((m) => m[1] ?? '')
      .filter((spec) => !spec.startsWith('.') && !spec.startsWith('node:'))
      .map((spec) =>
        spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]!,
      )
  }

  const shipped = readdirSync(srcDir).filter(
    (f) => f.endsWith('.ts') && !f.includes('.test.') && !f.includes('.spec.'),
  )

  for (const file of shipped) {
    it(`${file} imports only declared dependencies`, () => {
      const used = runtimeImports(readFileSync(join(srcDir, file), 'utf8'))
      expect(used.filter((spec) => !declared.has(spec))).toEqual([])
    })
  }
})
