import { describe, expect, it } from 'vitest'
import { pipelineAllowedForBlockLevel, pipelineAllowedForTaskType } from '@cat-factory/contracts'
import { hasInitiativeKinds } from './initiative-logic.js'
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

  it('omits gates/enabled/gating for a plain all-enabled, gate-less pipeline', () => {
    // `pl_simple` is the ladder rung with nothing declared on any step, so the lowering must emit
    // BARE `agentKinds` — no empty `gates`/`enabled`/`gating` arrays alongside it. That keeps a
    // hand-authored preset and a `definePipeline`d one byte-identical when neither declares a flag.
    const simple = byId().get('pl_simple')!
    expect(simple.gates).toBeUndefined()
    expect(simple.enabled).toBeUndefined()
    expect(simple.gating).toBeUndefined()
    expect(simple.agentKinds).toEqual([
      'coder',
      'reviewer',
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

  it('lowers pl_full: estimate gating lands on the named steps, and no human gate does', () => {
    const full = byId().get('pl_full')!
    expect(full.agentKinds).toEqual([
      'task-estimator',
      'architect',
      'architect-companion',
      'coder',
      'reviewer',
      'deployer',
      'tester-api',
      'conflicts',
      'ci',
      'human-review',
      'merger',
    ])
    // The gating array is index-aligned with agentKinds, so a step inserted above can never shift a
    // threshold onto its neighbour — the whole point of the named-step seed form.
    const estimateGated = full.agentKinds.filter((_k, i) => full.gating?.[i]?.enabled)
    expect(estimateGated).toEqual(['architect', 'tester-api', 'human-review'])
    expect(full.gating![full.agentKinds.indexOf('architect')]).toMatchObject({
      minComplexity: 0.4,
    })
    expect(full.gating![full.agentKinds.indexOf('human-review')]).toMatchObject({
      minRisk: 0.8,
      // An UNESTIMATED task must not silently wait for a human forever, so the escalation gate is
      // the one place `skip` is the safe default — the opposite of the thoroughness-first default
      // the other gates take.
      onMissingEstimate: 'skip',
    })
    // `architect-companion` carries NO gate of its own: it cascades off the architect at runtime,
    // so a threshold here would be a second copy to keep in sync.
    expect(full.gating![full.agentKinds.indexOf('architect-companion')]).toBeNull()
    // No human APPROVAL gate anywhere. The estimate may add a checkpoint but never cancel one, so a
    // step is never both human-gated and estimate-gated (`assertValidGating` enforces it).
    expect(full.gates).toBeUndefined()
    expect(full.enabled).toBeUndefined()
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

describe('seedPipelines — purpose classification is total and matches the engine guards', () => {
  it('classifies every built-in, so no preset falls through a narrowed picker', () => {
    // A pipeline with no `purpose` is UNCLASSIFIED, which every narrowed picker HIDES (the narrowing
    // requires the explicit classifier rather than guessing). So an unclassified built-in is
    // invisible on a document / review / feature / bug task — silently, with nothing failing.
    for (const p of seedPipelines()) {
      expect(p.purpose, `${p.id} must declare a purpose`).toBeDefined()
    }
  })

  it('pins purpose:planning against the engine’s initiative-KIND guard', () => {
    // The SPA hides planning pipelines from ordinary blocks by `purpose`, because it cannot see the
    // kernel's agent-kind vocabulary; the engine refuses them by KIND
    // (`assertInitiativeShapeAllowed`). Two classifiers deciding one question drift, and the failure
    // is asymmetric: a planning preset misclassified as `build` is offered on a task and then 409s,
    // while a build preset misclassified as `planning` vanishes from every picker. Pinned here for
    // the built-in catalog, which is the set both rules actually have to agree on.
    //
    // A `public` pipeline is EXEMPT, and `pl_initiative_breakdown` is why the exemption exists: it
    // plans (so `purpose: 'planning'` is honest about what it does) but runs INLINE and headless off
    // a public-API call, carrying none of the initiative kinds and therefore binding to no block
    // level. "Plans things" and "may only run on an initiative block" are genuinely two properties,
    // and this is the one pipeline where they come apart.
    for (const p of seedPipelines()) {
      if (p.public) {
        expect(hasInitiativeKinds(p.agentKinds), `${p.id} is API-invoked, not block-bound`).toBe(
          false,
        )
        continue
      }
      expect(p.purpose === 'planning', `${p.id} purpose vs initiative kinds`).toBe(
        hasInitiativeKinds(p.agentKinds),
      )
    }
  })

  it('offers a programmatic task the build ladder and nothing that cannot ship code', () => {
    const offered = (taskType: 'feature' | 'bug' | 'document' | 'review') =>
      seedPipelines()
        .filter((p) => pipelineAllowedForTaskType(p, taskType))
        .filter((p) => pipelineAllowedForBlockLevel(p, 'task'))
        .map((p) => p.id)

    const forFeature = offered('feature')
    // The ladder plus the bug/ralph presets are all reachable...
    for (const id of ['pl_build', 'pl_simple', 'pl_full', 'pl_bugfix', 'pl_ralph']) {
      expect(forFeature, `${id} must be offered on a feature task`).toContain(id)
    }
    // ...and the presets that cannot ship code are not. `pl_initiative*` are the ones the engine
    // used to refuse AFTER the user picked them.
    for (const id of [
      'pl_document',
      'pl_document_quick',
      'pl_business_docs',
      'pl_review',
      'pl_initiative',
      'pl_initiative_docs',
      'pl_initiative_breakdown',
    ]) {
      expect(forFeature, `${id} must not be offered on a feature task`).not.toContain(id)
    }
    // A `bug` task gets the same set as a feature (both ship code).
    expect(offered('bug')).toEqual(forFeature)
    // The pre-existing narrowings still hold, and stay disjoint from the programmatic set.
    expect(offered('document')).toEqual(['pl_document', 'pl_document_quick', 'pl_business_docs'])
    expect(offered('review')).toEqual(['pl_review'])
  })

  it('offers an initiative block only the planning presets, and vice versa', () => {
    const onInitiative = seedPipelines()
      .filter((p) => pipelineAllowedForBlockLevel(p, 'initiative'))
      .map((p) => p.id)
    // `pl_initiative_breakdown` is in this set by purpose but is API-invoked and block-agnostic, so
    // it is the one entry the engine would still refuse here. Harmless today (an initiative block
    // drives planning through its own flow, not the generic Run menu) and removed for real when the
    // platform-invoked presets get `availability: 'system'` — WS5 of the catalog-collapse tracker.
    expect(onInitiative).toEqual(['pl_initiative', 'pl_initiative_docs', 'pl_initiative_breakdown'])
    // Bidirectional, mirroring the engine guard: no planning preset is offered on a frame/module
    // either, not just on a task.
    for (const level of ['task', 'frame', 'module'] as const) {
      const ids = seedPipelines()
        .filter((p) => pipelineAllowedForBlockLevel(p, level))
        .map((p) => p.id)
      expect(ids, `planning presets must be hidden on a ${level}`).not.toContain('pl_initiative')
    }
  })
})
