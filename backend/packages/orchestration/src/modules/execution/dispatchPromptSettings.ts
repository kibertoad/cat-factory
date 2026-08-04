import type {
  AgentPromptRepository,
  Block,
  Logger,
  ModelFlavor,
  ModelPresetRepository,
  PipelineStep,
  WorkspaceAgentSettingsRepository,
} from '@cat-factory/kernel'
import type { AgentKindRegistry } from '@cat-factory/agents'
import { applyAgentVariant, shippedBasePromptFor } from '@cat-factory/agents'
import { resolvePresetProviderPreference } from '../modelPresets/ModelPresetService.js'

// The per-dispatch GENERATION settings one dispatch runs under: which system prompt, how much the
// agent may say, and which of a model's ROUTES it is preferred to run on. Extracted from
// `AgentContextBuilder` so it stays the context ASSEMBLER while this cohesive concern — the tiers of
// "what was this agent told to be, how much may it say, and where does it run", plus the two facts
// that must be PINNED on the step because they cannot be re-derived later — lives in one place.
//
// The family belongs together: each is resolved exactly ONCE per dispatch, by the engine rather than
// each executor, so the container, inline and consensus paths cannot disagree about what a step ran
// under. Each returns a SPREAD-READY slice rather than a nullable value, so the context literal stays
// a flat spread instead of gaining another conditional.
//
// They differ in instructive ways, which is why the precedence and the KEY are stated per resolver
// and never assumed. The output budget lets the STEP's own option win over the workspace's setting,
// while for prompt TEXT the workspace wins over the step's selected variant: a budget is a number
// someone retypes; a prompt is authored text, and a workspace that edited its own must not have that
// edit silently displaced by a pipeline option. And the first two are keyed on the EFFECTIVE
// dispatched kind — so a helper dispatched off another step (a gate's fixer, the fork proposer) gets
// what is configured for the kind actually running rather than the hosting step's — while the route
// order is keyed on the BLOCK, because a preset states one order for every step it covers.

/** The three settings one dispatch runs under, as a spread-ready slice of the run context. */
export interface DispatchPromptSettings {
  systemPromptOverride?: string
  maxOutputTokens?: number
  providerPreference?: readonly ModelFlavor[]
}

/**
 * Resolve all three at once, concurrently. The ENTRY POINT the context builder uses: they are one
 * family (each resolved exactly once per dispatch, by the engine rather than any executor), and
 * asking for them together is what keeps a new member from being added here and forgotten at the
 * call site. Each is documented on its own resolver below, because the precedence and the KEY
 * differ per setting.
 */
export async function resolveDispatchSettings(
  deps: DispatchPromptSettingsDeps,
  workspaceId: string,
  agentKind: string,
  step: PipelineStep,
  block: Block,
): Promise<DispatchPromptSettings> {
  const [prompt, budget, routes] = await Promise.all([
    resolveDispatchSystemPrompt(deps, workspaceId, agentKind, step),
    resolveDispatchMaxOutputTokens(deps, workspaceId, agentKind, step),
    resolveDispatchProviderPreference(deps, workspaceId, block),
  ])
  return { ...prompt, ...budget, ...routes }
}

/** The narrow slice of the builder's dependencies these resolvers need. */
export interface DispatchPromptSettingsDeps {
  agentKindRegistry: AgentKindRegistry
  /** The append-only per-workspace prompt log. Absent ⇒ the override feature is not wired. */
  agentPrompts?: AgentPromptRepository
  /** The per-workspace, per-kind generation settings. Absent ⇒ the feature is not wired. */
  agentSettings?: WorkspaceAgentSettingsRepository
  /** The workspace's model-preset library, read for the block's route order. */
  modelPresets?: ModelPresetRepository
  logger?: Logger
}

/**
 * The base system prompt this dispatch replaces the shipped one with, or undefined to run the
 * shipped one. Two tiers converge here — the deployment's registered agent-kind VARIANT for this
 * step and the WORKSPACE's edited prompt for the kind — because they are the same unit of text.
 *
 * The head revision's `text` is `null` when the workspace deliberately went BACK to the built-in —
 * a real state, distinct from never having edited the kind, which is why it is recorded rather than
 * deleted. Both resolve to "no override" here, so a revert keeps tracking the shipped prompt as the
 * product bumps it instead of pinning a stale copy.
 *
 * MUTATES the step to pin what it resolved (`promptRevision`, `promptVariant`), because neither can
 * be re-derived afterwards: the prompt log is append-only, so re-reading it at any later point — a
 * Kaizen grading, a debug read, a post-mortem — would answer about whatever landed since. The
 * VARIANT is pinned for a second reason: `stepOptions.agentVariantId` is what the pipeline ASKED
 * for, and a workspace override or a withdrawal can mean the variant's text never reached the
 * prompt, so only a pin taken HERE can answer what the step actually ran under.
 */
