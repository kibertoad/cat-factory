import type { AgentRunContext } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import { projectResearcherUserPrompt } from './project-researcher.js'

function context(): AgentRunContext {
  return {
    block: { description: 'Research the vendor.' },
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
  it('asks the planned questions against the targets, and leaves linked context to the job body', () => {
    const prompt = projectResearcherUserPrompt(context())
    expect(prompt).toContain('`paging` (API): How does paging work?')
    expect(prompt).toContain('https://vendor.example (API)')
    // The index of linked and upstream results is appended once for every project kind.
    expect(prompt).not.toContain('Linked projects')
  })
})
