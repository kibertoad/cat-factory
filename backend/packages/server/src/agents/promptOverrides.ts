import type { AgentKind, AgentRunContext } from '@cat-factory/kernel'
import { type AgentKindRegistry, baseSystemPromptFor, systemPromptFor } from '@cat-factory/agents'
import { MERGER_AGENT_KIND, ON_CALL_AGENT_KIND } from '@cat-factory/orchestration'
import { MERGER_SYSTEM_PROMPT, ON_CALL_SYSTEM_PROMPT } from './prompts.js'

// Per-workspace agent prompt overrides, container side.
//
// A workspace can replace an agent kind's system prompt from the pipeline builder; the engine
// resolves the live override once per dispatch onto `AgentRunContext.systemPromptOverride`,
// and every executor has to honour it. The inline and consensus executors do that by passing
// it straight to `systemPromptFor`'s `override` parameter. The CONTAINER dispatch needs this
// module because two kinds bypass `systemPromptFor` entirely.

/**
 * The kinds whose container dispatch deliberately sends a bespoke prompt instead of the kind's
 * role text (both return a strict JSON assessment whose contract is stated in that prompt).
 *
 * Named here rather than left inline at the two dispatch sites so the prompt EDITOR and the
 * DISPATCH agree on what "the built-in prompt for this kind" is. With the constants only
 * inlined, an editor built on `systemPromptFor` would show a merger's thin one-line role as
 * the baseline while the container actually ran this text — so "restore the built-in" would
 * restore something that was never running, and a diff against the baseline would be noise.
 */
export const BESPOKE_CONTAINER_SYSTEM_PROMPTS: Partial<Record<AgentKind, string>> = {
  [MERGER_AGENT_KIND]: MERGER_SYSTEM_PROMPT,
  [ON_CALL_AGENT_KIND]: ON_CALL_SYSTEM_PROMPT,
}

/**
 * The SHIPPED prompt for a kind — what an override replaces, and what the editor shows as the
 * baseline to diff against and restore to.
 *
 * It excludes the surface directives and trait guidance `systemPromptFor` layers on, because
 * those are invariants of how the platform runs the kind (a read-only kind must not edit; a
 * reasoning kind's answer must land in its visible reply) rather than editorial content. They
 * are re-applied on top of an override, so handing them to an editor would only let someone
 * delete something that comes back anyway — or, worse, duplicate it on save.
 */
export function builtInBaseSystemPrompt(kind: AgentKind, registry: AgentKindRegistry): string {
  return BESPOKE_CONTAINER_SYSTEM_PROMPTS[kind] ?? baseSystemPromptFor(kind, registry)
}

/**
 * The base system prompt for one container dispatch, honouring the workspace's override.
 *
 * A bespoke-prompt kind takes the override in place of its constant with nothing appended —
 * its dispatch never went through `systemPromptFor`, so adding the directives here would
 * change what those two kinds send. Every other kind goes through `systemPromptFor`, which
 * re-applies the engine-enforced directives on top of the override.
 */
export function dispatchSystemPromptFor(
  context: AgentRunContext,
  registry: AgentKindRegistry,
): string {
  const bespoke = BESPOKE_CONTAINER_SYSTEM_PROMPTS[context.agentKind]
  if (bespoke) return context.systemPromptOverride ?? bespoke
  return systemPromptFor(context.agentKind, registry, context.systemPromptOverride)
}
