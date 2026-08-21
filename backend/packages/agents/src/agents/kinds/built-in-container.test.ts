import { describe, expect, it } from 'vitest'
import { CI_FIXER_AGENT_KIND, CONFLICT_RESOLVER_AGENT_KIND } from '@cat-factory/kernel'
import { UI_TESTER_AGENT_KIND } from '@cat-factory/contracts'
import { defaultAgentKindRegistry } from './registry.js'
import { systemPromptFor } from '../catalog.js'
import { READ_ONLY_GUARDRAIL } from './read-only.js'
import {
  BUILT_IN_CONTAINER_AGENT_KINDS,
  IMPLEMENTER_AGENT_KIND,
  MERGER_AGENT_KIND,
  TESTER_AGENT_KIND,
} from './built-in-container.js'
import { TASK_REASSESSOR_AGENT_KIND, TRIAGE_JSON_CONTRACT } from '../prompts/roles.js'

// What finished the agent-kind strangler, asserted structurally rather than kind by kind: every
// container kind the platform ships is an ordinary registration, so the dispatch layer reads its
// shape off the same declaration a deployment's own kind makes. The per-kind BODIES are pinned by
// the executor's snapshot suite (`@cat-factory/server`'s `containerAgentJobBody.spec.ts`); what
// these pin is that the declarations exist and say what the engine relies on them saying.

const registry = defaultAgentKindRegistry()

describe('the built-in container kinds are ordinary registrations', () => {
  it('every one declares a container surface, so none falls back to the dispatch default', () => {
    // Derived from the catalog rather than re-listed: a kind added to it is covered here without
    // a second list to keep in step, which is the property the deleted hard-coded Sets lacked.
    for (const definition of BUILT_IN_CONTAINER_AGENT_KINDS) {
      const step = registry.agentStep(definition.kind)
      expect(step?.surface, `${definition.kind} declares no agent step`).toMatch(/^container-/)
      expect(registry.requiresContainer(definition.kind)).toBe(true)
    }
  })

  it('declares no presentation, so a built-in is not listed twice in the palette', () => {
    // `presentation` is what promotes a REGISTERED kind into the SPA's palette
    // (`snapshotCustomAgentKinds` filters on it). These kinds are already first-class in the
    // SPA's own catalog, so declaring it here would list each of them a second time.
    for (const definition of BUILT_IN_CONTAINER_AGENT_KINDS) {
      expect(definition.presentation, `${definition.kind} declares presentation`).toBeUndefined()
    }
  })

  it('declares no systemPrompt, leaving the shipped track prompt the single source of truth', () => {
    // Each of these kinds already has a prompt owner further up `baseSystemPromptFor` (a standard
    // phase, the tester/fixer track, or a bespoke role/directives split). A copy on the definition
    // would be dead text the day the track's wording moved.
    for (const definition of BUILT_IN_CONTAINER_AGENT_KINDS) {
      expect(definition.systemPrompt, `${definition.kind} restates a prompt`).toBeUndefined()
      expect(registry.systemPrompt(definition.kind)).toBeUndefined()
    }
  })
})