export async function resolveDispatchSystemPrompt(
  deps: DispatchPromptSettingsDeps,
  workspaceId: string,
  agentKind: string,
  step: PipelineStep,
): Promise<{ systemPromptOverride?: string }> {
  const head = await deps.agentPrompts?.head(workspaceId, agentKind)
  // Cleared, not left stale: a re-dispatch after the workspace reverted must not keep reporting
  // the revision the previous attempt ran under.
  step.promptRevision = head?.text ? head.revision : undefined
  // The variant applies only when the kind being dispatched IS the step's own — a helper dispatched
  // off this step (a gate's fixer, the fork proposer) is a different agent and must not inherit the
  // step's alternate prompt. Same rule as `followUpCompanion`.
  const variantId = agentKind === step.agentKind ? step.stepOptions?.agentVariantId : undefined
  const variant = variantId ? deps.agentKindRegistry.variant(variantId) : undefined
  // A variant the deployment has since withdrawn: the step runs the SHIPPED prompt, which is the
  // safe disposition, but it is not what the pipeline asked for — so say so rather than let a step
  // quietly stop being the variation someone configured.
  if (variantId && !variant) {
    deps.logger?.warn('Agent kind variant is not registered; running the shipped prompt', {
      agentKind,
      variantId,
    })
  }
  const { prompt, applied, fingerprint } = applyAgentVariant(
    // Only paid for when a variant is actually selected; the shipped prompt is what its addition
    // folds onto and what its replacement is measured against.
    variant ? shippedBasePromptFor(agentKind, deps.agentKindRegistry) : '',
    variant,
    head?.text ?? undefined,
  )
  // The workspace out-ranks the deployment on the same unit of text, so its edit DISPLACES a
  // variant's replacement. That is the intended precedence, but it is a silent loss of something a
  // deployment configured in code — the one disposition here with no other symptom — so it is
  // reported at the fold, exactly as a withdrawal is above.
  if (applied === 'superseded' || applied === 'addition-only') {
    deps.logger?.warn(
      "Workspace prompt override displaced the agent variant's own prompt for this dispatch",
      { agentKind, variantId, promptRevision: step.promptRevision, applied },
    )
  }
  // What the dispatch DID with the step's selected variant, so a later reader is never told a step
  // ran a variation whose text never reached it. Cleared, not left stale, for the same reason
  // `promptRevision` is: a re-dispatch resolves it afresh.
  step.promptVariant = variantId
    ? {
        id: variantId,
        applied: variant ? applied : 'withdrawn',
        ...(fingerprint ? { fingerprint } : {}),
      }
    : undefined
  return prompt ? { systemPromptOverride: prompt } : {}
}

/**
 * The output-token ceiling this dispatch runs under, or undefined to run the deployment routing
 * default.
 *
 * NARROWEST TIER WINS: the step's own `stepOptions.maxOutputTokens` beats the workspace's per-kind
 * setting, which beats the deployment routing ceiling. The step value is read WITHOUT touching the
 * repository, so a pipeline that pins its own budget costs no query.
 */
export async function resolveDispatchMaxOutputTokens(
  deps: DispatchPromptSettingsDeps,
  workspaceId: string,
  agentKind: string,
  step: PipelineStep,
): Promise<{ maxOutputTokens?: number }> {
  const fromStep = step.stepOptions?.maxOutputTokens
  if (fromStep != null) return { maxOutputTokens: fromStep }
  const configured = await deps.agentSettings?.get(workspaceId, agentKind)
  return configured?.maxOutputTokens != null ? { maxOutputTokens: configured.maxOutputTokens } : {}
}

/**
 * The order this dispatch prefers a model's ROUTES in, or undefined to walk the deployment's
 * default order.
 *
 * Read from the block's model preset (its selected one, else the workspace default), which is the
 * SAME row the block's model id comes from — so a preset cannot pick the model on one surface and
 * the route on another. Keyed on the BLOCK rather than the dispatched kind, unlike its two
 * siblings: a preset states one order for every step it covers, so a helper dispatched off another
 * step runs on the same routes as the step hosting it. Absent library ⇒ the default order,
 * unchanged.
 *
 * NOT pinned onto the step, again unlike the prompt revision: a preset row is mutable rather than
 * append-only, so a pin here would be a stale copy pretending to be evidence. What a step actually
 * ran on is already recorded per dispatch as the resolved model on its telemetry.
 */
export async function resolveDispatchProviderPreference(
  deps: DispatchPromptSettingsDeps,
  workspaceId: string,
  block: Block,
): Promise<{ providerPreference?: readonly ModelFlavor[] }> {
  if (!deps.modelPresets) return {}
  const preference = await resolvePresetProviderPreference(
    deps.modelPresets,
    workspaceId,
    block.modelPresetId,
  )
  return preference?.length ? { providerPreference: preference } : {}
}
