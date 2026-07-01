import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { APP_VERSION, LOCAL_SERVER_VERSION } from './templates.js'

// The scaffold pins `@cat-factory/local-server` and `@cat-factory/app` to explicit carets
// (templates.ts), refreshed BY HAND. The ONLY drift that actually breaks a scaffold is a pin that
// points AHEAD of what has shipped: `pnpm install` then can't resolve the (unpublished) version.
// A pin lagging BEHIND is harmless — the caret still resolves to a published release — so this test
// deliberately does NOT fail on it (that would just break every release PR that bumps a library a
// minor). It fails only when a pin is ahead of the current workspace version.

const pkgVersion = (relativeToSrc: string): string => {
  const path = fileURLToPath(new URL(relativeToSrc, import.meta.url))
  return JSON.parse(readFileSync(path, 'utf8')).version as string
}

const parse = (v: string): [number, number, number] => {
  const [major = 0, minor = 0, patch = 0] = v.replace(/^\^/, '').split('.').map(Number)
  return [major, minor, patch]
}

/** Whether the pinned floor is NEWER than `version` (i.e. the pin references an unreleased version). */
const pinIsAhead = (pin: string, version: string): boolean => {
  const p = parse(pin)
  const v = parse(version)
  for (let i = 0; i < 3; i++) {
    if (p[i]! > v[i]!) return true
    if (p[i]! < v[i]!) return false
  }
  return false // equal → not ahead
}

describe('scaffold library pins', () => {
  it.each([
    ['@cat-factory/local-server', LOCAL_SERVER_VERSION, '../../../runtimes/local/package.json'],
    ['@cat-factory/app', APP_VERSION, '../../../../frontend/app/package.json'],
  ])('%s pin is not ahead of the current workspace version', (name, pin, pkgPath) => {
    const current = pkgVersion(pkgPath)
    expect(
      pinIsAhead(pin, current),
      `${name} pin ${pin} is ahead of the current workspace version ${current} — it references an unpublished release, so a scaffold's install would fail to resolve. Lower it in src/templates.ts.`,
    ).toBe(false)
  })
})
