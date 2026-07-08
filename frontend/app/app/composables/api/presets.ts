import {
  createRiskPolicyContract,
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
import type { UpdateRiskPolicyInput } from '~/types/merge'
import type { CreateModelPresetInput, UpdateModelPresetInput } from '~/types/model-presets'
import type { SendParams } from './client'
import type { ApiContext } from './context'

// The merge-preset create body is typed from the contract's INPUT shape so the
// valibot-defaulted fields (release/grace windows, isDefault) stay optional for callers
// (the exported `CreateRiskPolicyInput` is the post-default OUTPUT shape).
type CreateRiskPolicyBody = NonNullable<SendParams<typeof createRiskPolicyContract>['body']>

/** The per-workspace preset libraries: merge-threshold policy + model->agent mapping. */
export function presetsApi({ send, ws }: ApiContext) {
  return {
    // ---- merge threshold presets (per-task auto-merge policy library) -----
    listRiskPolicies: (workspaceId: string) =>
      send(listRiskPoliciesContract, { pathPrefix: ws(workspaceId) }),

    createRiskPolicy: (workspaceId: string, body: CreateRiskPolicyBody) =>
      send(createRiskPolicyContract, { pathPrefix: ws(workspaceId), body }),

    updateRiskPolicy: (workspaceId: string, presetId: string, body: UpdateRiskPolicyInput) =>
      send(updateRiskPolicyContract, {
        pathPrefix: ws(workspaceId),
        pathParams: { presetId },
        body,
      }),

    deleteRiskPolicy: (workspaceId: string, presetId: string) =>
      send(deleteRiskPolicyContract, { pathPrefix: ws(workspaceId), pathParams: { presetId } }),

    // Restore a built-in preset to its current catalog definition (adopt an update, repair a
    // drifted one, or materialise a new built-in that appeared). Custom presets reject this.
    reseedRiskPolicy: (workspaceId: string, presetId: string) =>
      send(reseedRiskPolicyContract, { pathPrefix: ws(workspaceId), pathParams: { presetId } }),

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
  }
}
