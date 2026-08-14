import type { AgentKind } from '@cat-factory/kernel'
import type { AgentKindRegistry } from '../kinds/registry.js'
import { baseSystemPromptFor } from '../catalog.js'
import type { BespokeSystemPrompt } from './bespoke.js'
import { INLINE_ENGINE_SYSTEM_PROMPTS } from './inline-engine.js'
import { DEPLOY_FIXER_DIRECTIVES, DEPLOY_FIXER_ROLE_PROMPT } from '../kinds/deploy-fixer.js'
import { FINAL_ANSWER_IN_REPLY } from './shared.js'

// The two bespoke CONTAINER prompts (`merger`, `on-call`) and the map that collects every kind
// whose prompt is a bespoke constant rather than a `systemPromptFor` composition.
//
// Each is declared as a ROLE half and a DIRECTIVES half rather than one string, because a
// workspace can replace the role from the pipeline builder (and a registered agent-kind VARIANT
// can replace it in code — see ../kinds/variants.ts). The directives half is what
// `applySurfaceDirectives` is for every other kind — the read-only guardrail, the machine-parsed
// output contract, and the answer-in-your-reply rule — so it must survive a replacement rather
// than be editable prose inside it. Each `*_DIRECTIVES` string CARRIES ITS OWN LEADING SEPARATOR,
// exactly as the appended directives do on the `systemPromptFor` path (where they are recovered
// by slicing the base off), so `role + directives` is the shipped prompt byte for byte.
// `promptOverrides.spec.ts` pins that.
//
// This lives in `@cat-factory/agents` rather than beside the container executor that dispatches
// the two kinds because the ENGINE needs the same answer: it resolves a variant's prompt against
// the SHIPPED base once per dispatch, and a bespoke kind's shipped base is its role half, not
// what `baseSystemPromptFor` would return. With the map in the HTTP layer the engine could only
// have guessed, and would have folded a variant's addition onto the wrong text for exactly the
// two kinds whose prompts carry a parsed output contract.

/**
 * The EDITABLE half of the `merger` prompt: what the agent is for. Replaced wholesale by a
 * workspace override, so it must carry no invariant the engine depends on.
 */
export const MERGER_ROLE_PROMPT =
  'You are a release manager assessing a pull request before merge. Inspect the ' +
  'change (the diff between the pull-request branch(es) and their base) and judge three axes, ' +
  'each as a number from 0 (trivial/safe) to 1 (severe): complexity (how intricate the ' +
  'change is), risk (how likely it is to break something), and impact (blast radius ' +
  'if it does). When the change spans several repositories, weigh the COMBINED cross-repo ' +
  'change as one and return a single assessment. Be conservative.'

/**
 * The NON-EDITABLE half: the JSON contract `resolveMergerStep` parses, and the rule that keeps a
 * reasoning model's answer out of its hidden channel. Re-appended on top of an override — an
 * override that could drop these fails the run in exactly the ways they exist to prevent (an
 * empty visible reply the harness reads as unusable; a merge decision with nothing to parse).
 */
export const MERGER_DIRECTIVES =
  ' Respond with ONLY a JSON ' +
  'object of shape {"complexity":0.0,"risk":0.0,"impact":0.0,"rationale":"…"} — no prose, ' +
  'no code fences. ' +
  FINAL_ANSWER_IN_REPLY

/** Role prompt the `merger` step runs under (scores the PR; returns JSON only). */
export const MERGER_SYSTEM_PROMPT = MERGER_ROLE_PROMPT + MERGER_DIRECTIVES

/**
 * The EDITABLE half of the `on-call` prompt: what the agent is investigating and how to weigh
 * it. Replaced wholesale by a workspace override — note that the read-only guardrail is
 * deliberately NOT here, since an on-call agent that could be told to commit is the specific
 * accident this split prevents.
 */
export const ON_CALL_ROLE_PROMPT =
  'You are an on-call engineer investigating a possible post-release regression. A ' +
  'recently merged pull request shipped, and the evidence below (alerting Datadog ' +
  'monitors/SLOs and recent error logs) suggests the service regressed afterward. Read ' +
  'the PR diff on the head branch and weigh whether THIS change is the likely cause — ' +
  'beware correlation vs causation; a coincident deploy is not proof.'

/**
 * The NON-EDITABLE half: the read-only guardrail (this kind investigates, a human decides
 * whether to revert — see `resolveOnCallStep`), the JSON contract the engine parses, and the
 * answer-in-your-reply rule. Re-appended on top of an override.
 */
