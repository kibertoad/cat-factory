import type { AgentRunContext } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import { projectResearcherUserPrompt } from './project-researcher.js'

function context(contextProjects?: AgentRunContext['block']['contextProjects']): AgentRunContext {
  return {
    block: { description: 'Research the vendor.', ...(contextProjects ? { contextProjects } : {}) },
    project: {
      projectId: 'prj_1',
      kind: 'research',
      definition: {
        kind: 'research',
        key: 'acme:vendor',
        version: 1,
        title: 'Vendor',
        credentials: [],
        targets: [{ baseUrl: 'https://vendor.example', surface: 'api' }],
        inputs: [],
        promptAdditions: {},
        stages: [],
        spec: {},
      },
      inputs: {},
      linkedFrameBlockIds: [],
      upstream: [],
      brief: {
        mode: 'initial',
        brief: 'Learn the vendor.',
        questions: [{ id: 'paging', topic: 'API', question: 'How does paging work?' }],
        priorFindings: [],
      },
    },
  } as unknown as AgentRunContext
}

describe('projectResearcherUserPrompt', () => {
  it('points at what earlier stages and linked projects found, materialised as context files', () => {
    const prompt = projectResearcherUserPrompt(
      context([
        {
          projectId: 'prj_1',
          title: 'Stage Discover',
          kind: 'research',
          summary: 'Uses OAuth.',
          coverage: '1 of 1 questions answered',
          body: '...',
          revision: { id: 'pout_1', seq: 1 },
        },
      ]),
    )
    expect(prompt).toContain('How does paging work?')
    expect(prompt).toContain('`project-<name>.md`')
    expect(prompt).toContain('- Stage Discover (research project, revision 1): Uses OAuth.')
  })

  it('adds no context index when there is nothing to read', () => {
    expect(projectResearcherUserPrompt(context())).not.toContain('Linked projects')
  })
})