describe('the declarations the engine relies on', () => {
  it('gives the in-place fixers a PR precondition rather than a base-branch fallback', () => {
    // Without a PR there is nothing to fix, and the generic `pr`-clone fallback would push the
    // fixer's commits onto the default branch.
    for (const kind of [CI_FIXER_AGENT_KIND, CONFLICT_RESOLVER_AGENT_KIND]) {
      expect(registry.agentStep(kind)?.clone).toMatchObject({ branch: 'pr', requirePr: true })
    }
  })

  it('lets the conflict-resolver fall back to the shared work branch, but never to base', () => {
    // The peer-conflict case: the OWN service had no change (so no own pull request) while a PEER
    // repo did, and the branch to resolve on is the shared per-task work branch every PR rides.
    expect(registry.agentStep(CONFLICT_RESOLVER_AGENT_KIND)?.clone).toMatchObject({
      prFallback: 'work',
      mergeBase: true,
    })
  })

  it('fans the implementer and the CI-fixer out across peer repos, and nothing else', () => {
    // Red CI on a multi-repo task is routinely a cross-repo contract break. The conflict-resolver
    // deliberately stays single-repo: a git conflict is per-repo textual.
    const fansOut = BUILT_IN_CONTAINER_AGENT_KINDS.filter((d) =>
      registry.fansOutMultiRepo(d.kind),
    ).map((d) => d.kind)
    expect(fansOut.sort()).toEqual([CI_FIXER_AGENT_KIND, IMPLEMENTER_AGENT_KIND].sort())
  })

  it('routes only the browser-driven tester to the UI image', () => {
    const uiImage = BUILT_IN_CONTAINER_AGENT_KINDS.filter(
      (d) => registry.agentStep(d.kind)?.image === 'ui',
    ).map((d) => d.kind)
    expect(uiImage).toEqual([UI_TESTER_AGENT_KIND])
  })

  it('withholds the read-only guardrail from the testers, which write in their own tree', () => {
    // An explore surface means "never pushes", not "never writes": a tester installs dependencies
    // and runs a suite. Telling it that it must not create files reads as a refusal to run at all.
    for (const kind of [TESTER_AGENT_KIND, UI_TESTER_AGENT_KIND]) {
      expect(registry.agentStep(kind)?.localWrites).toBe(true)
      expect(systemPromptFor(kind, registry)).not.toContain(READ_ONLY_GUARDRAIL)
    }
    // …while an explore kind that only reads still gets it.
    expect(systemPromptFor('architect', registry)).toContain(READ_ONLY_GUARDRAIL)
  })

  it('gives the merger no standards at all — it judges a diff, it does not write one', () => {
    expect(registry.standardsDelivery(MERGER_AGENT_KIND)).toBe('none')
  })

  it('gives the task-reassessor a PR precondition and the prefetched head, never a base fallback', () => {
    // Its whole job is the change a pull request carries: with none there is nothing to measure,
    // and a base checkout scored as though it were the change is the failure a silent fallback
    // produces. `prHead` rather than a `pr` clone because the branch is deleted once the PR
    // merges, while `refs/pull/<n>/head` stays fetchable.
    expect(registry.agentStep(TASK_REASSESSOR_AGENT_KIND)?.clone).toMatchObject({
      branch: 'base',
      full: true,
      prHead: true,
      requirePr: true,
    })
  })

  it('keeps the reassessor free of the engine channels its neighbours declare', () => {
    // The merger and the on-call agent map their reply onto a channel the engine ACTS on, which is
    // why an unreadable one defaults conservatively. This kind only RECORDS, so the cautious
    // reading of an unreadable assessment is to record nothing: its resolver reads the raw `custom`
    // and leaves the task's estimate alone. A mapper here would hand it a defaulted score to
    // persist as a measurement.
    expect(registry.mapStructuredResult(TASK_REASSESSOR_AGENT_KIND)).toBeUndefined()
    expect(registry.agentStep(TASK_REASSESSOR_AGENT_KIND)?.output?.kind).toBe('structured')
    expect(registry.standardsDelivery(TASK_REASSESSOR_AGENT_KIND)).toBe('none')
  })

  it('states the parsed JSON contract in the reassessor prompt, and keeps it under an override', () => {
    // The engine reads scores off this reply, and an estimate that fails to parse is SILENT (the
    // task simply keeps the estimate it had). The contract is a member of
    // `OVERRIDE_PRESERVED_FRAGMENTS`, so a workspace that rewrites the role text gets it back.
    expect(systemPromptFor(TASK_REASSESSOR_AGENT_KIND, registry)).toContain(TRIAGE_JSON_CONTRACT)
    expect(
      systemPromptFor(TASK_REASSESSOR_AGENT_KIND, registry, 'Score the diff however you like.'),
    ).toContain(TRIAGE_JSON_CONTRACT)
  })

  it('maps every assessment kind onto the engine channel that acts on it', () => {
    // An engine channel with no mapping is silent: the gate simply sees no assessment and the run
    // reads as a step that decided nothing.
    for (const kind of [MERGER_AGENT_KIND, TESTER_AGENT_KIND, UI_TESTER_AGENT_KIND]) {
      expect(registry.mapStructuredResult(kind), `${kind} maps no result`).toBeDefined()
    }
  })
})
