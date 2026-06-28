import { describe, expect, it } from 'vitest'
import {
  buildLinearIssueCreateVariables,
  parseLinearIssueCreateResponse,
} from './linear.create.logic.js'

describe('buildLinearIssueCreateVariables', () => {
  it('builds the input with the team id and a Markdown description', () => {
    const vars = buildLinearIssueCreateVariables({
      teamId: 'team_1',
      title: 'Tech debt: Auth',
      body: '# Findings\n\n- refactor',
    })
    expect(vars.input).toEqual({
      teamId: 'team_1',
      title: 'Tech debt: Auth',
      description: '# Findings\n\n- refactor',
    })
  })

  it('truncates an over-long title', () => {
    const vars = buildLinearIssueCreateVariables({ teamId: 't', title: 'x'.repeat(400), body: '' })
    expect((vars.input.title as string).length).toBe(250)
  })
})

describe('parseLinearIssueCreateResponse', () => {
  it('returns the created issue identifier and URL', () => {
    const ticket = parseLinearIssueCreateResponse({
      issueCreate: { success: true, issue: { identifier: 'ENG-42', url: 'https://linear.app/x' } },
    })
    expect(ticket).toEqual({ externalId: 'ENG-42', url: 'https://linear.app/x' })
  })

  it('throws when the mutation did not succeed', () => {
    expect(() => parseLinearIssueCreateResponse({ issueCreate: { success: false } })).toThrow()
    expect(() => parseLinearIssueCreateResponse({})).toThrow()
  })
})
