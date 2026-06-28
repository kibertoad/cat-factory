import type { AgentRunContext } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import { systemPromptFor, userPromptFor } from '../catalog.js'
import { companionFor, companionTargets, isCompanionKind } from './companions.js'
import {
  DOC_FINALIZER_KIND,
  DOC_OUTLINER_KIND,
  DOC_RESEARCHER_KIND,
  DOC_REVIEWER_KIND,
  DOC_WRITER_KIND,
} from './document.js'
import { registeredAgentStep, registeredKindRequiresContainer } from './registry.js'

// Importing the package registers the document kinds as a side effect; ./document is imported
// transitively here, so the registry is populated.

function ctx(overrides: Partial<AgentRunContext> = {}): AgentRunContext {
  return {
    agentKind: DOC_WRITER_KIND,
    pipelineName: 'Author a document',
    stepIndex: 0,
    isFinalStep: false,
    block: {
      title: 'Billing Service PRD',
      type: 'service',
      description: 'Define the billing service requirements.',
      taskTypeFields: { docKind: 'prd', audience: 'product stakeholders' },
    },
    priorOutputs: [],
    decisions: [],
    resolvedDecision: null,
    ...overrides,
  }
}

describe('document agent kinds', () => {
  it('registers the inline research/outline kinds and container-coding writer/finalizer', () => {
    expect(registeredAgentStep(DOC_RESEARCHER_KIND)?.surface).toBe('inline')
    expect(registeredAgentStep(DOC_OUTLINER_KIND)?.surface).toBe('inline')
    expect(registeredAgentStep(DOC_WRITER_KIND)?.surface).toBe('container-coding')
    expect(registeredAgentStep(DOC_FINALIZER_KIND)?.surface).toBe('container-coding')
    // The writer branches off base + opens a PR (coder-like); the finalizer polishes the PR.
    expect(registeredAgentStep(DOC_WRITER_KIND)?.clone?.branch).toBe('work')
    expect(registeredAgentStep(DOC_FINALIZER_KIND)?.clone?.branch).toBe('pr')
    // Container kinds route to the container executor.
    expect(registeredKindRequiresContainer(DOC_WRITER_KIND)).toBe(true)
    expect(registeredKindRequiresContainer(DOC_FINALIZER_KIND)).toBe(true)
    expect(registeredKindRequiresContainer(DOC_RESEARCHER_KIND)).toBe(false)
  })

  it('makes doc-reviewer a companion of doc-writer', () => {
    expect(isCompanionKind(DOC_REVIEWER_KIND)).toBe(true)
    expect(companionTargets(DOC_REVIEWER_KIND)).toContain(DOC_WRITER_KIND)
    expect(companionFor(DOC_REVIEWER_KIND)?.targets).toEqual([DOC_WRITER_KIND])
  })

  it("specialises the writer's prompt on the task's docKind and target path", () => {
    const prompt = userPromptFor(ctx(), { materialized: true })
    // The kind-specific structure guidance + the default target path are woven in.
    expect(prompt).toContain('Document kind: prd')
    expect(prompt).toContain('docs/prd/billing-service-prd.md')
    expect(prompt).toContain('product stakeholders')
  })

  it('honours an explicit targetPath override', () => {
    const prompt = userPromptFor(
      ctx({
        block: {
          ...ctx().block,
          taskTypeFields: { docKind: 'rfc', targetPath: 'docs/rfcs/0001-foo.md' },
        },
      }),
      { materialized: true },
    )
    expect(prompt).toContain('docs/rfcs/0001-foo.md')
    expect(prompt).toContain('Document kind: rfc')
  })

  it('the container-coding writer is NOT told to put its answer in the reply (it commits)', () => {
    // FINAL_ANSWER_IN_REPLY is for inline/explore deliverable-is-the-reply kinds; the writer's
    // product is a pushed commit, so it must not get that directive.
    expect(systemPromptFor(DOC_WRITER_KIND)).not.toContain(
      'Your deliverable is the text of your FINAL reply',
    )
    // The inline outliner DOES (its prose reply is the deliverable).
    expect(systemPromptFor(DOC_OUTLINER_KIND)).toContain(
      'Your deliverable is the text of your FINAL reply',
    )
  })
})
