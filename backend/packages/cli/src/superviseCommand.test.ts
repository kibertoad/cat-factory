import { describe, expect, it } from 'vitest'
import { quoteToken } from './superviseCommand.js'

const WINDOWS_NODE = 'C:\\Program Files\\nodejs\\node.exe'

describe('quoteToken', () => {
  it('leaves a plain token alone', () => {
    expect(quoteToken('pnpm')).toBe('pnpm')
    expect(quoteToken('dev:raw')).toBe('dev:raw')
    expect(quoteToken('--watch')).toBe('--watch')
  })

  it('quotes a Windows path containing a space WITHOUT escaping its backslashes', () => {
    const quoted = quoteToken(WINDOWS_NODE)
    expect(quoted).toBe(`"${WINDOWS_NODE}"`)
    // The bug this guards: `JSON.stringify` would double every separator
    // ("C:\\\\Program Files\\\\…"), and no shell unescapes those — so the quoted path resolves to a
    // path that does not exist, and the supervised command dies instantly with "cannot find module".
    expect(quoted).not.toContain('\\\\')
    expect(quoted.slice(1, -1)).toBe(WINDOWS_NODE)
  })

  it('preserves a POSIX path with a space', () => {
    expect(quoteToken('/home/me/my projects/app.mjs')).toBe('"/home/me/my projects/app.mjs"')
  })

  it('escapes an embedded double quote', () => {
    expect(quoteToken('say "hi"')).toBe('"say \\"hi\\""')
  })

  it('renders an empty token as an explicit empty argument', () => {
    expect(quoteToken('')).toBe('""')
  })
})
