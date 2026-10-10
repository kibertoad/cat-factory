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
      group: 'other',
      instructions: '- Reproduce it.',
    })
  })

  it('parses a declared group, case-folded, and defaults to the unclassified shelf', () => {
    const withGroup = parseSkillManifest(
      'security-review',
      ['---', 'name: Security review', 'group: Review', '---', 'Check the auth paths.'].join('\n'),
    )
    expect(withGroup?.group).toBe('review')
    // Kept RAW rather than narrowed here: the catalog read boundary decides which shelf an
    // unrecognised value lands on, and the management surface shows the author what they wrote.
    const unknownGroup = parseSkillManifest(
      'perf',
      ['---', 'name: Perf', 'group: sekurity', '---', 'Measure first.'].join('\n'),
    )
    expect(unknownGroup?.group).toBe('sekurity')
    expect(parseSkillManifest('plain', 'Do the thing.')?.group).toBe('other')
  })

  it('defaults a missing name to the humanised dir and description to the first body line', () => {
    const parsed = parseSkillManifest('release-notes', '# Heading\n\nWrite the notes.')
    expect(parsed).toEqual({
      name: 'Release notes',
      description: 'Heading',
      group: 'other',
      instructions: '# Heading\n\nWrite the notes.',
    })
  })

  it('returns null for an empty manifest (keeps a prior row alive upstream)', () => {
    expect(parseSkillManifest('empty', '---\nname: X\n---\n   \n')).toBeNull()
  })
})
