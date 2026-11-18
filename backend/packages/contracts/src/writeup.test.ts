import { describe, expect, it } from 'vitest'
import {
  missingOutlineSections,
  parseWriteup,
  settleWriteup,
  WRITEUP_ARTIFACTS_MAX,
} from './writeup.js'

describe('missingOutlineSections', () => {
  it('names the outline sections with no heading, ignoring case, spacing and fenced lines', () => {
    const markdown = [
      '# Handoff',
      '## summary ##',
      'Text.',
      '```',
      '## Open questions',
      '```',
      '###   Decisions   taken',
    ].join('\n')
    expect(
      missingOutlineSections(['Summary', 'Decisions taken', 'Open questions'], markdown),
    ).toEqual(['Open questions'])
  })

  it('keeps a `#` that is part of the heading, dropping only a closing run after a space', () => {
    expect(missingOutlineSections(['Migrating to C#'], '## Migrating to C#\n### Notes ##')).toEqual(
      [],
    )
  })
})

describe('settleWriteup', () => {
  it('drops and names an artifact no result the stage read holds', () => {
    const doc = settleWriteup(
      {
        title: 'Handoff',
        summary: '',
        markdown: '## Summary',
        artifacts: [
          { ref: 'art_held', caption: 'held' },
          { ref: 'art_invented', caption: 'invented' },
        ],
        missingSections: [],
        droppedArtifacts: [],
      },
      ['Summary'],
      ['art_held'],
    )
    expect(doc.artifacts.map((a) => a.ref)).toEqual(['art_held'])
    expect(doc.droppedArtifacts).toEqual(['art_invented'])
    expect(doc.missingSections).toEqual([])
  })

  it('keeps each artifact once and caps the document, naming the overflow', () => {
    const refs = Array.from({ length: WRITEUP_ARTIFACTS_MAX + 2 }, (_, i) => `art_${i}`)
    const reply = parseWriteup({
      title: 'Handoff',
      markdown: 'Body',
      artifacts: [...refs.map((ref) => ({ ref })), { ref: 'art_0', caption: 'again' }],
    })
    expect(reply.ok).toBe(true)
    if (!reply.ok) return
    const doc = settleWriteup(reply.value, [], refs)
    expect(doc.artifacts).toHaveLength(WRITEUP_ARTIFACTS_MAX)
    expect(doc.overflowArtifacts).toEqual(refs.slice(WRITEUP_ARTIFACTS_MAX))
    expect(doc.droppedArtifacts).toEqual([])
  })

  it('refuses a reply with no document written', () => {
    expect(parseWriteup({ title: 'Handoff', markdown: '   ' }).ok).toBe(false)
  })
})
