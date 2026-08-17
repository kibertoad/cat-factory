import type { AgentRunContext } from '@cat-factory/kernel'
import type { RequirementReviewItem } from '@cat-factory/contracts'
import { blockTypeSchema } from '@cat-factory/contracts'
import { builtinFixture, builtinFixturesFor } from '@cat-factory/sandbox-fixtures'
import { describe, expect, it } from 'vitest'
import type * as clarityLogic from './modules/clarity/clarity.logic.js'
import type * as requirementsLogic from './modules/requirements/requirements.logic.js'

// Compile-time conformance: a fixture's `payload` is `Record<string, unknown>` on the wire,
// but it MUST be the exact context shape the agent actually consumes. These typed literals
// are checked against the real context types from orchestration/kernel, and `toEqual` ties
// each one to the committed fixture so a drift in the fixture payload — or in the upstream
// context type — fails this test instead of shipping.
//
// This matters more now that the run-driver renders each fixture through the SAME pure prompt
// builder its production caller uses (`modules/sandbox/sandbox-input.ts`) rather than a
// hand-rolled approximation: a payload that has drifted from its context type no longer produces a
// slightly-thinner prompt, it produces one the real builder reads differently.
//
// This conformance test lives in orchestration (which owns the requirements/clarity logic
// types AND can see the fixtures via @cat-factory/sandbox-fixtures) rather than in the
// sandbox-fixtures package itself: a fixtures-side import of orchestration would close a
// dependency cycle (orchestration -> sandbox -> sandbox-fixtures -> orchestration). Keeping
// the check here leaves the fixtures package a pure, leaf data package.

