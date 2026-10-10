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

const dispatch = {
  baseBranch: 'trunk',
  checkoutBranch: 'cat-factory/b1',
  workBranch: 'cat-factory/b1',
  multiRepo: false,
}

describe('the container companion checkout section', () => {
  it('names the resolved base branch and the diff commands', () => {
    const prompt = userPromptFor(context('reviewer'), registry(), { dispatch, materialized: true })
    // The branch NAME is the fact the agent cannot derive: `main` / `master` / `trunk` / a release
    // line is a per-deployment answer the dispatch already resolved.
    expect(prompt).toContain('`trunk`')
    expect(prompt).toContain('git diff --stat origin/trunk...HEAD')
    // Planning from the diffstat is the half that removes the exploration, not the diff itself.
    expect(prompt).toContain('Plan the review from that diffstat')
  })

  it('names NO git fetch: the container agent holds no credential to run one', () => {
    // The harness carries the token out of band (GIT_ASKPASS, per harness-issued command) and the
    // clone URL embeds no secret, so an agent-issued `git fetch` fails outright on a private repo.
    // The refs are the harness's job; naming the command would put an error on the first
    // instruction the whole review is anchored on.
    const prompt = userPromptFor(context('reviewer'), registry(), { dispatch, materialized: true })
    expect(prompt).not.toContain('git fetch')
  })

  it('says nothing when the checkout IS the base branch, so there is no diff to plan from', () => {
    // A `clone.branch: 'pr'` dispatch falls back to base when the producer opened no pull request
    // (a coder that changed nothing, an `opensPr: false` chain). `<base>...HEAD` is empty there, and
    // the section would tell the reviewer to plan from that emptiness and not to look past it.
    const prompt = userPromptFor(context('reviewer'), registry(), {
      dispatch: { ...dispatch, checkoutBranch: 'trunk' },
      materialized: true,
    })
    expect(prompt).not.toContain('git diff')
    expect(prompt).not.toContain('Plan the review from that diffstat')
  })

  it('REPORTS a base branch name it cannot safely quote instead of interpolating it', () => {
    // The base branch is provider-supplied and git permits characters a shell substitutes and a
    // markdown code span terminates. A refused input is an omission that is stated, never a silent
    // shortening: the agent is told to derive the ref itself and to say that it had to.
    const prompt = userPromptFor(context('reviewer'), registry(), {
      dispatch: { ...dispatch, baseBranch: 'release-$(id)`x`' },
      materialized: true,
    })
    expect(prompt).not.toContain('$(id)')
    expect(prompt).not.toContain('git diff')
    expect(prompt).toContain('cannot safely quote')
    expect(prompt).toContain('git branch -r')
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

  it('tells a multi-repo review to rate the combined change once, without claiming a shared branch', () => {
    // An explore peer carries `cloneBranch` only when the caller pinned one, so a peer is otherwise
    // at its OWN default branch: asserting the siblings share this branch would send the reviewer
    // to run a diff that resolves to nothing and read the emptiness as a verdict.
    const prompt = userPromptFor(context('reviewer'), registry(), {
      dispatch: { ...dispatch, multiRepo: true },
      materialized: true,
    })
    expect(prompt).toContain('MULTIPLE repositories')
    expect(prompt).toContain('single verdict')
    expect(prompt).not.toContain('same branch')
  })

  it('leaves the system prompt able to stand alone, pointing at no section that may be withheld', () => {
    // The pair has to stay consistent in BOTH directions. The section is withheld wherever it would
    // describe a checkout that is not a change, and the grading bar is stated by a user-prompt
    // wrapper that the editor and the Sandbox never run — so a system prompt deferring to either
    // ("the commands are named below", "the bar is stated below") is a dangling pointer on exactly
    // those surfaces. It states the rule instead.
    const system = companionSystemPrompt('reviewer', registry())!
    expect(system).toContain('with full history')
    expect(system).toContain('start from what actually changed')
    expect(system).not.toContain('named with the work below')
    expect(system).not.toContain('stated with the work below')
    // The clause this replaced: a discovery task ("diff the branch against the repo's default/base
    // branch") the dispatch had already resolved the answer to.
    expect(system).not.toContain("the repo's default/base branch")
  })
})
