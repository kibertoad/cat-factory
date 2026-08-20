import { describe, expect, it } from 'vitest'
import type { AgentRunContext } from '@cat-factory/kernel'
import { defaultAgentKindRegistry, type AgentKindRegistry } from '../kinds/registry.js'
import { userPromptFor } from '../catalog.js'
import { companionSystemPrompt } from './companion.js'

// Where a CONTAINER-backed companion's review starts (kaizen KZ-0007).
//
// The `pr-reviewer` has been handed its diff up front since it shipped; the container-backed
// companions were told only to "diff the branch against the base branch", whose NAME they had to
// discover first, and a measured review spent ~40 exploratory calls finding the change one file at
// a time. The base branch is a per-deployment fact the dispatch resolves and the agent cannot
// derive, so it is the one thing worth stating.
//
// Asserted through `userPromptFor` rather than against the section function: that is the one
// assembly every surface goes through, so a section wired for one companion and not another would
// pass a narrower test.

function registry(): AgentKindRegistry {
  const reg = defaultAgentKindRegistry()
  reg.register({ kind: 'reviewer', systemPrompt: 'You review code.' })
  reg.register({ kind: 'architect-companion', systemPrompt: 'You grade designs.' })
  reg.registerCompanion({
    kind: 'reviewer',
    targets: ['coder'],
    defaultThreshold: 0.8,
    reviews: 'the change',
    surface: 'container-explore',
  })
  reg.registerCompanion({
    kind: 'architect-companion',
    targets: ['architect'],
    defaultThreshold: 0.8,
    reviews: 'the design',
  })
  return reg
}

function context(kind: string): AgentRunContext {
  return {
    agentKind: kind,
    workspaceId: 'ws1',
    executionId: 'run1',
    stepIndex: 1,
    block: { id: 'b1', title: 'Add the ingress', type: 'task' },
    priorOutputs: [{ agentKind: 'coder', output: 'pushed the change' }],
    decisions: [],
    resolvedDecision: null,
  } as unknown as AgentRunContext
}

const dispatch = { baseBranch: 'trunk', workBranch: 'cat-factory/b1', multiRepo: false }

describe('the container companion checkout section', () => {
  it('names the resolved base branch and the diff commands', () => {
    const prompt = userPromptFor(context('reviewer'), registry(), { dispatch, materialized: true })
    // The branch NAME is the fact the agent cannot derive: `main` / `master` / `trunk` / a release
    // line is a per-deployment answer the dispatch already resolved.
    expect(prompt).toContain('`trunk`')
    expect(prompt).toContain('git diff --stat origin/trunk...HEAD')
    expect(prompt).toContain('git fetch origin trunk')
    // Planning from the diffstat is the half that removes the exploration, not the diff itself.
    expect(prompt).toContain('Plan the review from that diffstat')
  })

  it('says nothing to an INLINE companion, which has no checkout to run git in', () => {
    const prompt = userPromptFor(context('architect-companion'), registry(), { dispatch })
    expect(prompt).not.toContain('git diff')
  })

  it('says nothing when the caller resolved no dispatch (a panel participant has no filesystem)', () => {
    const prompt = userPromptFor(context('reviewer'), registry(), {})
    expect(prompt).not.toContain('git diff')
  })

  it('says nothing to a kind that is not a companion at all', () => {
    const prompt = userPromptFor(context('coder'), registry(), { dispatch, materialized: true })
    expect(prompt).not.toContain('Plan the review from that diffstat')
  })

  it('tells a multi-repo review to rate the combined change once', () => {
    const prompt = userPromptFor(context('reviewer'), registry(), {
      dispatch: { ...dispatch, multiRepo: true },
      materialized: true,
    })
    expect(prompt).toContain('MULTIPLE repositories')
    expect(prompt).toContain('single verdict')
  })

  it('has the system prompt POINT at those commands rather than describe a discovery task', () => {
    // The pair has to stay consistent: the system prompt is a per-kind constant and cannot name a
    // branch, so it must not restate the instruction in vaguer words beside the concrete one.
    const system = companionSystemPrompt('reviewer', registry())!
    expect(system).toContain('named with the work below')
    expect(system).toContain('with full history')
    expect(system).not.toContain("repo's")
  })
})
