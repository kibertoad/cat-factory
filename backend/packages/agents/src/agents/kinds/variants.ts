import { contentHash } from '@cat-factory/kernel'
import type { AgentKind } from '@cat-factory/kernel'

// ---------------------------------------------------------------------------
// Agent-kind VARIANTS — the same kind, told to be something else.
//
// A deployment routinely wants "the Coder, but TDD-first" or "the PR reviewer, but with our
// house security lens" without inventing a new agent kind. Registering a new kind is the wrong
// tool for that: a kind id is what every engine decision keys off (the harness dispatch shape,
// the read-only guardrail, companion targeting, gatability, the merger's terminal status, the
// SPA's palette + result view), and a brand-new id silently misses every one of those switches
// that has not been migrated to the registry yet. The failure mode is not a compile error — it is
// a run that dispatches down the generic path and quietly does the wrong thing.
//
// So a variant is deliberately NOT a kind. It is a per-step SELECTION of an alternate prompt for
// an existing kind, exactly as `stepOptions.skillId` is a per-step selection of which skill the
// one generic `skill` kind runs. The step still records the BASE kind, so every behavioural
// decision in the engine, the executor, the harness and the SPA is byte-for-byte what that kind
// always did; only the text the model is told to be changes. A variation that needs different
// BEHAVIOUR is a different kind and belongs on `AgentKindRegistry.register`.
//
// The prompt itself flows through the seam a per-workspace prompt override already uses
// (`AgentRunContext.systemPromptOverride`, resolved once per dispatch by the engine), so a
// variant inherits that seam's guarantees for free: the surface directives, the trait guidance
// and `restoreShippedInvariants` are all re-applied on top, and a variant can no more delete the
// read-only guardrail or the answer-in-your-reply rule than a workspace can.
// ---------------------------------------------------------------------------

/** How a variant is labelled wherever a step's agent kind is shown. */
export interface AgentKindVariantPresentation {
  /**
   * Short distinguishing name, shown BESIDE the base kind's own label (`Coder · TDD-first`)
   * rather than in place of it — the step really is a Coder step, and a label that hid that
   * would make the run harder to read, not easier.
   */
  label: string
  /** One sentence on what this variant changes, for the step-option picker's tooltip. */
  description?: string
}

/**
 * A registered variation of an existing agent kind: its alternate prompt plus the identity the
 * pipeline builder and the run views show it under.
 *
 * At least one of {@link systemPrompt} / {@link promptAddition} must be set — a variant that
 * changes no text is a step option with no effect, which boot validation reports rather than
 * letting it run as a silently ordinary step.
 */
export interface AgentKindVariantDefinition {
  /**
   * The variant id named by a step's `stepOptions.agentVariantId`. Free-form; namespace it the
   * way a deployment namespaces anything else it registers (`acme:coder-tdd`).
   */
  id: string
  /**
   * The EXISTING agent kind this varies. The step runs as this kind in every respect; the
   * variant supplies only its prompt. Boot validation refuses an unknown one.
   */
  baseKind: AgentKind
  /**
   * REPLACES the kind's shipped track prompt outright — for a variant whose role is genuinely
   * different prose, not a rider on the shipped one.
   *
   * Prefer {@link promptAddition} where it will do: a replacement is a copy of the shipped
   * prompt that stops tracking it the day the product edits it, which is the same staleness a
   * per-workspace override carries. What it CANNOT do is drop a platform invariant — those are
   * re-applied on top (see the file header).
   */
  systemPrompt?: string
  /**
   * APPENDED to whatever base prompt this dispatch runs under — the shipped one, this variant's
   * {@link systemPrompt}, or the workspace's own override of it. That is what makes an addition
   * the safe default: it steers the kind without forking its prompt, so both the product's edits
   * and a workspace's keep applying underneath.
   */
  promptAddition?: string
  /** Display metadata. Omitted ⇒ the SPA shows the variant's raw id. */
  presentation?: AgentKindVariantPresentation
}

