<script setup lang="ts">
// Workspace settings: issue-tracker writeback. Two independent toggles that govern
// whether the engine writes back to a task's linked tracker issue(s) as its PR
// progresses — comment when the PR opens, and comment + close as resolved when it
// merges. Each is overridable per task in the inspector. Persisted on the workspace
// tracker settings (the selection + Jira project key are preserved on save).
import { onMounted, ref, watch } from 'vue'

const tracker = useTrackerStore()
const toast = useToast()

const commentOnPrOpen = ref(false)
const resolveOnMerge = ref(false)
const saving = ref(false)

// Sync the local toggles from the store on mount (the tab renders when Workspace
// settings opens) and whenever the stored settings change underneath.
function hydrate() {
  commentOnPrOpen.value = tracker.settings.writebackCommentOnPrOpen
  resolveOnMerge.value = tracker.settings.writebackResolveOnMerge
}
onMounted(hydrate)
watch(() => tracker.settings, hydrate, { deep: true })

async function save() {
  saving.value = true
  try {
    // Preserve the tracker selection + Jira project key; only the writeback flags change.
    await tracker.save({
      tracker: tracker.settings.tracker,
      jiraProjectKey: tracker.settings.jiraProjectKey,
      writebackCommentOnPrOpen: commentOnPrOpen.value,
      writebackResolveOnMerge: resolveOnMerge.value,
    })
    toast.add({ title: 'Writeback settings saved', icon: 'i-lucide-check', color: 'success' })
  } catch (e) {
    toast.add({
      title: 'Could not save settings',
      description: e instanceof Error ? e.message : String(e),
      icon: 'i-lucide-triangle-alert',
      color: 'error',
    })
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div class="space-y-4">
    <p class="text-xs text-slate-400">
      When a task is linked to a tracker issue (GitHub Issues or Jira), write back to it as the
      task's pull request progresses. Each toggle is the workspace default and can be overridden per
      task in the inspector. GitHub issues close natively; Jira issues transition to the first
      status in their <span class="text-slate-300">Done</span> category.
    </p>

    <label class="flex items-start gap-3 rounded-lg border border-slate-700 bg-slate-800/40 p-3">
      <USwitch v-model="commentOnPrOpen" />
      <span class="text-sm">
        <span class="block text-slate-200">Comment when a PR opens</span>
        <span class="block text-xs text-slate-500">
          Post a comment on the linked issue with the new pull request's link.
        </span>
      </span>
    </label>

    <label class="flex items-start gap-3 rounded-lg border border-slate-700 bg-slate-800/40 p-3">
      <USwitch v-model="resolveOnMerge" />
      <span class="text-sm">
        <span class="block text-slate-200">Close as resolved when a PR merges</span>
        <span class="block text-xs text-slate-500">
          Comment that the PR merged, then close / resolve the linked issue.
        </span>
      </span>
    </label>

    <div class="flex justify-end">
      <UButton
        color="primary"
        variant="soft"
        size="sm"
        icon="i-lucide-save"
        :loading="saving"
        @click="save"
      >
        Save
      </UButton>
    </div>
  </div>
</template>
