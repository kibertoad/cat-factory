// A system prompt declared as a bespoke constant rather than composed by `systemPromptFor`,
// SPLIT at the boundary a per-workspace override may cross.
//
// Two families of kinds send such a constant: the inline engine steps driven by
// `IterativeReviewService` (the requirements + clarity reviewers, both brainstorm stages and
// their rework editors), and two container kinds (`merger`, `on-call`) whose dispatch bypasses
// `systemPromptFor`. Neither family has the `applySurfaceDirectives` seam that keeps an override
// from deleting a platform invariant, so their constants declare the two halves instead.

/**
 * A bespoke system prompt, split at the boundary an override may cross.
 *
 * The halves are declared apart rather than sliced out of one string because the split is a
 * JUDGEMENT about each sentence (is this what the agent is for, or how the platform parses it?),
 * not a lexical fact — and a slice offset would silently move the boundary the next time either
 * half is edited.
 */
export interface BespokeSystemPrompt {
  /** What the agent is FOR. Replaced wholesale by a workspace override. */
  role: string
  /**
   * What this kind DELIVERS, and therefore which invariants its {@link directives} half owes.
   *
   * - `'reply'`: the platform PARSES the visible reply (strict JSON, or a fixed-section
   *   document). The output contract is stated in the directives, so an override cannot leave the
   *   engine with nothing to parse.
   * - `'side-effect'`: the product is a pushed commit and the platform reads nothing back. Such
   *   a kind legitimately ends with no final text, which is why the answer-in-your-reply rule must
   *   NOT be appended to it (the same judgement `SIDE_EFFECT_ROLE_KINDS` records on the
   *   `roleSystemPrompt` path, for the same kinds of agent).
   *
   * DECLARED rather than read back out of the directives text. Every bespoke kind carried a
   * parsed output contract until the `deploy-fixer` arrived, and a suite that asserted the
   * contract of all of them then had two ways to accommodate it: exempt the one kind by name, or
   * quietly weaken the assertion for all of them. Both hide the next kind that should have had
   * one. With the answer declared, `promptOverrides.spec.ts` holds each half to its own bar and a
   * kind cannot be added without choosing.
   */
  product: 'reply' | 'side-effect'
  /**
   * What the platform DEPENDS on: the machine-parsed output contract, the answer-in-your-reply
   * rule, the read-only guardrail, the rules the engine enforces across a whole flow. Re-appended
   * on top of an override, so it cannot be edited away. Carries its own leading separator, exactly
   * as the appended directives do on the `systemPromptFor` path — so `role + directives` is the
   * shipped prompt byte for byte.
   */
  directives: string
}

/** Compose a bespoke prompt, honouring a workspace override of its role half. */
export function composeBespokePrompt(prompt: BespokeSystemPrompt, override?: string): string {
  return `${override ?? prompt.role}${prompt.directives}`
}
