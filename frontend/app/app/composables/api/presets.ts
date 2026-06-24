import type {
  CreateMergePresetInput,
  MergeThresholdPreset,
  UpdateMergePresetInput,
} from '~/types/merge'
import type {
  CreateModelPresetInput,
  ModelPreset,
  UpdateModelPresetInput,
} from '~/types/model-presets'
import type { ApiContext } from './context'

/** The per-workspace preset libraries: merge-threshold policy + model->agent mapping. */
export function presetsApi({ http, ws }: ApiContext) {
  return {
    // ---- merge threshold presets (per-task auto-merge policy library) -----
    listMergePresets: (workspaceId: string) =>
      http<MergeThresholdPreset[]>(`${ws(workspaceId)}/merge-presets`),

    createMergePreset: (workspaceId: string, body: CreateMergePresetInput) =>
      http<MergeThresholdPreset>(`${ws(workspaceId)}/merge-presets`, { method: 'POST', body }),

    updateMergePreset: (workspaceId: string, presetId: string, body: UpdateMergePresetInput) =>
      http<MergeThresholdPreset>(
        `${ws(workspaceId)}/merge-presets/${encodeURIComponent(presetId)}`,
        { method: 'PATCH', body },
      ),

    deleteMergePreset: (workspaceId: string, presetId: string) =>
      http(`${ws(workspaceId)}/merge-presets/${encodeURIComponent(presetId)}`, {
        method: 'DELETE',
      }),

    // ---- model presets (per-task model->agent mapping library) ------------
    listModelPresets: (workspaceId: string) =>
      http<ModelPreset[]>(`${ws(workspaceId)}/model-presets`),

    createModelPreset: (workspaceId: string, body: CreateModelPresetInput) =>
      http<ModelPreset>(`${ws(workspaceId)}/model-presets`, { method: 'POST', body }),

    updateModelPreset: (workspaceId: string, presetId: string, body: UpdateModelPresetInput) =>
      http<ModelPreset>(`${ws(workspaceId)}/model-presets/${encodeURIComponent(presetId)}`, {
        method: 'PATCH',
        body,
      }),

    deleteModelPreset: (workspaceId: string, presetId: string) =>
      http(`${ws(workspaceId)}/model-presets/${encodeURIComponent(presetId)}`, {
        method: 'DELETE',
      }),
  }
}
