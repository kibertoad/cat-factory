import {
  NUXT_UI_SKILL_ID,
  NUXT_UI_TOOL_SERVER_ID,
  defaultAgentKindRegistry,
} from '@cat-factory/agents'
import { describe, expect, it } from 'vitest'
import { resolveWorkerRegistries } from '../src/infrastructure/container-registries'

// ---------------------------------------------------------------------------
// The registries a container built with NO overrides must still carry.
//
// `createWorker` resolves the app-owned registries at the entry point and threads them in as
// overrides, so a deployment's instance always wins. But that is not the only way a container is
// built on this runtime: a cron sweep, a Workflow step and a Durable Object each call
// `buildContainer(env)` directly, with no overrides at all. A registry whose built-ins are
// defaulted only at the entry point is therefore EMPTY on exactly the paths nobody is watching,
// and empty is not an error anywhere — the run just folds no standards and completes.
//
// That is how the prompt-fragment registry shipped: defaulted in `resolveEntryRegistries`, absent
// here, so the engine advanced every re-driven run against an empty pool. So the assertion is on
// `resolveWorkerRegistries({})` (what the override-less builder resolves) rather than on the
// entry point, which cannot see the gap.
// ---------------------------------------------------------------------------

describe('resolveWorkerRegistries with no overrides', () => {
  it('carries the shipped prompt-fragment catalog, not an empty pool', () => {
    const { promptFragmentRegistry } = resolveWorkerRegistries({})

    // A relation over a catalog this test does not own: any shipped fragment proves the built-ins
    // were installed, where a count would fail on every ordinary addition to the catalog.
    expect(promptFragmentRegistry.all().length).toBeGreaterThan(0)
    expect(promptFragmentRegistry.get('node.performance')).toBeDefined()
    expect(promptFragmentRegistry.taskTypesWithDefaults().length).toBeGreaterThan(0)
  })

  it('carries the built-in gate suite, the sibling this default is modelled on', () => {
    // Named beside it so the two read as one rule rather than a fix and a precedent.
    expect(resolveWorkerRegistries({}).gateRegistry.factories().length).toBeGreaterThan(0)
  })

  it('lets an injected registry win, so the default is a fallback and never a merge', () => {
    const { promptFragmentRegistry } = resolveWorkerRegistries({})
    const injected = resolveWorkerRegistries({ promptFragmentRegistry })

    expect(injected.promptFragmentRegistry).toBe(promptFragmentRegistry)
  })

  it('opts the override-less default into the Nuxt UI capability on the coder kinds', () => {
    // The behaviour the facade actually ships (issue #2262): `resolveWorkerRegistries` opts its OWN
    // default into `registerNuxtUiCapability`. Conformance builds its own registry and calls the
    // helper directly, so it never exercises THIS line — delete it and every conformance test still
    // passes while every deployment ships a coder with no Nuxt UI skill or MCP server.
    const { agentKindRegistry } = resolveWorkerRegistries({})
    expect(agentKindRegistry.skillsFor('coder').bundled.map((s) => s.id)).toContain(
      NUXT_UI_SKILL_ID,
    )
    expect(agentKindRegistry.toolServersFor('coder').servers.map((s) => s.id)).toContain(
      NUXT_UI_TOOL_SERVER_ID,
    )
  })

  it('leaves an injected agent-kind registry untouched, so a deployment owns its wiring', () => {
    // The opt-in boundary: a deployment that injects its own registry gets exactly what it
    // registered, not our Nuxt UI capability layered on silently.
    const injected = defaultAgentKindRegistry()
    const { agentKindRegistry } = resolveWorkerRegistries({ agentKindRegistry: injected })
    expect(agentKindRegistry).toBe(injected)
    expect(agentKindRegistry.skillsFor('coder').bundled.map((s) => s.id)).not.toContain(
      NUXT_UI_SKILL_ID,
    )
  })
})
