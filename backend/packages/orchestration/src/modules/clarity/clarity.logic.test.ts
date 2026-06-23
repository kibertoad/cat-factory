import { describe, expect, it } from 'vitest'
import type { Block } from '@cat-factory/kernel'
import {
  buildClarityPrompt,
  buildClarityReworkPrompt,
  renderBugReport,
} from './clarity.logic.js'

const block: Pick<Block, 'title' | 'type' | 'description'> = {
  title: 'Login fails',
  type: 'service',
  description: 'Login returns 500 sometimes.',
}

describe('renderBugReport', () => {
  it('renders the raw report and the investigation when no clarified doc exists', () => {
    const out = renderBugReport({ block, investigation: 'AuthController throws on null email.' })
    expect(out).toContain('## Reported bug')
    expect(out).toContain('Login returns 500 sometimes.')
    expect(out).toContain('## Investigation (read-only findings from the codebase)')
    expect(out).toContain('AuthController throws on null email.')
  })

  it('prefers the clarified doc and drops the investigation on a later cycle', () => {
    const out = renderBugReport({
      block,
      investigation: 'should not appear',
      clarifiedDoc: '# Login — Bug Report\n\n## Steps to Reproduce\n1. POST /login twice.',
    })
    expect(out).toContain('## Current standardized bug report (under review)')
    expect(out).toContain('1. POST /login twice.')
    expect(out).not.toContain('should not appear')
  })

  it('falls back to a placeholder when the report is empty', () => {
    const out = renderBugReport({ block: { ...block, description: '' } })
    expect(out).toContain('(no description provided)')
  })
})

describe('buildClarityPrompt', () => {
  it('asks for the JSON triage shape and an empty array when the report is fixable', () => {
    const prompt = buildClarityPrompt({ block })
    expect(prompt).toContain('triage for fixability')
    expect(prompt).toContain('"items"')
    expect(prompt).toContain('return an empty items array')
  })
})

describe('buildClarityReworkPrompt', () => {
  it('folds in answered findings and restates cleanly when nothing was answered', () => {
    const withAnswer = buildClarityReworkPrompt({ block }, [
      {
        id: 'i1',
        category: 'gap',
        severity: 'high',
        title: 'No repro steps',
        detail: 'How do you trigger the 500?',
        status: 'answered',
        reply: 'POST /login with an empty email.',
        createdAt: 0,
        updatedAt: 0,
      },
    ])
    expect(withAnswer).toContain('Clarifications the reporter provided')
    expect(withAnswer).toContain('POST /login with an empty email.')

    const noNotes = buildClarityReworkPrompt({ block }, [])
    expect(noNotes).toContain('restate the bug report cleanly')
  })
})
