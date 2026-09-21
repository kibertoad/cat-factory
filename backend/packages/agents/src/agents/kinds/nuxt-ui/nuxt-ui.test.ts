import { isAllowedMcpHttpUrl, isValidMcpServerId } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import { defaultAgentKindRegistry } from '../registry.js'
import {
  NUXT_UI_CAPABILITY_KINDS,
  NUXT_UI_SKILL_ID,
  NUXT_UI_TOOL_SERVER_ID,
  nuxtUiSkill,
  nuxtUiToolServer,
  registerNuxtUiCapability,
} from './index.js'

describe('nuxt-ui capability', () => {
  it('is NOT in the framework default (opt-in per deployment)', () => {
    // The framework default stays stack-agnostic: a deployment whose repos are not Nuxt must not
    // inherit the playbook or an MCP server pointing at ui.nuxt.com. A facade opts in explicitly.
    const registry = defaultAgentKindRegistry()
    expect(registry.bundledSkill(NUXT_UI_SKILL_ID)).toBeUndefined()
    expect(registry.toolServerDefinition(NUXT_UI_TOOL_SERVER_ID)).toBeUndefined()
    expect(registry.toolServersFor('coder').servers).toEqual([])
  })

  it('attaches the skill and MCP server to every coder kind it targets', () => {
    const registry = defaultAgentKindRegistry()
    registerNuxtUiCapability(registry)

    expect(NUXT_UI_CAPABILITY_KINDS).toEqual(['coder', 'fixer', 'ci-fixer'])
    for (const kind of NUXT_UI_CAPABILITY_KINDS) {
      const skills = registry.skillsFor(kind)
      expect(skills.unknown).toEqual([])
      expect(skills.bundled.map((s) => s.id)).toContain(NUXT_UI_SKILL_ID)

      const tools = registry.toolServersFor(kind)
      expect(tools.unknown).toEqual([])
      expect(tools.servers.map((s) => s.id)).toContain(NUXT_UI_TOOL_SERVER_ID)
    }
    // A kind that only tests or merges does not author components, so it gets neither.
    expect(registry.skillsFor('tester-ui').bundled.map((s) => s.id)).not.toContain(NUXT_UI_SKILL_ID)
  })

  it('carries the vendored skill text and a dispatchable, credential-free MCP definition', () => {
    // The instructions are the vendored SKILL.md body verbatim (the generated module), so this is a
    // sanity check that generation ran, not a second copy of the text. Drift is guarded by
    // `scripts/generate-nuxt-ui-skill.mjs --check` in CI.
    expect(nuxtUiSkill.name).toBe('nuxt-ui')
    expect(nuxtUiSkill.instructions).toContain('# Nuxt UI')
    expect(nuxtUiSkill.resources?.some((r) => r.relPath === 'references/components.md')).toBe(true)

    expect(isValidMcpServerId(nuxtUiToolServer.id)).toBe(true)
    expect(nuxtUiToolServer.transport.kind).toBe('http')
    if (nuxtUiToolServer.transport.kind === 'http') {
      expect(isAllowedMcpHttpUrl(nuxtUiToolServer.transport.url)).toBe(true)
    }
    // Public endpoint: no credential to resolve, so nothing lands in the operator's checklist.
    expect(nuxtUiToolServer.secretKeys).toBeUndefined()
    // HTTP, so Codex (stdio-only) and Pi (no MCP) drop it with a stated reason rather than being
    // told about a tool their CLI cannot call.
    expect(nuxtUiToolServer.harnesses).toEqual(['claude-code'])
  })

  it('is idempotent across repeated registration', () => {
    const registry = defaultAgentKindRegistry()
    registerNuxtUiCapability(registry)
    registerNuxtUiCapability(registry)
    expect(
      registry.skillsFor('coder').bundled.filter((s) => s.id === NUXT_UI_SKILL_ID),
    ).toHaveLength(1)
    expect(
      registry.toolServersFor('coder').servers.filter((s) => s.id === NUXT_UI_TOOL_SERVER_ID),
    ).toHaveLength(1)
  })
})
