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

// The call heads whose FIRST argument is the title key, and those whose SECOND argument is: the
// error funnel's two (after the error or the reported detail) and `useInterviewDrafts`' `flushThen`,
// which forwards its key to `present`.
const FIRST = /actionToast\.(?:success|info|warning|error)\(\s*/g
const SECOND = /\b(?:present|presentReported|flushThen)\(/g
// Options that carry a key to a funnel through a helper. Only a LITERAL value is read: the same
// names also appear in type declarations and in the helpers that forward them.
const OPTION = /\b(?:titleKey|failureTitleKeys)\s*:\s*/g
// A dotted key literal. A conditional argument (`ok ? 'a.b' : 'a.c'`) yields both.
const KEY = /'([a-zA-Z][\w-]*(?:\.[\w-]+)+)'/g
// A tone passed around instead of called (`const show = ok ? actionToast.success : …`): every key
// then reaches the toast through the alias, where no call head above can read it.
const ALIAS = /actionToast\.(?:success|info|warning|error)\b(?!\s*\()/g

// Files whose funnel call takes its key from somewhere other than a literal argument. A prefix
// means the file spells its keys out in a table or in calls to a local helper, and every literal
// under that prefix in the file is resolved instead. `null` means the file only forwards a key
// its callers name, and those callers are read through `SECOND` and `OPTION`. A new indirect call
// fails until it is either made literal or listed here.
const INDIRECT: Record<string, string | null> = {
  'composables/useConfirmAction.ts': 'common.toast.',
  'components/github/GitHubPanel.vue': 'vcs.panel.pulls.',
  'components/pipeline/PipelineHealthModal.vue': 'pipeline.health.toast.',
  'components/settings/RiskPolicyPanel.vue': 'settings.riskPolicy.toast.',
  'composables/useInterviewDrafts.ts': null,
  'composables/useContextLinking.ts': null,
}

// The funnels themselves: they DEFINE the calls above (a signature reads like a call head), so
// they hold no key to check.
const FUNNELS =
  /^composables\/(?:useActionToast|usePipelineErrorToast)\.ts$|^composables\/pipelineErrorToast\//

/** The argument starting at `from`: up to the first top-level `,` or the closing `)`. */
function argumentAt(text: string, from: number): string {
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

/** Every key argument in `text`, each with the literal keys it contains (none for an indirect one). */
function keyArguments(text: string): { arg: string; keys: string[] }[] {
  const args: string[] = []
  for (const m of text.matchAll(FIRST)) args.push(argumentAt(text, m.index + m[0].length))
  for (const m of text.matchAll(SECOND)) {
    const first = argumentAt(text, m.index + m[0].length)
    const comma = m.index + m[0].length + first.length
    // `present(error)` with no key takes the funnel's own default title.
    if (text[comma] === ',') args.push(argumentAt(text, comma + 1).trim())
  }
  const keyed = args.map((arg) => ({
    arg: arg.trim(),
    keys: [...arg.matchAll(KEY)].map(([, k]) => k!),
  }))
  for (const m of text.matchAll(OPTION)) {
    const keys = [...argumentAt(text, m.index + m[0].length).matchAll(KEY)].map(([, k]) => k!)
    if (keys.length) keyed.push({ arg: m[0], keys })
  }
  return keyed
}

describe('toast title keys', () => {
  it('reads the key argument of every call shape', () => {
    const keys = (src: string) => keyArguments(src).flatMap((a) => a.keys)
    expect(keys(`actionToast.success('a.saved', { params: { n } })`)).toEqual(['a.saved'])
    expect(keys(`present(error, 'b.failed')`)).toEqual(['b.failed'])
    expect(keys(`presentReported(job.error, 'b.reported', { descriptionKey: 'x' })`)).toEqual([
      'b.reported',
    ])
    expect(keys(`actionToast.info(ok ? 'c.yes' : 'c.no')`)).toEqual(['c.yes', 'c.no'])
    expect(keys(`presentLinkFailures(f, id, { titleKey: 'd.linkFailed' })`)).toEqual([
      'd.linkFailed',
    ])
    expect(keys(`flushThen(submit, 'e.submitFailed')`)).toEqual(['e.submitFailed'])
    expect(keys(`failureTitleKeys: { one: 'f.one', many: 'f.many' }`)).toEqual(['f.one', 'f.many'])
    // A declaration or a forward names no key, and is not a call to check.
    expect(keyArguments(`titleKey: string`)).toEqual([])
    expect(keyArguments(`present(e)`)).toEqual([])
    expect(keyArguments(`actionToast.success(meta.toastKey)`)).toEqual([
      { arg: 'meta.toastKey', keys: [] },
    ])
  })

  it('resolves every key a funnel is handed against the base catalog', () => {
    const missing: string[] = []
    const unreadable: string[] = []
    let seen = 0
    for (const file of sources(appRoot)) {
      const rel = relative(appRoot, file).replaceAll('\\', '/')
      if (FUNNELS.test(rel)) continue
      const text = readFileSync(file, 'utf8')
      for (const alias of text.matchAll(ALIAS)) unreadable.push(`${rel}: ${alias[0]} passed around`)
      for (const { arg, keys } of keyArguments(text)) {
        if (!keys.length && !(rel in INDIRECT)) unreadable.push(`${rel}: ${arg}`)
        for (const key of keys) {
          seen++
          if (!hasI18nKey(key)) missing.push(`${rel}: ${key}`)
        }
      }
      const prefix = INDIRECT[rel]
      if (prefix !== undefined && prefix !== null) {
        for (const [, key] of text.matchAll(KEY)) {
          if (!key!.startsWith(prefix)) continue
          seen++
          if (!hasI18nKey(key!)) missing.push(`${rel}: ${key}`)
        }
      }
    }
    // A scan that matched nothing would pass vacuously, so it must have read some keys.
    expect(seen).toBeGreaterThan(0)
    expect(unreadable).toEqual([])
    expect(missing).toEqual([])
  })
})
