import type { AgentKind, AgentRunContext } from '@cat-factory/kernel'
import {
  type AgentKindRegistry,
  appendedDirectivesFor,
  BESPOKE_SYSTEM_PROMPTS,
  composedSystemPromptFor,
  containerDispatchDirectivesFor,
} from '@cat-factory/agents'

// Per-workspace agent prompt overrides, container side.
//
// A workspace can replace an agent kind's system prompt from the pipeline builder; the engine
// resolves the live override once per dispatch onto `AgentRunContext.systemPromptOverride`,
// and every executor has to honour it. The inline and consensus executors do that by passing
// it straight to `systemPromptFor`'s `override` parameter. This module exists for the kinds that
// bypass `systemPromptFor` entirely: two container kinds (`merger`, `on-call`) and the inline
// ENGINE steps that `IterativeReviewService` drives as bare `generateText` calls.
//
// The property this module exists to hold, on BOTH paths: an override replaces what an agent is
// TOLD TO BE, never how the platform RUNS it. On the `systemPromptFor` path that separation is
// `applySurfaceDirectives`; the bespoke kinds have no such seam, so their constants are split
// into the two halves here instead.
//
// A registered agent-kind VARIANT's alternate prompt arrives through the SAME field, already
// resolved by the engine (see `applyAgentVariant`), so nothing here branches on it — which is
// the point of routing a variant through this seam rather than giving it one of its own.

// The bespoke-prompt map (`BESPOKE_SYSTEM_PROMPTS`) and the "shipped base prompt" resolver
// (`shippedBasePromptFor` — what the editor shows as the built-in baseline) live in
// `@cat-factory/agents`, because the ENGINE resolves a registered VARIANT's alternate prompt
// against that same base and sits below this layer. Import them from there, not from here.

/**
 * The text the platform appends to whatever a workspace saves for a kind, so the editor can SHOW
 * it rather than describe it in prose that drifts out of step with the code.
 *
 * The generic measurement lives in `@cat-factory/agents` (`appendedDirectivesFor`) so the sandbox
 * -- which composes a candidate exactly as production composes an override -- can reach it without
 * depending on this layer. All this adds is the two bespoke kinds, whose directives are DECLARED
 * rather than measured because their dispatch never goes through `systemPromptFor` at all: they
 * still ride the container-dispatch chokepoint, so its directives join theirs the same way
 * `appendedDirectivesFor` folds them onto a measured kind's.
 */
export function builtInDirectivesFor(kind: AgentKind, registry: AgentKindRegistry): string {
  const bespoke = BESPOKE_SYSTEM_PROMPTS[kind]?.directives
  return bespoke === undefined
    ? appendedDirectivesFor(kind, registry)
    : `${bespoke}${containerDispatchDirectivesFor(kind, registry)}`
}

/**
 * The base system prompt for one container dispatch, honouring the workspace's override.
 *
 * All this adds to `composedSystemPromptFor` is reading the override off the run context: the
 * bespoke-vs-composed branch itself lives in `@cat-factory/agents`, because the Sandbox run-driver
 * needs the same answer for a graded candidate and sits below this layer.
 */
export function dispatchSystemPromptFor(
  context: AgentRunContext,
  registry: AgentKindRegistry,
): string {
  return composedSystemPromptFor(context.agentKind, registry, context.systemPromptOverride)
}
