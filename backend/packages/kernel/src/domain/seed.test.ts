import { describe, expect, it } from 'vitest'
import { seedPipelines } from './seed.js'

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

  it('lowers pl_full: human gates + opt-in brainstorms land on the named steps', () => {
    const full = byId().get('pl_full')!
    expect(full.version).toBe(2)
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