export const ON_CALL_DIRECTIVES =
  ' You may read and ' +
  'inspect any file, but you MUST NOT modify, commit or revert anything; a human decides ' +
  'whether to revert. Respond with ONLY a JSON object of shape ' +
  '{"culpritConfidence":0.0,"recommendation":"revert"|"hold"|"monitor","rationale":"…",' +
  '"evidence":["…"]} — no prose, no code fences. ' +
  FINAL_ANSWER_IN_REPLY

/** Role prompt the `on-call` step runs under (investigates a regression; returns JSON only). */
export const ON_CALL_SYSTEM_PROMPT = ON_CALL_ROLE_PROMPT + ON_CALL_DIRECTIVES

/**
 * Every kind whose prompt is a bespoke constant rather than a `systemPromptFor` composition,
 * keyed by agent kind and SPLIT at the boundary a replacement may cross
 * ({@link BespokeSystemPrompt}).
 *
 * Two families, for the same reason. The container kinds `merger` and `on-call` dispatch a
 * bespoke constant (both return a strict JSON assessment whose contract is stated in that
 * prompt); the inline ENGINE steps — the requirements + clarity reviewers, both brainstorm
 * stages, their rework editors and the Requirement Writer — are driven by
 * `IterativeReviewService` as bare inline calls. Neither family passes through `systemPromptFor`,
 * so neither gets its override applied or its invariants re-appended by that seam.
 *
 * Collected here so the prompt EDITOR, the RUN and a code-registered VARIANT agree on what "the
 * built-in prompt for this kind" is. With the constants only inlined, an editor built on
 * `systemPromptFor` showed the merger's thin one-line role — and the requirements reviewer's
 * `roles.ts` line — as the baseline while something else entirely ran: "restore the built-in"
 * restored a prompt that was never running, and a diff against the baseline was noise.
 *
 * Adding another such kind means adding it here, SPLIT and with its `product` declared. A kind
 * added with its directives inside `role` compiles and runs fine, and fails only later, as a
 * workspace that edited it loses its guardrail or its JSON contract.
 *
 * The two container kind ids are bare literals: their canonical constants live in kernel
 * (`ON_CALL_AGENT_KIND`) and orchestration (`MERGER_AGENT_KIND`), and this package sits below
 * both. Pinned by `promptOverrides.spec.ts`, which resolves them through those constants.
 */
export const BESPOKE_SYSTEM_PROMPTS: Partial<Record<AgentKind, BespokeSystemPrompt>> = {
  ...INLINE_ENGINE_SYSTEM_PROMPTS,
  merger: { product: 'reply', role: MERGER_ROLE_PROMPT, directives: MERGER_DIRECTIVES },
  'on-call': { product: 'reply', role: ON_CALL_ROLE_PROMPT, directives: ON_CALL_DIRECTIVES },
  // The deploy-fixer's directives are its WRITE SCOPE (deployment description only, never CI
  // configuration) and the two repairs that look like progress and are not. Those are guardrails
  // on a machine-authored commit that a pipeline may then merge, not editorial content, so they
  // sit on the half a workspace override cannot delete.
  //
  // The FIRST bespoke kind whose product is a side effect: it has no verdict channel, so it owes
  // no output contract and must not carry the answer-in-your-reply rule. Its proof is the
  // re-provision, not anything it says (see `deploy-fixer.ts`).
  'deploy-fixer': {
    product: 'side-effect',
    role: DEPLOY_FIXER_ROLE_PROMPT,
    directives: DEPLOY_FIXER_DIRECTIVES,
  },
}

/**
 * The SHIPPED prompt for a kind — the unit a per-workspace override or a registered variant
 * REPLACES, and what the prompt editor shows as the baseline to diff against and restore to.
 *
 * It excludes the surface directives and trait guidance `systemPromptFor` layers on (and, for a
 * bespoke kind, its `directives` half), because those are invariants of how the platform runs
 * the kind (a read-only kind must not edit; a reasoning kind's answer must land in its visible
 * reply) rather than editorial content. They are re-applied on top of a replacement, so handing
 * them to an editor would only let someone delete something that comes back anyway — or, worse,
 * duplicate it on save.
 */
export function shippedBasePromptFor(kind: AgentKind, registry: AgentKindRegistry): string {
  return BESPOKE_SYSTEM_PROMPTS[kind]?.role ?? baseSystemPromptFor(kind, registry)
}
