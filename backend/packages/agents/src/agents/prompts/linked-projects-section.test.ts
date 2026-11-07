import type { AgentRunContext } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import { renderLinkedProjects } from './standard.js'

type Project = NonNullable<AgentRunContext['block']['contextProjects']>[number]

function project(over: Partial<Project> = {}): Project {
  return {
    projectId: 'prj_1',
    title: 'Vendor research',
    kind: 'research',
    summary: 'The vendor uses OAuth.',
    coverage: '1 of 2 questions answered, 0 partial, 0 blocked, 1 unanswered',
    body: 'FULL BODY',
    revision: { id: 'frv_1', seq: 3 },
    ...over,
  }
}

describe('renderLinkedProjects', () => {
  it('renders nothing when no project is linked', () => {
    expect(renderLinkedProjects(undefined)).toBe('')
    expect(renderLinkedProjects([])).toBe('')
  })

  it('indexes each project for a container kind and points at the materialised file', () => {
    const out = renderLinkedProjects([project()], { materialized: true })
    expect(out).toContain('Vendor research (research project, revision 3): The vendor uses OAuth.')
    expect(out).toContain('1 of 2 questions answered')
    expect(out).toContain('project-<name>.md')
    expect(out).not.toContain('FULL BODY')
  })

  it('inlines the result for an inline kind', () => {
    const out = renderLinkedProjects([project({ revision: null })])
    expect(out).toContain('### Vendor research (research project)')
    expect(out).toContain('FULL BODY')
  })
})
