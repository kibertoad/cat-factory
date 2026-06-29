import { describe, expect, it } from 'vitest'
import { buildGitignore, mergeGitignore, REQUIRED_GITIGNORE_RULES } from './gitignore.js'

describe('buildGitignore', () => {
  it('ignores the env secrets but keeps the example', () => {
    const out = buildGitignore()
    expect(out).toContain('.env')
    expect(out).toContain('.env.*')
    expect(out).toContain('!.env.example')
    for (const rule of REQUIRED_GITIGNORE_RULES) expect(out).toContain(rule)
  })
})

describe('mergeGitignore', () => {
  it('appends only the missing rules to an existing file', () => {
    const existing = '# my stuff\nnode_modules/\n.env\n'
    const merged = mergeGitignore(existing)
    // Existing content preserved verbatim.
    expect(merged.startsWith(existing)).toBe(true)
    // Already-present rules are not duplicated.
    expect(merged.match(/^node_modules\/$/gm)).toHaveLength(1)
    expect(merged.match(/^\.env$/gm)).toHaveLength(1)
    // A missing rule is appended.
    expect(merged).toContain('!.env.example')
  })

  it('returns the original unchanged when nothing is missing', () => {
    const full = `${REQUIRED_GITIGNORE_RULES.join('\n')}\n`
    expect(mergeGitignore(full)).toBe(full)
  })

  it('handles a file without a trailing newline', () => {
    const merged = mergeGitignore('node_modules/')
    expect(merged).toContain('\n.env\n')
  })
})
