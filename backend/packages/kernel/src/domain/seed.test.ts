import { describe, expect, it } from 'vitest'
import { PipelineRegistry } from './pipeline-registry.js'
import {
  defaultPipelineIdForTaskType,
  retiredPipelines,
  REVIEW_PIPELINE_ID,
  seedPipelines,
} from './seed.js'

// The built-in catalog is authored with the named-step form (`definePipeline`), which lowers to the
// wire `Pipeline`'s index-aligned `agentKinds`/`gates`/`enabled` arrays. These assertions pin that
// lowering — a gate/disabled flag named on a step must land on that exact step — so inserting a step
// (e.g. the `deployer` before a tester) can never silently shift a positional flag onto the wrong
// one. They also lock the deployer-before-consumer invariant the run-start guard relies on.

const byId = () => new Map(seedPipelines().map((p) => [p.id, p]))

const ENV_CONSUMERS = new Set(['tester-api', 'tester-ui', 'playwright', 'human-test'])

describe('seedPipelines — named-gate lowering', () => {
  it('keeps gates/enabled index-aligned with agentKinds for every pipeline', () => {
    for (const p of seedPipelines()) {
      if (p.gates) expect(p.gates.length, `${p.id} gates`).toBe(p.agentKinds.length)
      if (p.enabled) expect(p.enabled.length, `${p.id} enabled`).toBe(p.agentKinds.length)
    }
  })

  it('omits gates/enabled for a plain all-enabled, gate-less pipeline', () => {
    const quick = byId().get('pl_quick')!
    expect(quick.gates).toBeUndefined()
    expect(quick.enabled).toBeUndefined()
    expect(quick.agentKinds).toEqual([
      'coder',
      'blueprints',
      'mocker',
      'deployer',
      'tester-api',
      'conflicts',
      'ci',
      'merger',
    ])
  })

  it('seeds the PR-review pipeline and defaults a review task to it', () => {
    const review = byId().get(REVIEW_PIPELINE_ID)
    expect(review, 'pl_review must be seeded').toBeDefined()
    // A read-only single-step review: just the pr-reviewer, no merge tail (nothing to merge).
    expect(review!.agentKinds).toEqual(['pr-reviewer'])
    expect(review!.gates).toBeUndefined()
    // A `review` task type pins the PR-review pipeline; other non-document types get no default.
    expect(defaultPipelineIdForTaskType('review')).toBe(REVIEW_PIPELINE_ID)
    expect(defaultPipelineIdForTaskType('feature')).toBeUndefined()
  })

  it('lowers pl_full: human gates + opt-in brainstorms land on the named steps', () => {
    const full = byId().get('pl_full')!
    expect(full.agentKinds).toEqual([
      'requirements-brainstorm',
      'requirements-review',
      'spec-writer',
      'spec-companion',
      'architecture-brainstorm',
      'architect',
      'researcher',
      'coder',
      'reviewer',
      'code-commenter',
      'blueprints',
      'mocker',
      'deployer',
      'tester-api',
      'conflicts',
      'ci',
      'merger',
    ])
    // Human gates: the two brainstorms, the requirements review, and the architecture.
    const gated = full.agentKinds.filter((_k, i) => full.gates![i])
    expect(gated).toEqual([
      'requirements-brainstorm',
      'requirements-review',
      'architecture-brainstorm',
      'architect',
    ])
    // Opt-in (disabled by default): the two brainstorm dialogues.
    const disabled = full.agentKinds.filter((_k, i) => full.enabled![i] === false)
    expect(disabled).toEqual(['requirements-brainstorm', 'architecture-brainstorm'])
  })

  it('lowers pl_fullstack: the architecture gate sits on architect-companion, not architect', () => {
    const fs = byId().get('pl_fullstack')!
    const gated = fs.agentKinds.filter((_k, i) => fs.gates![i])
    expect(gated).toEqual([
      'requirements-brainstorm',
      'requirements-review',
      'architecture-brainstorm',
      'architect-companion',
    ])
    expect(fs.agentKinds.filter((_k, i) => fs.enabled![i] === false)).toEqual([
      'requirements-brainstorm',
      'architecture-brainstorm',
    ])
  })

  it('explores the repo BEFORE interviewing the human in pl_initiative', () => {
    // The interviewer is an INLINE kind with no checkout, so an interviewer that ran first could
    // only ask the stakeholder to describe their own codebase. Ordering the read-only analyst ahead
    // of it is what leaves the interview the half a repository cannot answer. Asserted as an ORDER,
    // not a set: a reorder back is the whole regression.
    const steps = byId().get('pl_initiative')!.agentKinds
    expect(steps).toEqual([
      'initiative-analyst',
      'initiative-interviewer',
      'initiative-planner',
      'initiative-committer',
    ])
  })

  it('lowers the single-gate pipelines onto the right step', () => {
    const gateKindOf = (id: string) => {
      const p = byId().get(id)!
      return p.agentKinds.filter((_k, i) => p.gates![i])
    }
    expect(gateKindOf('pl_bugfix')).toEqual(['clarity-review'])
    expect(gateKindOf('pl_bug_triage')).toEqual(['clarity-review'])
    expect(gateKindOf('pl_initiative')).toEqual(['initiative-planner'])
    expect(gateKindOf('pl_document')).toEqual(['doc-reviewer'])
  })

  it('defines the docs-refresh spawn pipelines as a single author step + the merge tail', () => {
    // initiative-presets slice 7: each is one authoring kind, then conflicts → ci → merger, with
    // no human gates (the author opens the PR the tail then gates + ships). Diagrams + READMEs
    // reuse doc-writer / pl_document_quick, so only comments + business-rules get their own.
    const map = byId()
    expect(map.get('pl_code_comments')!.agentKinds).toEqual([
      'code-commenter',
      'conflicts',
      'ci',
      'merger',
    ])
    expect(map.get('pl_business_docs')!.agentKinds).toEqual([
      'business-documenter',
      'conflicts',
      'ci',
      'merger',
    ])
    for (const id of ['pl_code_comments', 'pl_business_docs']) {
      expect(map.get(id)!.gates, `${id} gates`).toBeUndefined()
      expect(map.get(id)!.enabled, `${id} enabled`).toBeUndefined()
    }
  })

  it('places a deployer before the first env-consumer in every tester/human-test pipeline', () => {
    for (const p of seedPipelines()) {
      const firstConsumer = p.agentKinds.findIndex((k) => ENV_CONSUMERS.has(k))
      if (firstConsumer === -1) continue
      const deployerIdx = p.agentKinds.indexOf('deployer')
      expect(deployerIdx, `${p.id} has a deployer`).toBeGreaterThanOrEqual(0)
      expect(deployerIdx, `${p.id} deployer precedes its first consumer`).toBeLessThan(
        firstConsumer,
      )
    }
  })
})