describe('fixture payloads conform to the agents’ context types', () => {
  it('requirements-review payload is a RequirementsContext', () => {
    const expected: requirementsLogic.RequirementsContext = {
      block: {
        title: 'Notification preferences',
        type: 'service',
        description:
          'Let users turn off notifications they do not want. Add a settings page where they can toggle notifications on or off.',
      },
      docs: [],
      tasks: [],
    }
    expect(builtinFixture('req-notify-prefs-simple')?.payload).toEqual(expected)
  })

  it('a requirements payload may state the service, which the reviewer prompt branches on', () => {
    // `buildReviewPrompt` drops its "do not pick a system" note when the product is identified, so
    // the two shapes exercise genuinely different prompts. Typed here so a change to
    // `OwnServiceContext` fails the fixture rather than silently rendering nothing.
    const service: NonNullable<requirementsLogic.RequirementsContext['service']> = {
      stated: true,
      frameId: 'frame-workspaces',
      title: 'Workspaces',
      description: 'Workspace membership, roles and invitations.',
    }
    expect(builtinFixture('req-bulk-invite-moderate')?.payload).toMatchObject({ service })
  })

  it('clarity-review payload is a ClarityContext', () => {
    const expected: clarityLogic.ClarityContext = {
      block: {
        title: 'Dashboard is slow',
        type: 'service',
        description: 'The dashboard is really slow now. Please fix it, it was fine before.',
      },
    }
    expect(builtinFixture('clarity-slow-page-simple')?.payload).toEqual(expected)
  })

  it('requirements-writer payloads carry the context, findings and grounding the Writer prompt needs', () => {
    for (const f of builtinFixturesFor('requirements-writer')) {
      const payload = f.payload as {
        findings: RequirementReviewItem[]
        grounding: requirementsLogic.RecommendationGrounding
      }
      // `buildRecommendationPrompt` emits one line per finding id and the Writer's contract is one
      // recommendation per id, so an empty list would pose no task at all.
      expect(payload.findings.length, `${f.id} has no findings`).toBeGreaterThan(0)
      for (const finding of payload.findings) {
        expect(finding.id.length).toBeGreaterThan(0)
        expect(finding.detail.length).toBeGreaterThan(0)
      }
      // Every grounding leg must be PRESENT even when empty: an empty one is what makes a fixture
      // test whether the Writer reports `general-practice` honestly instead of citing a source it
      // was never given, and an absent one would read to the coercion as the same thing.
      expect(Array.isArray(payload.grounding.fragments)).toBe(true)
      expect(Array.isArray(payload.grounding.specExcerpts)).toBe(true)
      expect(Array.isArray(payload.grounding.webResults)).toBe(true)
    }
    // At least one fixture must ground nothing in a standard, and at least one must ground
    // something in one: the `grounding_honesty` dimension can only discriminate across both.
    const groundings = builtinFixturesFor('requirements-writer').map(
      (f) => (f.payload as { grounding: requirementsLogic.RecommendationGrounding }).grounding,
    )
    expect(groundings.some((g) => g.fragments.length > 0)).toBe(true)
    expect(groundings.some((g) => g.fragments.length === 0)).toBe(true)
  })

  it('task-estimator payloads are estimator contexts carrying the upstream steps’ output', () => {
    for (const f of builtinFixturesFor('task-estimator')) {
      const ctx = f.payload as unknown as AgentRunContext
      expect(ctx.agentKind).toBe('task-estimator')
      // The estimator runs mid-pipeline, after the requirements are clarified: `isFinalStep` true
      // would tell the generic user prompt this is the last step of the run.
      expect(ctx.isFinalStep).toBe(false)
      expect(ctx.priorOutputs.length).toBeGreaterThan(0)
      expect(ctx.resolvedDecision).toBeNull()
    }
  })

  it('reviewer payloads are reviewer AgentRunContexts carrying the work in priorOutputs', () => {
    for (const f of builtinFixturesFor('reviewer')) {
      // The cast is checked by the structural assertions below; the type import proves the
      // shape exists. Each must be a final-step reviewer context with a coder prior output.
      const ctx = f.payload as unknown as AgentRunContext
      expect(ctx.agentKind).toBe('reviewer')
      expect(ctx.isFinalStep).toBe(true)
      expect(ctx.priorOutputs.some((p) => p.agentKind === 'coder')).toBe(true)
      expect(ctx.resolvedDecision).toBeNull()
      // The change under review has to be somewhere the prompt can see it: either fenced in the
      // producer's own report (a single snippet) or on `injectedContextFiles` (a repo-scale change,
      // which is the production seam for a caller with no checkout). A fixture with neither hands
      // the reviewer a task title and nothing to review.
      const inReport = ctx.priorOutputs.some((p) => p.output.includes('```'))
      const inFiles = (ctx.injectedContextFiles ?? []).some((file) => file.content.includes('```'))
      expect(inReport || inFiles, `${f.id} carries no change to review`).toBe(true)
    }
  })

  it('an AgentRunContext fixture that states its service states it as an OwnServiceContext', () => {
    // `ownService` is a DISCRIMINATED result, not a nullable title, and the payload IS the context
    // shape, so a fixture that identifies its product must author the real thing. Typed here so a
    // change to `OwnServiceContext` fails the fixture rather than silently rendering nothing: the
    // coercion falls back to "not under a service" for anything it cannot read, which would turn a
    // drifted payload into a quietly different (and still plausible) prompt.
    const withService = ['reviewer', 'architect-companion', 'task-estimator']
      .flatMap((kind) => builtinFixturesFor(kind))
      .filter((f) => (f.payload as { ownService?: unknown }).ownService !== undefined)
    // Both branches of `ownServiceSection` need exercising, and it is the one section that renders
    // when the answer is "no service", so the library must not be all of one kind.
    expect(withService.length).toBeGreaterThan(0)
    for (const f of withService) {
      const own = (f.payload as unknown as AgentRunContext).ownService
      expect(own?.stated, `${f.id}`).toBe(true)
      if (own?.stated) {
        expect(own.frameId.length).toBeGreaterThan(0)
        expect(own.title.length).toBeGreaterThan(0)
      }
    }
  })

  it('at least one reviewer fixture delivers a repo-scale change as injected context files', () => {
    // The coverage this library would otherwise be missing entirely: in production the code
    // reviewer reads a real multi-file checkout, and the findings that matter most span files.
    const repoScale = builtinFixturesFor('reviewer').filter((f) => {
      const ctx = f.payload as unknown as AgentRunContext
      return (ctx.injectedContextFiles ?? []).length > 0
    })
    expect(repoScale.length).toBeGreaterThan(0)
    for (const f of repoScale) {
      const files = (f.payload as unknown as AgentRunContext).injectedContextFiles ?? []
      for (const file of files) {
        expect(file.path.length).toBeGreaterThan(0)
        expect(file.content.length).toBeGreaterThan(0)
      }
    }
  })

  it('architecture payloads are architect-companion contexts reviewing an architect proposal', () => {
    for (const f of builtinFixturesFor('architect-companion')) {
      const ctx = f.payload as unknown as AgentRunContext
      expect(ctx.agentKind).toBe('architect-companion')
      expect(ctx.priorOutputs.some((p) => p.agentKind === 'architect')).toBe(true)
    }
  })

  it('every requirements/clarity/estimation block uses a valid BlockType', () => {
    // From the picklist that OWNS the vocabulary, not a copy of its members: a hand list here would
    // agree with a hand list in the coercion and both could be wrong together.
    const valid = new Set<string>(blockTypeSchema.options)
    for (const kind of [
      'requirements-review',
      'clarity-review',
      'requirements-writer',
      'task-estimator',
    ]) {
      for (const f of builtinFixturesFor(kind)) {
        const block = (f.payload as { block: { type: string } }).block
        expect(valid.has(block.type), `${f.id} block type ${block.type}`).toBe(true)
      }
    }
  })
})
