import {
  cloneRiskPolicyContract,
  createRiskPolicyContract,
  listRiskPolicySuppressionsContract,
  restoreRiskPolicyContract,
  suppressRiskPolicyContract,
  listMergeClassRollupsContract,
  tagMergeReviewEffortContract,
  createConsensusGroupContract,
  deleteConsensusGroupContract,
  listConsensusGroupsContract,
  updateConsensusGroupContract,
  createModelPresetContract,
  deleteRiskPolicyContract,
  deleteModelPresetContract,
  listRiskPoliciesContract,
  listModelPresetsContract,
  reseedRiskPolicyContract,
  reseedModelPresetContract,
  updateRiskPolicyContract,
  updateModelPresetContract,
} from '@cat-factory/contracts'
import type { ReviewEffort, RiskPolicyTier, UpdateRiskPolicyInput } from '~/types/merge'
import type { CreateModelPresetInput, UpdateModelPresetInput } from '~/types/model-presets'
import type { CreateConsensusGroupInput, UpdateConsensusGroupInput } from '~/types/consensus'
import type { SendParams } from './client'
import type { ApiContext } from './context'

// The merge-preset create body is typed from the contract's INPUT shape so the
// valibot-defaulted fields (release/grace windows, isDefault) stay optional for callers
// (the exported `CreateRiskPolicyInput` is the post-default OUTPUT shape).
type CreateRiskPolicyBody = NonNullable<SendParams<typeof createRiskPolicyContract>['body']>

/** The per-workspace preset libraries: merge-threshold policy + model->agent mapping. */
export function presetsApi({ send, ws, scope }: ApiContext) {
  return {
    // ---- risk policies (per-task auto-merge policy library) ---------------
    // The four CRUD calls are TIER-scoped (`account` or `workspace`, ADR 0055): the same routes are
    // mounted under both prefixes, so one method serves either library and the caller states which
    // one it is managing. The workspace read answers the MERGED library (its own rows plus the
    // account policies it inherits, each tagged with its tier).
    listRiskPolicies: (kind: RiskPolicyTier, id: string) =>
      send(listRiskPoliciesContract, { pathPrefix: scope(kind, id) }),

    createRiskPolicy: (kind: RiskPolicyTier, id: string, body: CreateRiskPolicyBody) =>
      send(createRiskPolicyContract, { pathPrefix: scope(kind, id), body }),

    updateRiskPolicy: (
      kind: RiskPolicyTier,
      id: string,
      presetId: string,
      body: UpdateRiskPolicyInput,
    ) =>
      send(updateRiskPolicyContract, {
        pathPrefix: scope(kind, id),
        pathParams: { presetId },
        body,
      }),

    deleteRiskPolicy: (kind: RiskPolicyTier, id: string, presetId: string) =>
      send(deleteRiskPolicyContract, { pathPrefix: scope(kind, id), pathParams: { presetId } }),

    // Restore a built-in preset to its current catalog definition (adopt an update, repair a
    // drifted one, or materialise a new built-in that appeared). Custom presets reject this.
    // Workspace-only: the built-in catalog is copied into BOARDS, so only a board has one to restore.
    reseedRiskPolicy: (workspaceId: string, presetId: string) =>
      send(reseedRiskPolicyContract, { pathPrefix: ws(workspaceId), pathParams: { presetId } }),

    // ---- inheritance (workspace only) -------------------------------------
    // Copy an inherited account policy into the board's own tier, under a fresh id, so the board can
    // edit its numbers. `name` is optional; the SPA sends the localized "copy" label.
    cloneRiskPolicy: (workspaceId: string, presetId: string, body: { name?: string }) =>
      send(cloneRiskPolicyContract, {
        pathPrefix: ws(workspaceId),
        pathParams: { presetId },
        body,
      }),

    // Hide an inherited account policy from this board, and the inverse. Deliberately NOT the delete
    // above: that removes a row the board owns, this withholds one it does not and is reversible.
    suppressRiskPolicy: (workspaceId: string, presetId: string) =>
      send(suppressRiskPolicyContract, { pathPrefix: ws(workspaceId), pathParams: { presetId } }),

    restoreRiskPolicy: (workspaceId: string, presetId: string) =>
      send(restoreRiskPolicyContract, { pathPrefix: ws(workspaceId), pathParams: { presetId } }),

    // What the board is hiding. Its own read because a hidden policy is by construction absent from
    // the list above, so without it the editor could offer no way back.
    listRiskPolicySuppressions: (workspaceId: string) =>
      send(listRiskPolicySuppressionsContract, { pathPrefix: ws(workspaceId) }),

    // ---- merge track record (the per-class evidence behind the policy) -----
    // Every class in ONE request (a single SQL aggregate server-side), so the preset editor can
    // show each class's rule next to the numbers that justify widening it without fanning out.
    listMergeClassRollups: (workspaceId: string) =>
      send(listMergeClassRollupsContract, { pathPrefix: ws(workspaceId) }),

    // Tag (or clear) how much review a merged PR actually needed.
    tagMergeReviewEffort: (
      workspaceId: string,
      recordId: string,
      reviewEffort: ReviewEffort | null,
    ) =>
      send(tagMergeReviewEffortContract, {
        pathPrefix: ws(workspaceId),
        pathParams: { recordId },
        body: { reviewEffort },
      }),

    // ---- model presets (per-task model->agent mapping library) ------------
    listModelPresets: (workspaceId: string) =>
      send(listModelPresetsContract, { pathPrefix: ws(workspaceId) }),

    createModelPreset: (workspaceId: string, body: CreateModelPresetInput) =>
      send(createModelPresetContract, { pathPrefix: ws(workspaceId), body }),

    updateModelPreset: (workspaceId: string, presetId: string, body: UpdateModelPresetInput) =>
      send(updateModelPresetContract, {
        pathPrefix: ws(workspaceId),
        pathParams: { presetId },
        body,
      }),

    deleteModelPreset: (workspaceId: string, presetId: string) =>
      send(deleteModelPresetContract, { pathPrefix: ws(workspaceId), pathParams: { presetId } }),

    // Restore a built-in model preset to its current catalog definition (adopt an update, repair
    // a drifted one, or materialise a new built-in that appeared). Custom presets reject this.
    reseedModelPreset: (workspaceId: string, presetId: string) =>
      send(reseedModelPresetContract, { pathPrefix: ws(workspaceId), pathParams: { presetId } }),

    // ---- consensus groups (the estimate-gated review panels a step escalates to) ----
    listConsensusGroups: (workspaceId: string) =>
      send(listConsensusGroupsContract, { pathPrefix: ws(workspaceId) }),

    createConsensusGroup: (workspaceId: string, body: CreateConsensusGroupInput) =>
      send(createConsensusGroupContract, { pathPrefix: ws(workspaceId), body }),

    updateConsensusGroup: (workspaceId: string, groupId: string, body: UpdateConsensusGroupInput) =>
      send(updateConsensusGroupContract, {
        pathPrefix: ws(workspaceId),
        pathParams: { groupId },
        body,
      }),

    deleteConsensusGroup: (workspaceId: string, groupId: string) =>
      send(deleteConsensusGroupContract, { pathPrefix: ws(workspaceId), pathParams: { groupId } }),
  }
}
