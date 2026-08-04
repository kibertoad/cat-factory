import type { ModelFlavor, ModelPresetRepository, ModelRef } from '@cat-factory/kernel'
import { inlineModelRef } from '@cat-factory/kernel'
import { resolvePresetProviderPreference } from './modules/modelPresets/ModelPresetService.js'

// The model half of what the INLINE LLM callers share, the sibling of `inlineScope.ts`'s scope half.
// The judge, the fork-decision chat, the iterative reviewers, the doc/initiative interviewers, the
// tester quality companion and the bug-hunt assessor all answer "which model does this inline call
// run on" with the SAME precedence the dispatch path uses — a block pin, else the workspace's
// per-kind preset default, else the routing default — and all degrade a container-only subscription
// ref to something an inline `generateText` can serve.
//
// It lived as seven byte-identical private `modelFor` methods until the per-preset ROUTE PREFERENCE
// needed to reach every one of them. Seven copies is seven places for the next such fact to be
// forgotten, and the symptom would be silent: an inline reviewer resolving the same model onto a
// different provider than the container step beside it, which is exactly what a compliance preset
// pinned to a residency-guaranteed route must never do.
//
// Deliberately NOT `resolveInlineModelRef` (`@cat-factory/agents`): these callers hold a block
// selection and a single fallback ref rather than an `AgentRouting`, and they run outside a dispatch,
// so they resolve the preference themselves instead of reading it off an `AgentRunContext`.

/** What an inline caller supplies to resolve its model. Every field mirrors its own deps. */
export interface InlineBlockModelDeps {
  /** Routing-default ref, used when nothing else resolves and as the inline degrade target. */
  modelRef?: ModelRef
  /** Resolve a model catalog id to a ref, under a route order (the deployment-aware resolver). */
  resolveBlockModel?: (
    modelId: string | undefined,
    providerPreference?: readonly ModelFlavor[],
  ) => ModelRef | undefined
  /** Keep an ambient-eligible harness ref inline (local mode) instead of degrading it. */
  runsInline?: (ref: ModelRef) => boolean
  /** Resolve the workspace's per-agent-kind default model id (consulted when nothing is pinned). */
  resolveWorkspaceModelDefault?: (
    workspaceId: string,
    agentKind: string,
    modelPresetId?: string,
  ) => Promise<string | undefined>
  /**
   * The workspace's model-preset library, read for the ROUTE order the selected preset states.
   * Absent ⇒ the deployment's default order, which is what these callers had before presets could
   * state one.
   */
  modelPresets?: ModelPresetRepository
}

/**
 * What the caller's subject pins. A `Block` satisfies this structurally; the bug-hunt assessor
 * (which rates a tracker board, not a task) passes an empty selection and so resolves under the
 * WORKSPACE DEFAULT preset — the honest reading of "nothing selected a preset".
 */
export interface InlineModelSelection {
  /** The model catalog id pinned on the subject, if any. */
  modelId?: string
  /** The model preset selected on the subject, if any (absent ⇒ the workspace default preset). */
  modelPresetId?: string
}

/**
 * The ref an inline call runs, for `agentKind`: the subject's pinned model, else the workspace's
 * per-kind default under the subject's preset, else the routing default. A resolved container-only
 * subscription ref (`claude-code` / `codex`) is degraded to the routing default unless this
 * deployment can drive the harness inline, so a task pinned to a subscription model for its
 * container steps still runs its inline steps.
 *
 * The preset in force supplies the route ORDER for both id resolutions, so a preset that prefers a
 * residency-guaranteed route gets it here as well as at dispatch. Resolved once per call rather than
 * threaded in, because an inline caller has no `AgentRunContext` to carry it.
 *
 * Returns undefined only when nothing resolved AND no routing default is wired — the caller's cue
 * that no model is configured for the feature.
 */
export async function resolveInlineBlockModelRef(
  deps: InlineBlockModelDeps,
  workspaceId: string,
  agentKind: string,
  selection: InlineModelSelection,
): Promise<ModelRef | undefined> {
  const fallback = deps.modelRef
  const runsInline = deps.runsInline
  const degrade = (ref: ModelRef): ModelRef =>
    inlineModelRef(ref, fallback ?? ref, runsInline ? { runsInline } : {})
  const preference = deps.modelPresets
    ? await resolvePresetProviderPreference(deps.modelPresets, workspaceId, selection.modelPresetId)
    : undefined
  const fromBlock = deps.resolveBlockModel?.(selection.modelId, preference)
  if (fromBlock) return degrade(fromBlock)
  const defaultId = await deps.resolveWorkspaceModelDefault?.(
    workspaceId,
    agentKind,
    selection.modelPresetId,
  )
  const fromDefault = deps.resolveBlockModel?.(defaultId, preference)
  if (fromDefault) return degrade(fromDefault)
  return fallback
}