/**
 * How much of what a selected variant declares actually reached the prompt a step ran under.
 *
 * A variant loses its `systemPrompt` to a workspace override, because the workspace is the
 * narrower tier — so "a variant was selected" and "the variant shaped this prompt" are different
 * facts, and a reader shown only the first would be told something untrue. The three losing
 * cases are kept APART rather than collapsed into one "didn't apply", because they need
 * different fixes: drop the workspace's edit, drop the variant's replacement in favour of an
 * addition, or re-register the variant.
 *
 * - `full` — everything the variant declares is in the effective prompt.
 * - `addition-only` — a workspace override displaced its `systemPrompt`; its `promptAddition`
 *   still folded on top.
 * - `superseded` — a workspace override displaced its `systemPrompt` and it had no addition, so
 *   nothing of it survives.
 * - `withdrawn` — the id the step names is not registered (resolved by the caller, which is the
 *   only place that knows the lookup failed).
 */
export type AgentVariantApplication = 'full' | 'addition-only' | 'superseded' | 'withdrawn'

/** The effective prompt for one dispatch plus what the variant contributed to it. */
export interface AppliedAgentVariant {
  /**
   * The effective system-prompt override, or undefined to run the shipped prompt — so an
   * unvaried, unedited step's dispatch is byte-for-byte what it always sent, the same
   * "absent ⇒ shipped" contract `AgentRunContext.systemPromptOverride` already has.
   */
  prompt?: string
  /** How much of the variant survived into {@link prompt}. */
  applied: AgentVariantApplication
  /**
   * Fingerprint of the text the variant actually CONTRIBUTED, absent when it contributed none.
   *
   * This is what stops a re-worded variant from inheriting the verification its previous wording
   * earned — the same hazard the workspace revision suffix (`wN`) exists for, which a bare id
   * cannot express because re-registering an id is a supported way to re-word a variant. It
   * fingerprints the CONTRIBUTION rather than the definition so the key describes the text that
   * ran: a variant whose replacement was displaced is keyed by the addition that survived, and
   * one that contributed nothing does not enter the key at all.
   */
  fingerprint?: string
}

/**
 * The effective system-prompt override for one dispatch: the variant's replacement (unless a
 * workspace override already replaced the track prompt — the narrower tier wins, as it does for
 * every other per-dispatch knob) plus the variant's addition folded onto whichever base survived.
 *
 * `shipped` is passed in rather than resolved here because the caller (the engine) is the one
 * place that knows the kind actually being dispatched; see `shippedBasePromptFor`, which is what
 * it resolves it with.
 *
 * Called with NO variant (an ordinary step, varied or not by the workspace alone) this is just
 * the workspace override passed through, and `applied` is vacuously `full` — there is nothing to
 * lose. Only a caller that named a variant id reads it.
 */
export function applyAgentVariant(
  shipped: string,
  variant: AgentKindVariantDefinition | undefined,
  workspaceOverride?: string,
): AppliedAgentVariant {
  const replacement = variant?.systemPrompt
  const replaced = workspaceOverride ?? replacement
  const addition = variant?.promptAddition?.trim()
  const displaced = Boolean(replacement) && workspaceOverride !== undefined
  if (!addition) {
    return {
      ...(replaced === undefined ? {} : { prompt: replaced }),
      applied: displaced ? 'superseded' : 'full',
      ...(displaced || !replacement ? {} : { fingerprint: contentHash(replacement) }),
    }
  }
  return {
    prompt: `${replaced ?? shipped}\n\n${addition}`,
    applied: displaced ? 'addition-only' : 'full',
    // The contribution, which is the addition alone once a workspace override displaced the
    // replacement — see {@link AppliedAgentVariant.fingerprint}.
    fingerprint: contentHash(
      displaced || !replacement ? addition : `${replacement}\n\n${addition}`,
    ),
  }
}