describe('retiredPipelines — withdrawn built-ins', () => {
  it('never names a pipeline the catalog still ships', () => {
    // The drift guard for the hand-authored tombstone list: retiring a built-in means DELETING its
    // definition from the builders, so an id in both places is an unfinished retirement. Left
    // unchecked it reaches a workspace as a pipeline the SPA offers to reseed AND to remove.
    const live = new Set(seedPipelines().map((p) => p.id))
    for (const retired of retiredPipelines()) {
      expect(live.has(retired.id), `${retired.id} is retired but still in the catalog`).toBe(false)
    }
  })

  it('points every replacedBy at a pipeline that actually exists', () => {
    // A replacement the SPA cannot resolve renders an advisory that names nothing, so a `replacedBy`
    // typo (or a replacement that was itself later retired) has to fail here rather than in the UI.
    const live = new Set(seedPipelines().map((p) => p.id))
    for (const retired of retiredPipelines()) {
      if (!retired.replacedBy) continue
      expect(live.has(retired.replacedBy), `${retired.id} replacedBy ${retired.replacedBy}`).toBe(
        true,
      )
    }
  })

  it('retires a deployment-registered pipeline, dropping it from the live catalog', () => {
    const registry = new PipelineRegistry()
    registry.register({ id: 'pl_org_legacy', name: 'Legacy org flow', agentKinds: ['coder'] })
    expect(seedPipelines(registry).map((p) => p.id)).toContain('pl_org_legacy')

    registry.retire('pl_org_legacy', { replacedBy: 'pl_simple' })
    expect(seedPipelines(registry).map((p) => p.id)).not.toContain('pl_org_legacy')
    expect(retiredPipelines(registry)).toContainEqual({
      id: 'pl_org_legacy',
      replacedBy: 'pl_simple',
    })
  })

  it('lets a re-registration un-retire an id (the later assertion wins, never both)', () => {
    const registry = new PipelineRegistry()
    registry.retire('pl_org_legacy')
    registry.register({ id: 'pl_org_legacy', name: 'Revived', agentKinds: ['coder'] })
    expect(seedPipelines(registry).map((p) => p.id)).toContain('pl_org_legacy')
    expect(retiredPipelines(registry).map((p) => p.id)).not.toContain('pl_org_legacy')
  })

  it('keeps a live built-in out of the retired set even when a registry retires its id', () => {
    // A deployment can only withdraw its OWN pipelines: retiring a built-in id it did not replace
    // would otherwise offer every workspace a delete for a pipeline the catalog still ships.
    const registry = new PipelineRegistry()
    registry.retire('pl_full')
    expect(retiredPipelines(registry).map((p) => p.id)).not.toContain('pl_full')
    expect(seedPipelines(registry).map((p) => p.id)).toContain('pl_full')
  })
})
