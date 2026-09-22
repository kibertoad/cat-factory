import {
  NUXT_UI_SKILL_ID,
  NUXT_UI_TOOL_SERVER_ID,
  defaultAgentKindRegistry,
} from '@cat-factory/agents'
import { describe, expect, it } from 'vitest'
import { resolveNodeAppRegistries } from '../src/container-foundation.js'

// ---------------------------------------------------------------------------
// The Nuxt UI capability opt-in on the Node facade's OWN default registry (issue #2262).
//
// The conformance suites build a registry and call `registerNuxtUiCapability` themselves, then
// inject it, so they never exercise this facade's `if (!options.agentKindRegistry)` line. Delete it
// and every conformance test stays green while every real Node/local deployment ships a coder with
// no Nuxt UI skill or MCP server. `resolveNodeAppRegistries` is pure (no DB), and both the Postgres
// and mothership boot paths route their registry default through it, so this covers the local
// facade too.
// ---------------------------------------------------------------------------

describe('resolveNodeAppRegistries and the Nuxt UI capability', () => {
  it('opts the override-less default into the capability on the coder kinds', () => {
    const { agentKindRegistry } = resolveNodeAppRegistries({})
    expect(agentKindRegistry.skillsFor('coder').bundled.map((s) => s.id)).toContain(
      NUXT_UI_SKILL_ID,
    )
    expect(agentKindRegistry.toolServersFor('coder').servers.map((s) => s.id)).toContain(
      NUXT_UI_TOOL_SERVER_ID,
    )
  })

  it('leaves an injected agent-kind registry untouched, so a deployment owns its wiring', () => {
    const injected = defaultAgentKindRegistry()
    const { agentKindRegistry } = resolveNodeAppRegistries({ agentKindRegistry: injected })
    expect(agentKindRegistry).toBe(injected)
    expect(agentKindRegistry.skillsFor('coder').bundled.map((s) => s.id)).not.toContain(
      NUXT_UI_SKILL_ID,
    )
  })
})
