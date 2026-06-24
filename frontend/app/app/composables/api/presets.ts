import type {
  CreateMergePresetInput,
  MergeThresholdPreset,
  UpdateMergePresetInput,
} from '~/types/merge'
import type { ApiContext } from './context'

/** The per-workspace merge-threshold preset library (per-task auto-merge policy). */
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
  }
}
