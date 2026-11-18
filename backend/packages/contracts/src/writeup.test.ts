import { describe, expect, it } from 'vitest'
import { missingOutlineSections, settleWriteup } from './writeup.js'

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
})
