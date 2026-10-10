import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { hasI18nKey } from '../../test/i18nKeys'

// The two toast funnels take a title KEY, resolved inside the composable. Typed message keys and
// `vue-i18n-extract` only see a key written literally inside a `t()` call, so a key handed to a funnel is
// invisible to both: a typo renders its own key path in the toast, and deleting a live key reads
// as a clean removal (`i18n:check` even lists these keys as unused). This spec closes that gap by
// reading every literal key passed to a funnel and resolving it against the base catalog.

const appRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

function* sources(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry)
    if (statSync(abs).isDirectory()) yield* sources(abs)
    else if (/\.(vue|ts)$/.test(entry) && !entry.endsWith('.spec.ts')) yield abs
  }
}

// The call heads that take a title key as their first argument, and the `titleKey:` option that
// `presentLinkFailures` forwards to `useActionToast`.
const CALL = /(?:actionToast\.(?:success|info|warning|error)|\bpresent)\(\s*/g
const OPTION = /\btitleKey:\s*/g
// A dotted key literal. A conditional first argument (`ok ? 'a.b' : 'a.c'`) yields both.
const KEY = /'([a-zA-Z][\w-]*(?:\.[\w-]+)+)'/g

/** The first argument of the call whose `(` ends at `from`: up to the first top-level `,` or `)`. */
function firstArgument(text: string, from: number): string {
  let depth = 0
  for (let i = from; i < text.length; i++) {
    const char = text[i]
    if (char === '(' || char === '[' || char === '{') depth++
    else if (char === ')' || char === ']' || char === '}') {
      if (depth === 0) return text.slice(from, i)
      depth--
    } else if (char === ',' && depth === 0) return text.slice(from, i)
  }
  return text.slice(from)
}

function keysIn(text: string): string[] {
  const keys: string[] = []
  for (const pattern of [CALL, OPTION]) {
    for (const match of text.matchAll(pattern)) {
      const arg = firstArgument(text, match.index + match[0].length)
      for (const [, key] of arg.matchAll(KEY)) keys.push(key!)
    }
  }
  return keys
}

describe('toast title keys', () => {
  it('reads keys from a plain, a conditional and an option call', () => {
    expect(keysIn(`actionToast.success('a.saved', { params: { n } })`)).toEqual(['a.saved'])
    expect(keysIn(`present(error, 'b.failed')`)).toEqual([])
    expect(keysIn(`actionToast.info(ok ? 'c.yes' : 'c.no')`)).toEqual(['c.yes', 'c.no'])
    expect(keysIn(`presentLinkFailures(f, id, { titleKey: 'd.linkFailed' })`)).toEqual([
      'd.linkFailed',
    ])
  })

  it('resolves every literal key a funnel is handed against the base catalog', () => {
    const missing: string[] = []
    let seen = 0
    for (const file of sources(appRoot)) {
      const text = readFileSync(file, 'utf8')
      // `present(error, key)` takes the key SECOND, so read it after the first comma.
      const presentKeys = [...text.matchAll(/\bpresent\(\s*[^,()]+,\s*/g)].flatMap((m) =>
        [...firstArgument(text, m.index + m[0].length).matchAll(KEY)].map(([, key]) => key!),
      )
      for (const key of [...keysIn(text), ...presentKeys]) {
        seen++
        if (!hasI18nKey(key)) missing.push(`${relative(appRoot, file)}: ${key}`)
      }
    }
    // A scan that matched nothing would pass vacuously, so it must have read some keys.
    expect(seen).toBeGreaterThan(0)
    expect(missing).toEqual([])
  })
})
