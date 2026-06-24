import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { PutTrackerSettingsInput, TrackerSettings } from '~/types/tracker'
import { useWorkspaceStore } from '~/stores/workspace'

/**
 * The workspace's issue-tracker selection (GitHub Issues or Jira) — where the
 * tech-debt recurring pipeline files its ticket. Hydrated from the snapshot;
 * edited inline when configuring a tech-debt recurring pipeline.
 */
export const useTrackerStore = defineStore('tracker', () => {
  const api = useApi()

  const settings = ref<TrackerSettings>({
    tracker: null,
    jiraProjectKey: null,
    writebackCommentOnPrOpen: false,
    writebackResolveOnMerge: false,
    updatedAt: 0,
  })

  function hydrate(value: TrackerSettings | undefined) {
    settings.value = value ?? {
      tracker: null,
      jiraProjectKey: null,
      writebackCommentOnPrOpen: false,
      writebackResolveOnMerge: false,
      updatedAt: 0,
    }
  }

  async function save(input: PutTrackerSettingsInput) {
    const ws = useWorkspaceStore()
    settings.value = await api.putTrackerSettings(ws.requireId(), input)
    return settings.value
  }

  return { settings, hydrate, save }
})
