import {
  NUXT_UI_SKILL_ID,
  NUXT_UI_TOOL_SERVER_ID,
  defaultAgentKindRegistry,
} from '@cat-factory/agents'
import { describe, expect, it } from 'vitest'
import { resolveEntryRegistries } from '../src/index'
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

  it('opts the override-less buildContainer default into the Nuxt UI capability', () => {
    // The durable driver builds `buildContainer(env)` with no overrides, so this resolver mints the
    // facade's own default. Issue #2262.
    const { agentKindRegistry } = resolveWorkerRegistries({})
    expect(agentKindRegistry.skillsFor('coder').bundled.map((s) => s.id)).toContain(
      NUXT_UI_SKILL_ID,
    )
    expect(agentKindRegistry.toolServersFor('coder').servers.map((s) => s.id)).toContain(
      NUXT_UI_TOOL_SERVER_ID,
    )
  })

  it('opts the ENTRY-POINT default into the capability too, so the request path agrees', () => {
    // The bug the review caught: `createWorker` spreads `resolveEntryRegistries`'s result into the
    // overrides every request-path container is built from, so `resolveWorkerRegistries` never sees
    // an empty `agentKindRegistry` on that path. Boot validation and `GET /internal/agent-kinds`
    // read THIS instance, so defaulting only in `resolveWorkerRegistries` left the request path
    // (and every mothership node) with a coder that had no skill or MCP server while the durable
    // driver's bare-`buildContainer` coder did. Both must default through the same helper.
    const { agentKindRegistry } = resolveEntryRegistries({})
    expect(agentKindRegistry.skillsFor('coder').bundled.map((s) => s.id)).toContain(
      NUXT_UI_SKILL_ID,
    )
    expect(agentKindRegistry.toolServersFor('coder').servers.map((s) => s.id)).toContain(
      NUXT_UI_TOOL_SERVER_ID,
    )
  })

  it('lets an injected agent-kind registry win on both entry point and builder', () => {
    // The opt-in boundary: a deployment that injects its own registry gets exactly what it
    // registered, not our Nuxt UI capability layered on silently, at either resolution point.
    const injected = defaultAgentKindRegistry()
    expect(resolveEntryRegistries({ agentKindRegistry: injected }).agentKindRegistry).toBe(injected)
    const { agentKindRegistry } = resolveWorkerRegistries({ agentKindRegistry: injected })
    expect(agentKindRegistry).toBe(injected)
    expect(agentKindRegistry.skillsFor('coder').bundled.map((s) => s.id)).not.toContain(
      NUXT_UI_SKILL_ID,
    )
  })
})
