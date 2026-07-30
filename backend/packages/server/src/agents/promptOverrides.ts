import type { AgentKind, AgentRunContext } from '@cat-factory/kernel'
import {
  type AgentKindRegistry,
  type BespokeSystemPrompt,
  appendedDirectivesFor,
  baseSystemPromptFor,
  composeBespokePrompt,
  INLINE_ENGINE_SYSTEM_PROMPTS,
  systemPromptFor,
} from '@cat-factory/agents'
import { MERGER_AGENT_KIND, ON_CALL_AGENT_KIND } from '@cat-factory/orchestration'
import {
  MERGER_DIRECTIVES,
  MERGER_ROLE_PROMPT,
  ON_CALL_DIRECTIVES,
  ON_CALL_ROLE_PROMPT,
} from './prompts.js'

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

/**
 * Every kind whose prompt is a bespoke constant rather than a `systemPromptFor` composition, keyed
 * by agent kind and SPLIT at the boundary an override may cross ({@link BespokeSystemPrompt}).
 *
 * Two families, for the same reason. The container kinds `merger` and `on-call` dispatch a bespoke
 * constant (both return a strict JSON assessment whose contract is stated in that prompt); the
 * inline ENGINE steps — the requirements + clarity reviewers, both brainstorm stages, their rework
 * editors and the Requirement Writer — are driven by `IterativeReviewService` as bare inline calls.
 * Neither family passes through `systemPromptFor`, so neither gets its override applied or its
 * invariants re-appended by that seam.
 *
 * Collected here so the prompt EDITOR and the RUN agree on what "the built-in prompt for this kind"
 * is. With the constants only inlined, an editor built on `systemPromptFor` showed the merger's thin
 * one-line role — and the requirements reviewer's `roles.ts` line — as the baseline while something
 * else entirely ran: "restore the built-in" restored a prompt that was never running, and a diff
 * against the baseline was noise.
 *
 * Adding another such kind means adding it here, SPLIT — a kind added with its directives inside
 * `role` compiles and runs fine, and fails only later, as a workspace that edited it loses its
 * guardrail or its JSON contract.
 */
export const BESPOKE_SYSTEM_PROMPTS: Partial<Record<AgentKind, BespokeSystemPrompt>> = {
  ...INLINE_ENGINE_SYSTEM_PROMPTS,
  [MERGER_AGENT_KIND]: { role: MERGER_ROLE_PROMPT, directives: MERGER_DIRECTIVES },
  [ON_CALL_AGENT_KIND]: { role: ON_CALL_ROLE_PROMPT, directives: ON_CALL_DIRECTIVES },
}

/**
 * The SHIPPED prompt for a kind — what an override replaces, and what the editor shows as the
 * baseline to diff against and restore to.
 *
 * It excludes the surface directives and trait guidance `systemPromptFor` layers on (and, for a
 * bespoke kind, its `directives` half), because those are invariants of how the platform runs
 * the kind (a read-only kind must not edit; a reasoning kind's answer must land in its visible
 * reply) rather than editorial content. They are re-applied on top of an override, so handing
 * them to an editor would only let someone delete something that comes back anyway — or, worse,
 * duplicate it on save.
 */
export function builtInBaseSystemPrompt(kind: AgentKind, registry: AgentKindRegistry): string {
  return BESPOKE_SYSTEM_PROMPTS[kind]?.role ?? baseSystemPromptFor(kind, registry)
}

/**
 * The text the platform appends to whatever a workspace saves for a kind, so the editor can SHOW
 * it rather than describe it in prose that drifts out of step with the code.
 *
 * The generic measurement lives in `@cat-factory/agents` (`appendedDirectivesFor`) so the sandbox
 * -- which composes a candidate exactly as production composes an override -- can reach it without
 * depending on this layer. All this adds is the two bespoke kinds, whose directives are DECLARED
 * rather than measured because their dispatch never goes through `systemPromptFor` at all.
 */
export function builtInDirectivesFor(kind: AgentKind, registry: AgentKindRegistry): string {
  return BESPOKE_SYSTEM_PROMPTS[kind]?.directives ?? appendedDirectivesFor(kind, registry)
}

/**
 * The base system prompt for one container dispatch, honouring the workspace's override.
 *
 * A bespoke-prompt kind takes the override in place of its ROLE half and keeps its directives;
 * every other kind goes through `systemPromptFor`, which re-applies the engine-enforced
 * directives on top of the override. Either way an unedited kind sends byte-for-byte what it
 * sent before, and an edited one keeps the invariants it is run under.
 */
export function dispatchSystemPromptFor(
  context: AgentRunContext,
  registry: AgentKindRegistry,
): string {
  const bespoke = BESPOKE_SYSTEM_PROMPTS[context.agentKind]
  if (bespoke) return composeBespokePrompt(bespoke, context.systemPromptOverride)
  return systemPromptFor(context.agentKind, registry, context.systemPromptOverride)
}
