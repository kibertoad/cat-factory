import { describe, expect, it } from 'vitest'
import { isSkillManifest, parseSkillManifest, slugFromDirName } from './skill-source.logic.js'

describe('skill-source.logic', () => {
  it('slugs a directory name into an id-safe token', () => {
    expect(slugFromDirName('Bug Triage')).toBe('bug-triage')
    expect(slugFromDirName('release_notes')).toBe('release-notes')
    expect(slugFromDirName('!!!')).toBe('skill')
  })

  it('recognises SKILL.md case-insensitively', () => {
    expect(isSkillManifest('SKILL.md')).toBe(true)
    expect(isSkillManifest('skill.md')).toBe(true)
    expect(isSkillManifest('README.md')).toBe(false)
    expect(isSkillManifest('SKILL.txt')).toBe(false)
  })

  it('parses frontmatter name/description + body', () => {
    const parsed = parseSkillManifest(
      'bug-triage',
      ['---', 'name: Bug Triage', 'description: Triage a bug', '---', '', '- Reproduce it.'].join(
        '\n',
      ),
    )
    expect(parsed).toEqual({
      name: 'Bug Triage',
      description: 'Triage a bug',
      instructions: '- Reproduce it.',
    })
  })

  it('defaults a missing name to the humanised dir and description to the first body line', () => {
    const parsed = parseSkillManifest('release-notes', '# Heading\n\nWrite the notes.')
    expect(parsed).toEqual({
      name: 'Release notes',
      description: 'Heading',
      instructions: '# Heading\n\nWrite the notes.',
    })
  })

  it('returns null for an empty manifest (keeps a prior row alive upstream)', () => {
    expect(parseSkillManifest('empty', '---\nname: X\n---\n   \n')).toBeNull()
  })
})
