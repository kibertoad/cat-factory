import {
  createMergePresetContract,
  createModelPresetContract,
  deleteMergePresetContract,
  deleteModelPresetContract,
  listMergePresetsContract,
  listModelPresetsContract,
  updateMergePresetContract,
  updateModelPresetContract,
} from '@cat-factory/contracts'
import type { UpdateMergePresetInput } from '~/types/merge'
import type { CreateModelPresetInput, UpdateModelPresetInput } from '~/types/model-presets'
import type { SendParams } from './client'
import type { ApiContext } from './context'

// The merge-preset create body is typed from the contract's INPUT shape so the
// valibot-defaulted fields (release/grace windows, isDefault) stay optional for callers
// (the exported `CreateMergePresetInput` is the post-default OUTPUT shape).
type CreateMergePresetBody = NonNullable<SendParams<typeof createMergePresetContract>['body']>

/** The per-workspace preset libraries: merge-threshold policy + model->agent mapping. */
export function presetsApi({ send, ws }: ApiContext) {
  return {
    // ---- merge threshold presets (per-task auto-merge policy library) -----
    listMergePresets: (workspaceId: string) =>
      send(listMergePresetsContract, { pathPrefix: ws(workspaceId) }),

    createMergePreset: (workspaceId: string, body: CreateMergePresetBody) =>
      send(createMergePresetContract, { pathPrefix: ws(workspaceId), body }),

    updateMergePreset: (workspaceId: string, presetId: string, body: UpdateMergePresetInput) =>
      send(updateMergePresetContract, {
        pathPrefix: ws(workspaceId),
        pathParams: { presetId },
        body,
      }),

    deleteMergePreset: (workspaceId: string, presetId: string) =>
      send(deleteMergePresetContract, { pathPrefix: ws(workspaceId), pathParams: { presetId } }),

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
  }
}
