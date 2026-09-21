import type { AgentKind, McpServerDefinition } from '@cat-factory/kernel'
import { CI_FIXER_AGENT_KIND, FIXER_AGENT_KIND } from '@cat-factory/kernel'
import type { BundledSkillDefinition } from '../capabilities.js'
import type { AgentKindRegistry } from '../registry.js'
import { IMPLEMENTER_AGENT_KIND } from '../built-in-container.js'
import {
  NUXT_UI_SKILL_DESCRIPTION,
  NUXT_UI_SKILL_INSTRUCTIONS,
  NUXT_UI_SKILL_NAME,
  NUXT_UI_SKILL_RESOURCES,
} from './skill.generated.js'

// ---------------------------------------------------------------------------
// The Nuxt UI capability: the vendored `nuxt-ui` skill (a bundled playbook, ADR 0029) and the
// `nuxt-ui` MCP tool server, attached to the coder kinds that AUTHOR or REPAIR SPA source.
//
// This is a DEPLOYMENT capability, not a framework default: `defaultAgentKindRegistry()` stays
// stack-agnostic, and cat-factory's own facades opt in through `registerNuxtUiCapability`. A
// deployment whose repos are not Vue/Nuxt gets neither the playbook nor a tool server pointing at
// `ui.nuxt.com`. The skill text is the vendored `.claude/skills/nuxt-ui/` tree, inlined by
// `scripts/generate-nuxt-ui-skill.mjs` so the platform's own coder agents apply the same rules a
// local Claude Code session does, with no second hand-maintained copy.
// ---------------------------------------------------------------------------

/** The registered id of the bundled Nuxt UI skill. */
export const NUXT_UI_SKILL_ID = 'nuxt-ui'

/** The registered id of the Nuxt UI MCP tool server (becomes `mcp__nuxt-ui__*` at the CLI). */
export const NUXT_UI_TOOL_SERVER_ID = 'nuxt-ui'

/**
 * The coder kinds that get the Nuxt UI capability: the implementer plus the two fixers that edit
 * implementation code when tests or CI fail. Test/merge kinds (`playwright`, `tester-ui`,
 * `mocker`, `conflict-resolver`, `merger`) do not author components and are left out.
 */
export const NUXT_UI_CAPABILITY_KINDS: readonly AgentKind[] = [
  IMPLEMENTER_AGENT_KIND,
  FIXER_AGENT_KIND,
  CI_FIXER_AGENT_KIND,
]

/** The bundled Nuxt UI skill, built from the vendored `.claude/skills/nuxt-ui/` tree. */
export const nuxtUiSkill: BundledSkillDefinition = {
  id: NUXT_UI_SKILL_ID,
  name: NUXT_UI_SKILL_NAME,
  description: NUXT_UI_SKILL_DESCRIPTION,
  instructions: NUXT_UI_SKILL_INSTRUCTIONS,
  resources: NUXT_UI_SKILL_RESOURCES,
}

/**
 * The Nuxt UI MCP tool server: a public, credential-free HTTPS endpoint that serves component
 * props, slots, events and examples. `claude-code` only, because it is HTTP and Codex's MCP client
 * is stdio-only (Pi has none): a run on either drops the server with a stated reason rather than
 * being told about a tool its CLI cannot call.
 */
export const nuxtUiToolServer: McpServerDefinition = {
  id: NUXT_UI_TOOL_SERVER_ID,
  label: 'Nuxt UI',
  guidance:
    'Look up a @nuxt/ui component’s real props, slots, events and examples with search-components / ' +
    'get-component before writing it, instead of guessing the API from the component name.',
  transport: { kind: 'http', url: 'https://ui.nuxt.com/mcp' },
  harnesses: ['claude-code'],
}

/**
 * Attach the Nuxt UI skill and MCP tool server to the coder kinds ({@link NUXT_UI_CAPABILITY_KINDS}).
 * A deployment's facade calls this on the agent-kind registry it runs the engine with. Idempotent:
 * re-registration replaces by id and the assigned refs dedup at resolution.
 */
export function registerNuxtUiCapability(registry: AgentKindRegistry): void {
  registry.registerSkill(nuxtUiSkill)
  registry.registerToolServer(nuxtUiToolServer)
  for (const kind of NUXT_UI_CAPABILITY_KINDS) {
    registry.assignSkills(kind, [NUXT_UI_SKILL_ID])
    registry.assignToolServers(kind, [NUXT_UI_TOOL_SERVER_ID])
  }
}
