import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { APP_VERSION, LOCAL_SERVER_VERSION } from './templates.js'

// Guards against the exact drift this file is prone to: the scaffold pins `@cat-factory/local-server`
// and `@cat-factory/app` to explicit carets (templates.ts), which are refreshed BY HAND. Left alone
// they silently fall behind the libraries they mirror — this is why the CLI once scaffolded
// `^0.19.5`/`^0.47.7` while the libraries had shipped `0.33`/`0.63`. This test fails the build the
// moment a pin no longer covers the current workspace version, turning "someone remembers to bump
// the pin" into a CI gate.

const pkgVersion = (relativeToSrc: string): string => {
  const path = fileURLToPath(new URL(relativeToSrc, import.meta.url))
  return JSON.parse(readFileSync(path, 'utf8')).version as string
}

const parse = (v: string): [number, number, number] => {
  const [major = 0, minor = 0, patch = 0] = v.replace(/^\^/, '').split('.').map(Number)
  return [major, minor, patch]
}

/** Whether a `^x.y.z` caret range includes `version`, matching npm's `0.x` semantics. */
const caretCovers = (caret: string, version: string): boolean => {
  const [pMajor, pMinor, pPatch] = parse(caret)
  const [vMajor, vMinor, vPatch] = parse(version)
  if (vMajor !== pMajor) return false
  if (pMajor > 0) return vMinor > pMinor || (vMinor === pMinor && vPatch >= pPatch) // ^1+ locks major
  if (vMinor !== pMinor) return false // ^0.y locks the minor
  return vPatch >= pPatch
}

describe('scaffold library pins', () => {
  it.each([
    ['@cat-factory/local-server', LOCAL_SERVER_VERSION, '../../../runtimes/local/package.json'],
    ['@cat-factory/app', APP_VERSION, '../../../../frontend/app/package.json'],
  ])('%s pin still covers the current workspace version', (name, pin, pkgPath) => {
    const current = pkgVersion(pkgPath)
    expect(
      caretCovers(pin, current),
      `${name} pin ${pin} no longer covers ${current}; refresh it in src/templates.ts`,
    ).toBe(true)
  })
})
